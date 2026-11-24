import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  checkWorkflow,
  dryRun,
  fileSchedules,
  gcRuns,
  listRecords,
  loadRecord,
  logFile,
  rememberProject,
  resumeRun,
  runQuestions,
  saveSchedules,
  startRun,
  stopStep,
  type HomePaths,
} from "@sous/engine";
import {
  createRun,
  fakeRunner,
  inProcess,
  knownProjects,
  plantState,
  readState,
  requestStepStop,
  saveRecord,
  stopRequestFile,
  testHome,
  tick,
  writeAnswer,
  WorkflowError,
  WorkflowErrorCode,
  type Call,
} from "@sous/engine/testing";
import { main } from "../src/cli.js";
import { sous, waitFor } from "./sous.js";
import { git } from "./helpers/git.js";

// Whole runs in this process, with a fake agent runner, the way `sous run` drives them.


function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

async function answerWhenAsked(paths: HomePaths, runId: string, reply: (prompt: string) => unknown, times = 1): Promise<string[]> {
  const asked: string[] = [];
  for (let waited = 0; asked.length < times && waited < 15_000; waited += 20) {
    const open = runQuestions(paths, runId);
    if (open.length) {
      const question = open[0]!;
      asked.push(question.prompt);
      writeAnswer(paths, question, reply(question.prompt));
      while (runQuestions(paths, runId).some((q) => q.id === question.id)) await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return asked;
}

const quiet = () => {};

const commit = (cwd: string, ...args: string[]) => git(cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args);

describe("runs", () => {
  it("an agent asks a question, the answer comes through the inbox, and the same session goes on", async () => {
    const { paths, projectDir } = testHome({
      asking: `export const meta = { name: 'asking', description: 'asks', inputs: { task: 'What to do' } }
const out = await agent('Do ' + args.task, { label: 'worker', ask: true })
return out`,
    });
    const { runner, calls } = fakeRunner((call) => (call.label === "worker" ? "QUESTION: Postgres or SQLite?" : `built with ${/answered: (\w+)/.exec(call.prompt)?.[1]}`));
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "asking", projectDir, inputs: { task: "the store" } });
    const running = workers.ended(record.runId);
    const asked = await answerWhenAsked(paths, record.runId, () => "SQLite");
    const result = await running;
    assert.equal(result?.status, "completed");
    assert.equal(result?.result, "built with SQLite");
    assert.match(asked[0]!, /worker asks: Postgres or SQLite\?/);
    assert.equal((calls[1]!.options.continueFromSession as { sessionId: string }).sessionId, "s1");
    assert.equal(loadRecord(paths, record.runId)?.pid, undefined, "the record forgets the worker once it ends");
  });

  it("a breakpoint sent back with a note runs the step again with that note, then approve goes on", async () => {
    const { paths, projectDir } = testHome({
      checked: `export const meta = { name: 'checked', description: 'a breakpoint' }
const draft = await breakpoint('Check the plan', (note) => agent('Plan it' + (note ? '. Change: ' + note : ''), { label: 'planner' }))
return draft`,
    });
    const { runner, calls } = fakeRunner((call) => (call.prompt.includes("Change: shorter") ? "short plan" : "long plan"));
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "checked", projectDir, inputs: {} });
    const running = workers.ended(record.runId);
    const replies = [{ decision: "send back", note: "shorter" }, "approve"];
    const asked = await answerWhenAsked(paths, record.runId, () => replies.shift(), 2);
    const result = await running;
    assert.equal(result?.status, "completed");
    assert.equal(result?.result, "short plan");
    assert.equal(calls.length, 2);
    assert.match(asked[0]!, /^Breakpoint: Check the plan\n\nlong plan/);
    assert.match(asked[1]!, /short plan/);
  });

  it("a question whose text starts like a breakpoint's is a plain question, which send-back refuses", async () => {
    const { paths, projectDir } = testHome({
      lookalike: `export const meta = { name: 'lookalike', description: 'asks' }
return await ask('Breakpoint: not one')`,
    });
    const { runner } = fakeRunner(() => "unused");
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "lookalike", projectDir, inputs: {} });
    const running = workers.ended(record.runId);
    await waitFor(() => runQuestions(paths, record.runId).length > 0, "the question");
    const id = runQuestions(paths, record.runId)[0]!.id;
    const inbox = await sous(paths, ["inbox", "--json"]);
    const sendBack = await sous(paths, ["send-back", id, "shorter"]);
    const answer = await sous(paths, ["answer", id, "fine"]);
    const result = await running;
    assert.deepEqual(
      (JSON.parse(inbox.out) as Array<{ prompt: string; breakpoint: boolean }>).map((q) => [q.prompt, q.breakpoint]),
      [["Breakpoint: not one", false]],
    );
    assert.equal(sendBack.code, 64, sendBack.out);
    assert.match(sendBack.out, new RegExp(`${id} is not a breakpoint`));
    assert.equal(answer.code, 0, answer.out);
    assert.equal(result?.status, "completed");
    assert.equal(result?.result, "fine");
  });

  it("a step that keeps failing pauses the run on it, and resume runs it again while finished steps stay done", async () => {
    const { paths, projectDir } = testHome(
      {
        flaky: `export const meta = { name: 'flaky', description: 'a step that fails' }
const first = await agent('first', { label: 'first' })
const second = await agent('second', { label: 'second' })
return { first, second }`,
      },
      { retries: 1 },
    );
    let broken = true;
    const { runner, calls } = fakeRunner((call) => {
      if (call.label === "second" && broken) throw new WorkflowError("the tests fail", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
      return `${call.label} done`;
    });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "flaky", projectDir, inputs: {} });
    const paused = await workers.ended(record.runId);
    assert.equal(paused?.status, "paused");
    const state = readState(paths, record.runId);
    assert.equal(state?.pauseReason, "step_failed");
    assert.match(String(state?.reason), /step "second" failed after 2 tries: .*the tests fail/);
    assert.deepEqual(calls.map((c) => c.label), ["first", "second", "second"]);

    broken = false;
    resumeRun(paths, workers.launch, record.runId);
    const resumed = await workers.ended(record.runId);
    assert.equal(resumed?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(resumed?.result)), { first: "first done", second: "second done" });
    assert.deepEqual(calls.slice(3).map((c) => c.label), ["second"], "first is not run again");
  });

  it("a run paused for a lost login pauses again while the login is gone, says why, and resumes once the person logs in again", async () => {
    const { paths, projectDir } = testHome({
      login: `export const meta = { name: 'login', description: 'loses its login' }
const first = await agent('first', { label: 'first' })
const second = await agent('second', { label: 'second' })
return { first, second }`,
    });
    let loggedIn = false;
    const { runner, calls } = fakeRunner((call) => {
      if (call.label === "second" && !loggedIn) {
        throw new WorkflowError("Claude Code is not logged in.", WorkflowErrorCode.AUTH_REQUIRED, { recoverable: false, agentLabel: "second", authContext: { backendId: "claude", methods: [] } });
      }
      return `${call.label} done`;
    });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "login", projectDir, inputs: {} });
    await workers.ended(record.runId);
    assert.equal(readState(paths, record.runId)?.pauseReason, "auth_required");
    assert.deepEqual(calls.map((c) => c.label), ["first", "second"]);

    const lines: string[] = [];
    const watched = inProcess({ inner: runner, log: (line) => lines.push(line) });
    resumeRun(paths, watched.launch, record.runId);
    await watched.ended(record.runId);
    assert.deepEqual(calls.map((c) => c.label), ["first", "second", "second"], "the step tries again, and first is not run again");
    assert.equal(readState(paths, record.runId)?.pauseReason, "auth_required");
    assert.match(lines.at(-1)!, /paused +login \(auth_required\): .*not logged in/, "the log says why the run paused again");

    loggedIn = true;
    resumeRun(paths, workers.launch, record.runId);
    const done = await workers.ended(record.runId);
    assert.equal(done?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), { first: "first done", second: "second done" });
    assert.deepEqual(calls.map((c) => c.label), ["first", "second", "second", "second"], "first is not run again");
  });

  it("a run keeps the workflows it started with, and resume asks before it takes an edit", async () => {
    const childFile = (projectDir: string) => join(projectDir, ".sous", "workflows", "child.js");
    const child = (version: string) => `export const meta = { name: 'child', description: 'child' }\nreturn await agent('${version}', { label: 'build' })`;
    const { paths, projectDir } = testHome(
      {
        child: child("v1"),
        parent: `export const meta = { name: 'parent', description: 'parent' }\nawait agent('look', { label: 'look' })\nreturn await workflow('child', {})`,
      },
      { retries: 1 },
    );
    let broken = true;
    const { runner, calls } = fakeRunner((call) => {
      // Someone edits the child while the run goes on.
      if (call.label === "look") writeFileSync(childFile(projectDir), child("v2"));
      if (call.label === "build" && broken) throw new WorkflowError("the tests fail", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
      return `${call.prompt} done`;
    });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "parent", projectDir, inputs: {} });
    assert.equal((await workers.ended(record.runId))?.status, "paused");
    assert.deepEqual(calls.filter((c) => c.label === "build").map((c) => c.prompt), ["v1", "v1"], "the edit did not reach the run");

    const asks = await sous(paths, ["resume", record.runId], { launch: workers.launch });
    assert.equal(asks.code, 1);
    assert.match(asks.out, /child changed since .*--latest takes the new version.*--same goes on with the version it started with/);
    assert.equal(workers.launched.length, 1, "a resume that asks starts no worker");

    assert.equal((await sous(paths, ["resume", record.runId, "--same"], { launch: workers.launch })).code, 0);
    await workers.ended(record.runId);
    assert.equal(readState(paths, record.runId)?.status, "paused");
    assert.equal(calls.at(-1)?.prompt, "v1", "--same keeps the run's version");

    broken = false;
    assert.equal((await sous(paths, ["resume", record.runId, "--latest"], { launch: workers.launch })).code, 0);
    const done = await workers.ended(record.runId);
    assert.equal(done?.result, "v2 done");
    assert.equal(loadRecord(paths, record.runId)?.resumeLatest, undefined);
    assert.equal(calls.filter((c) => c.label === "look").length, 1, "the finished step is not run again");
  });

  it("stopping a step by its name stops only that step, not a nested step with the same label", async () => {
    const { paths, projectDir } = testHome({
      child: `export const meta = { name: 'child', description: 'child' }\nreturn await agent('build nested', { label: 'build' })`,
      parent: `export const meta = { name: 'parent', description: 'parent' }
const [top, nested] = await parallel([() => agent('build top', { label: 'build' }), () => workflow('child', {}, { label: 'ticket A' })])
return { top, nested }`,
    });
    let hang = true;
    const stopped: string[] = [];
    const finish: Array<() => void> = [];
    const { runner, calls } = fakeRunner((call) =>
      hang
        ? new Promise((resolve, reject) => {
            finish.push(() => resolve(`${call.prompt} done`));
            const signal = call.options.signal as AbortSignal | undefined;
            signal?.addEventListener("abort", () => (stopped.push(call.prompt), reject(new Error("aborted"))));
          })
        : `${call.prompt} done`,
    );
    const workers = inProcess({ inner: runner, handleSignals: true });
    const record = startRun(paths, workers.launch, { workflow: "parent", projectDir, inputs: {} });
    const file = logFile(paths, record.runId);
    const running = workers.ended(record.runId);
    await waitFor(() => calls.length === 2);

    assert.equal(stopStep(paths, record.runId, "build"), true);
    // The worker logs "stopping build" once it has aborted every step the request names.
    await waitFor(() => readFileSync(file, "utf8").includes("stopping   build\n"));
    assert.deepEqual(stopped, ["build top"], "the nested step named \"ticket A: build\" goes on");

    hang = false;
    for (const done of finish) done();
    await running;
    const state = readState(paths, record.runId);
    assert.equal(state?.status, "paused");
    assert.equal(state?.pauseReason, "step_stopped");

    resumeRun(paths, workers.launch, record.runId);
    const done = await workers.ended(record.runId);
    assert.equal(done?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), { top: "build top done", nested: "build nested done" });
    assert.deepEqual(calls.map((c) => c.prompt), ["build top", "build nested", "build top"], "only the stopped step runs again");
  });

  it("a step stop survives the worker saving a record it read before the request", async () => {
    const { paths, projectDir } = testHome({
      one: `export const meta = { name: 'one', description: 'one' }\nreturn await agent('build it', { label: 'build' })`,
    });
    const { runner, calls } = fakeRunner((call) =>
      new Promise((_, reject) => (call.options.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const workers = inProcess({ inner: runner, handleSignals: true });
    const record = startRun(paths, workers.launch, { workflow: "one", projectDir, inputs: {} });
    const file = logFile(paths, record.runId);
    const running = workers.ended(record.runId);
    await waitFor(() => calls.some((c) => c.label === "build"), "the step to start");

    // The worker writes the record while it runs, for a nested run or a step's worktree. Here it
    // saves one it read just before `sous stop --step`, in the same tick, before the signal lands.
    const before = loadRecord(paths, record.runId)!;
    assert.equal(stopStep(paths, record.runId, "build"), true);
    saveRecord(paths, before);

    const ended = await Promise.race([running.then(() => "ended"), new Promise((r) => setTimeout(() => r("waiting"), 3000))]);
    if (ended === "waiting") {
      process.kill(process.pid, "SIGTERM");
      await running;
      assert.fail("the step was not stopped");
    }
    assert.equal(readState(paths, record.runId)?.pauseReason, "step_stopped");
    assert.match(readFileSync(file, "utf8"), /stopping   build/);
  });

  it("a step stop left by a worker that ended is dropped when the next worker starts", async () => {
    const { paths, projectDir } = testHome({
      one: `export const meta = { name: 'one', description: 'one' }\nreturn await agent('build it', { label: 'build' })`,
    });
    const { runner, calls } = fakeRunner((call) =>
      new Promise((_, reject) => (call.options.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    // The request is left before the worker starts, so the test makes the record and starts the
    // worker itself, as startRun does.
    const record = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    requestStepStop(paths, record.runId, { step: "build", calls: [{ scope: record.runId, label: "build" }] });
    const file = logFile(paths, record.runId);
    const workers = inProcess({ inner: runner, handleSignals: true });
    workers.launch(paths, record.runId, "start");
    const running = workers.ended(record.runId);
    await waitFor(() => calls.some((c) => c.label === "build"));

    // The worker's SIGUSR2 handler is on the process before this one, so it has run when this one does.
    const handled = new Promise<void>((resolve) => process.once("SIGUSR2", () => resolve()));
    process.kill(process.pid, "SIGUSR2");
    await handled;
    assert.doesNotMatch(readFileSync(file, "utf8"), /stopping|no step/);
    assert.equal(stopStep(paths, record.runId, "build"), true);
    await running;
    assert.equal(readState(paths, record.runId)?.pauseReason, "step_stopped");
  });

  it("a workflow's time limit stops the running steps and pauses the run, and resume runs them again", async () => {
    const { paths, projectDir } = testHome({
      slow: `export const meta = { name: 'slow', description: 'slow', timeout: '200ms' }
const first = await agent('first', { label: 'first' })
const second = await agent('second', { label: 'second' })
return { first, second }`,
      vague: `export const meta = { name: 'vague', description: 'vague', timeout: 'soon' }\nreturn 1`,
    });
    assert.throws(() => createRun(paths, { workflow: "vague", projectDir, inputs: {} }), /meta.timeout must be a time such as "90s", "10m" or "2h", got "soon"/);

    let hang = true;
    const { runner, calls } = fakeRunner((call) => (call.label === "second" && hang ? new Promise(() => {}) : `${call.label} done`));
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "slow", projectDir, inputs: {} });
    assert.equal(record.timeout, "200ms");
    await workers.ended(record.runId);
    const state = readState(paths, record.runId);
    assert.equal(state?.status, "paused");
    assert.equal(state?.pauseReason, "time_limit");
    assert.match(String(state?.reason), /step "second" was stopped: the workflow's time limit of 200ms was reached/);

    hang = false;
    resumeRun(paths, workers.launch, record.runId);
    const done = await workers.ended(record.runId);
    assert.equal(done?.status, "completed");
    assert.deepEqual(calls.map((c) => c.label), ["first", "second", "second"]);
  });

  it("a step's time limit counts from when it starts running, not while it waits for a free slot", async () => {
    const { paths, projectDir } = testHome(
      {
        queue: `export const meta = { name: 'queue', description: 'two steps share one slot' }
return await parallel([
  () => agent('a', { label: 'a' }),
  () => agent('b', { label: 'b', timeout: '200ms' }),
])`,
      },
      { maxAgents: 1 },
    );
    // Step a holds the slot for 400ms. Step b waits that long for it, twice its limit, and then
    // runs at once. Counted from the wait, b would be stopped at 200ms, before a lets go.
    // A runner that sees its signal already aborted ends the step, as the harnesses' runners do.
    const { runner, calls } = fakeRunner((call) => {
      if (call.label === "a") return new Promise((resolve) => setTimeout(() => resolve("a done"), 400));
      (call.options.signal as AbortSignal | undefined)?.throwIfAborted();
      return "b done";
    });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "queue", projectDir, inputs: {} });
    const done = await workers.ended(record.runId);
    assert.equal(done?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), ["a done", "b done"]);
    assert.deepEqual(calls.map((call) => call.label), ["a", "b"], "a held the slot first, and each step ran once");
  });

  it("per-run step changes and a default model reach the agent", async () => {
    const { paths, projectDir } = testHome({
      changes: `export const meta = { name: 'changes', description: 'step changes' }
return await agent('review', { label: 'reviewer' })`,
    });
    const { runner, calls } = fakeRunner(() => "ok");
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "changes", projectDir, inputs: {}, overrides: { reviewer: { model: "claude/opus" } } });
    await workers.ended(record.runId);
    assert.equal(calls[0]!.options.model, "claude/opus");
    // Each step keeps its own start and end time.
    const step = readState(paths, record.runId)!.agents[0]!;
    assert.ok(step.startedAt && step.endedAt && step.endedAt >= step.startedAt);
  });

  it("per-run step changes reach the agent that choose() asks", async () => {
    const { paths, projectDir } = testHome({
      picking: `export const meta = { name: 'picking', description: 'picks a step' }
return await choose('Pick one', { label: 'picker', steps: { a: () => 'A', b: () => 'B' } })`,
    });
    const { runner, calls } = fakeRunner(() => ({ choice: "b", reason: "b fits" }));
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "picking", projectDir, inputs: {}, overrides: { picker: { model: "claude/opus" } } });
    const done = await workers.ended(record.runId);
    assert.equal(calls[0]!.options.model, "claude/opus");
    assert.equal((done?.result as { result?: unknown } | undefined)?.result, "B");
  });

  it("show lists the step that runs now, before the run saves it", async () => {
    const { paths, projectDir } = testHome({
      slow: `export const meta = { name: 'slow', description: 'slow' }
await agent('first', { label: 'first' })
return await agent('second', { label: 'second' })`,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let secondStarted!: () => void;
    const started = new Promise<void>((resolve) => (secondStarted = resolve));
    const { runner } = fakeRunner(async (call) => {
      if (call.label === "second") {
        secondStarted();
        await held;
      }
      return "ok";
    });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "slow", projectDir, inputs: {} });
    const running = workers.ended(record.runId);
    await started;
    const before = process.env.SOUS_HOME;
    process.env.SOUS_HOME = paths.home;
    const printed: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      assert.equal(await main(["show", record.runId, "--json"]), 0);
    } finally {
      process.stdout.write = write;
      if (before === undefined) delete process.env.SOUS_HOME;
      else process.env.SOUS_HOME = before;
      release();
    }
    await running;
    const shown = JSON.parse(printed.join("")) as { state: { agents: { label: string; status: string }[] } };
    assert.deepEqual(shown.state.agents.map((a) => [a.label, a.status]), [["first", "done"], ["second", "running"]]);
  });

  it("a code step in a scratch folder finds the project through SOUS_PROJECT", async () => {
    const { paths, projectDir } = testHome({
      where: `export const meta = { name: 'where', description: 'where', place: 'none' }
const step = await js('return { project: process.env.SOUS_PROJECT, cwd: process.cwd() }', null)
return step.result`,
    });
    const { runner } = fakeRunner(() => "ok");
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "where", projectDir, inputs: {} });
    const result = await workers.ended(record.runId);
    const found = result!.result as { project: string; cwd: string };
    assert.equal(found.project, projectDir);
    assert.notEqual(realpathSync(found.cwd), realpathSync(projectDir));
  });

  it("a nested workflow gets the defaults of its inputs, and a missing input fails the call", async () => {
    const { paths, projectDir } = testHome({
      child: `export const meta = { name: 'child', description: 'child', inputs: {
  task: { type: 'string', required: true }, rounds: { type: 'number', default: 3 }, test: { type: 'string', default: 'npm test' } } }
return args`,
      parent: `export const meta = { name: 'parent', description: 'parent' }
const given = await workflow('child', { task: 'fix it', rounds: 2 })
let missing
try { await workflow('child', { rounds: 1 }) } catch (error) { missing = error.message }
return { given, missing }`,
    });
    const { runner } = fakeRunner(() => "ok");
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "parent", projectDir, inputs: {} });
    const result = await workers.ended(record.runId);
    const out = result!.result as { given: Record<string, unknown>; missing: string };
    assert.deepEqual(out.given, { task: "fix it", rounds: 2, test: "npm test" });
    assert.match(out.missing, /workflow\("child"\): missing input --task/);
  });

  it("the log starts a nested run's lines with its label", async () => {
    const { paths, projectDir } = testHome({
      child: `export const meta = { name: 'child', description: 'child', inputs: { task: 'The task' } }
phase('build')
log('working on ' + args.task)
return await agent('do ' + args.task, { label: 'implementer' })`,
      parent: `export const meta = { name: 'parent', description: 'parent' }
await agent('look', { label: 'triage' })
await workflow('child', { task: 'A' }, { label: 'ticket A' })
return await workflow('child', { task: 'B' })`,
    });
    const { runner } = fakeRunner(() => "ok");
    const lines: string[] = [];
    const workers = inProcess({ inner: runner, log: (line) => lines.push(line.slice(9)) });
    const record = startRun(paths, workers.launch, { workflow: "parent", projectDir, inputs: {} });
    await workers.ended(record.runId);
    const kept = lines.filter((l) => /^(start|done|phase|log) /.test(l) && !l.includes("Logs persisted"));
    assert.deepEqual(kept.map((l) => l.replace(/, \d+ tokens$/, "")), [
      "start      triage",
      "done       triage",
      "phase      ticket A: build",
      "log        ticket A: working on A",
      "start      ticket A: implementer",
      "done       ticket A: implementer",
      "phase      child: build",
      "log        child: working on B",
      "start      child: implementer",
      "done       child: implementer",
    ]);
  });
});

describe("agents and harnesses", () => {
  it("runs one rulesync agent on each harness with that harness's block, and stops a harness's own agent sent elsewhere", async () => {
    const { paths, projectDir } = testHome({
      both: `export const meta = { name: 'both', description: 'one reviewer on two harnesses' }
const a = await agent('Review it', { agentType: 'reviewer', label: 'on claude' })
const b = await agent('Review it', { agentType: 'reviewer', label: 'on codex', model: 'codex' })
return { a, b }`,
      wrong: `export const meta = { name: 'wrong', description: 'picks the harness while running', inputs: { harness: { type: 'string', default: 'claude' } } }
await agent('Fix it', { agentType: 'fixer', label: 'fixer', model: args.harness })`,
    });
    write(
      join(projectDir, ".rulesync", "subagents", "reviewer.md"),
      "---\nname: reviewer\ndescription: reviews\nclaudecode:\n  model: haiku\n  tools: [Read]\n  effort: high\ncodexcli:\n  model: gpt-test\n  model_reasoning_effort: low\n---\nAnswer REVIEW.\n",
    );
    write(join(projectDir, ".codex", "agents", "fixer.toml"), 'name = "fixer"\ndescription = "fixes"\ndeveloper_instructions = "Fix it."\n');
    // Like a harness, the stand-in reports the model it ran without its harness.
    const { runner, calls } = fakeRunner((call) => {
      (call.options.onModelResolved as ((id: string) => void) | undefined)?.(String(call.options.model).split("/").pop()!);
      return `${call.label} done`;
    });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "both", projectDir, inputs: {} });
    const result = await workers.ended(record.runId);
    assert.equal(result?.status, "completed");
    const [claude, codex] = calls;
    assert.deepEqual([claude!.options.model, claude!.options.toolNames], ["claude/haiku", ["Read"]]);
    assert.deepEqual([codex!.options.model, codex!.options.toolNames], ["codex/gpt-test", undefined]);
    // Each harness gets its block's effort.
    assert.deepEqual([claude!.options.effort, codex!.options.effort], ["high", "low"]);
    assert.match(String(codex!.options.instructions), /Answer REVIEW\./);
    // sous show lists each step with its harness and model.
    const state = readState(paths, record.runId);
    assert.deepEqual(state?.agents.map((step) => [step.label, step.model]), [["on claude", "claude/haiku"], ["on codex", "codex/gpt-test"]]);

    const before = calls.length;
    const wrong = startRun(paths, workers.launch, { workflow: "wrong", projectDir, inputs: { harness: "claude" } });
    const stopped = await workers.ended(wrong.runId);
    assert.notEqual(stopped?.status, "completed");
    const wrongState = readState(paths, wrong.runId);
    assert.match(String(wrongState?.reason), /step "fixer": agent "fixer" comes from .*fixer\.toml, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code\. Move it to rulesync/);
    assert.equal(calls.length, before, "the agent never started");
  });
});

describe("places and reruns", () => {
  const gitProject = (workflows: Record<string, string>) => {
    const made = testHome(workflows, { defaultPlace: "worktree" });
    git(made.projectDir, "init", "-q", "-b", "main");
    commit(made.projectDir, "commit", "-q", "--allow-empty", "-m", "start");
    return made;
  };

  it("a run that changed no file removes its worktree when it ends, and one that did keeps it", async () => {
    const { paths, projectDir } = gitProject({
      look: `export const meta = { name: 'look', description: 'reads only' }\nreturn await agent('look around', { label: 'reader' })`,
      write: `export const meta = { name: 'write', description: 'writes a file' }\nreturn await agent('write it', { label: 'writer' })`,
    });
    const { runner } = fakeRunner((call) => {
      if (call.label === "writer") writeFileSync(join(String(call.options.cwd), "new.txt"), "hello\n");
      return "done";
    });
    // Both runs get their worktree before either worker starts. The workers run one after the other.
    const reader = createRun(paths, { workflow: "look", projectDir, inputs: {} });
    const writer = createRun(paths, { workflow: "write", projectDir, inputs: {} });
    assert.ok(existsSync(reader.worktree!) && existsSync(writer.worktree!));
    const workers = inProcess({ inner: runner });
    workers.launch(paths, reader.runId, "start");
    await workers.ended(reader.runId);
    workers.launch(paths, writer.runId, "start");
    await workers.ended(writer.runId);
    assert.equal(existsSync(reader.worktree!), false, "nothing changed, so the worktree is gone");
    assert.equal(git(projectDir, "branch", "--list", reader.branch!), "", "and its branch");
    assert.equal(existsSync(join(writer.worktree!, "new.txt")), true, "the writer's work stays for review");

    // Cleanup keeps the worktree of a run that has not finished, even with no commit yet, and
    // removes a finished run's worktree once its branch is merged.
    const waiting = createRun(paths, { workflow: "look", projectDir, inputs: {} });
    git(writer.worktree!, "add", "new.txt");
    commit(writer.worktree!, "commit", "-q", "-m", "work");
    git(projectDir, "merge", "-q", writer.branch!);
    // sous gc prints the folders as git names them, so /var/... on macOS shows as /private/var/....
    const waitingLine = `kept ${realpathSync(waiting.worktree!)} (${waiting.branch}): its run has not finished\n`;
    const dry = await sous(paths, ["gc", "--dry-run"]);
    assert.deepEqual(dry, { code: 0, out: `would remove ${realpathSync(writer.worktree!)} (${writer.branch}): merged\n${waitingLine}` });
    assert.equal(existsSync(writer.worktree!), true, "a dry run removes nothing");
    const result = gcRuns(paths);
    assert.deepEqual(result.removed.map((r) => r.reason), ["merged"]);
    assert.equal(existsSync(writer.worktree!), false);
    assert.equal(existsSync(waiting.worktree!), true);

    // A finished run whose branch has nothing new is merged too, and sous gc removes its worktree.
    const idle = createRun(paths, { workflow: "look", projectDir, inputs: {} });
    const now = new Date().toISOString();
    plantState(paths, { runId: idle.runId, status: "completed", startedAt: now, updatedAt: now, agents: [], logs: [], phases: [] });
    const idleDir = realpathSync(idle.worktree!);
    assert.deepEqual(await sous(paths, ["gc"]), { code: 0, out: `removed ${idleDir} (${idle.branch}): merged\n${waitingLine}` });
    assert.equal(existsSync(idle.worktree!), false);
    assert.equal(existsSync(waiting.worktree!), true);

    // Discarding a run deletes its branch and worktree, but only with --yes.
    const before = process.env.SOUS_HOME;
    process.env.SOUS_HOME = paths.home;
    try {
      assert.equal(await main(["discard", waiting.runId]), 1);
      assert.equal(existsSync(waiting.worktree!), true);
      assert.equal(await main(["discard", waiting.runId, "--yes"]), 0);
    } finally {
      if (before === undefined) delete process.env.SOUS_HOME;
      else process.env.SOUS_HOME = before;
    }
    assert.equal(existsSync(waiting.worktree!), false);
    assert.equal(git(projectDir, "branch", "--list", waiting.branch!), "");
  });

  it("an agent cannot start a workflow kept for people, nor pick it", async () => {
    const { paths, projectDir } = testHome({
      private: `export const meta = { name: 'private', description: 'people only', startedBy: 'people' }\nreturn 1`,
      open: `export const meta = { name: 'open', description: 'anyone' }\nreturn 2`,
      picker: `export const meta = { name: 'picker', description: 'lets an agent pick' }\nreturn await choose('Pick one', { any: true })`,
    });
    assert.throws(() => createRun(paths, { workflow: "private", projectDir, inputs: {}, startedByRun: "r1" }), /started by people only/);
    assert.ok(createRun(paths, { workflow: "private", projectDir, inputs: {} }), "a person can");
    const { runner, calls } = fakeRunner(() => ({ choice: "open", reason: "it is open" }));
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "picker", projectDir, inputs: {} });
    const result = await workers.ended(record.runId);
    assert.match(calls[0]!.prompt, /- open: anyone/);
    assert.doesNotMatch(calls[0]!.prompt, /private/);
    assert.equal((result?.result as { result: unknown }).result, 2);
  });
});

describe("the run tree", () => {

  /** Run one sous command on this home, and keep what it prints. */
  async function sous(paths: HomePaths, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const before = process.env.SOUS_HOME;
    process.env.SOUS_HOME = paths.home;
    const out: string[] = [];
    const err: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      return { code: await main(args), out: out.join(""), err: err.join("") };
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      if (before === undefined) delete process.env.SOUS_HOME;
      else process.env.SOUS_HOME = before;
    }
  }

  /** The step lines `sous show` prints, without their times and tokens. */
  const shownSteps = (text: string) =>
    text
      .slice(text.indexOf("steps\n") + 6)
      .split("\n")
      .filter((line, i, all) => line.startsWith("  ") && all.slice(0, i).every((l) => l.startsWith("  ")))
      .map((line) => line.replace(/\s+\(\d+s(, \d+ tokens)?\)$|\s+\(\d+ tokens\)$/, ""));

  const hangUntilAborted = (call: Call) =>
    new Promise((_, reject) => (call.options.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted"))));

  it("two levels of nesting with two nested runs at once: show, the log and stop --step name each step by its path", async () => {
    const { paths, projectDir } = testHome({
      check: `export const meta = { name: 'check', description: 'checks', inputs: { what: 'What to check' } }
return await agent('check ' + args.what, { label: 'checker' })`,
      ticket: `export const meta = { name: 'ticket', description: 'one ticket', inputs: { id: 'The ticket' } }
const built = await agent('build ' + args.id, { label: 'builder' })
const checked = await workflow('check', { what: args.id }, { label: 'check ' + args.id })
return { built, checked }`,
      parent: `export const meta = { name: 'parent', description: 'two tickets at once' }
await agent('look', { label: 'triage' })
return await parallel(['A', 'B'].map((id) => () => workflow('ticket', { id }, { label: 'ticket ' + id })))`,
    });
    let hang = true;
    const { runner, calls } = fakeRunner((call) => (call.prompt === "check A" && hang ? hangUntilAborted(call) : `${call.label} done`));
    const workers = inProcess({ inner: runner, handleSignals: true });
    const record = startRun(paths, workers.launch, { workflow: "parent", projectDir, inputs: {} });
    const file = logFile(paths, record.runId);
    const running = workers.ended(record.runId);
    await waitFor(() => calls.some((c) => c.prompt === "check A") && calls.some((c) => c.prompt === "check B"));
    await waitFor(() => readFileSync(file, "utf8").includes("done       ticket B / check B: checker"));

    // The tree comes from the record: each nested run names its parent.
    const nested = loadRecord(paths, record.runId)!.nested!;
    assert.deepEqual(
      Object.entries(nested).map(([id, child]) => [id, child.parent, child.label, child.workflow]).sort(),
      [
        [`${record.runId}-nested1`, record.runId, "ticket A", "ticket"],
        [`${record.runId}-nested1-nested1`, `${record.runId}-nested1`, "check A", "check"],
        [`${record.runId}-nested2`, record.runId, "ticket B", "ticket"],
        [`${record.runId}-nested2-nested1`, `${record.runId}-nested2`, "check B", "check"],
      ],
    );

    const wrong = await sous(paths, "stop", record.runId, "--step", "checker");
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /no step named "checker" runs .*Running now: "ticket A \/ check A: checker"/);
    assert.equal((await sous(paths, "stop", record.runId, "--step", "ticket A / check A: checker")).code, 0);
    await running;
    const state = readState(paths, record.runId);
    assert.equal(state?.status, "paused");
    assert.equal(state?.pauseReason, "step_stopped");
    assert.equal(existsSync(stopRequestFile(paths, record.runId)), false, "the worker took the request");

    hang = false;
    resumeRun(paths, workers.launch, record.runId);
    const done = await workers.ended(record.runId);
    assert.equal(done?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), [
      { built: "builder done", checked: "checker done" },
      { built: "builder done", checked: "checker done" },
    ]);
    assert.equal(calls.filter((c) => c.prompt === "check A").length, 2, "only the stopped step runs again");
    assert.equal(calls.length, 6);

    const lines = readFileSync(file, "utf8").split("\n").map((l) => l.slice(9));
    for (const expected of [
      "start      triage",
      "start      ticket A: builder",
      "start      ticket B: builder",
      "start      ticket A / check A: checker",
      "done       ticket B / check B: checker",
      "stopping   ticket A / check A: checker",
    ]) {
      assert.ok(lines.includes(expected), `the log has "${expected}"`);
    }
    assert.ok(lines.some((l) => /^done +ticket A \/ check A: checker/.test(l)), "the stopped step ends on resume");

    const shown = await sous(paths, "show", record.runId);
    assert.equal(shown.code, 0);
    assert.deepEqual(shownSteps(shown.out), [
      "  done  triage",
      "  ticket A  (workflow ticket)",
      "    done  builder",
      "    check A  (workflow check)",
      "      done  checker",
      "  ticket B  (workflow ticket)",
      "    done  builder",
      "    check B  (workflow check)",
      "      done  checker",
    ]);
  });

  it("an old record, whose nested runs name no parent, shows, stops, resumes and gcs as before", async () => {
    const { paths, projectDir } = testHome(
      {
        child: `export const meta = { name: 'child', description: 'builds', inputs: { id: 'The ticket' } }
return await agent('build ' + args.id, { label: 'builder' })`,
        parent: `export const meta = { name: 'parent', description: 'two tickets in their own worktrees' }
await agent('look', { label: 'triage' })
return await parallel(['A', 'B'].map((id) => () => workflow('child', { id }, { label: 'ticket ' + id, place: 'worktree' })))`,
      },
      { defaultPlace: "worktree" },
    );
    git(projectDir, "init", "-q", "-b", "main");
    commit(projectDir, "commit", "-q", "--allow-empty", "-m", "start");
    let hang = true;
    const { runner, calls } = fakeRunner((call) => {
      if (call.label !== "builder") return `${call.label} done`;
      if (call.prompt === "build A" && hang) return hangUntilAborted(call);
      const cwd = String(call.options.cwd);
      writeFileSync(join(cwd, `${call.prompt}.txt`), "work\n");
      git(cwd, "add", ".");
      commit(cwd, "commit", "-q", "-m", call.prompt);
      return "built";
    });
    const workers = inProcess({ inner: runner, handleSignals: true });
    const { runId } = startRun(paths, workers.launch, { workflow: "parent", projectDir, inputs: {} });
    const file = logFile(paths, runId);
    const running = workers.ended(runId);
    await waitFor(() => calls.some((c) => c.prompt === "build A") && readFileSync(file, "utf8").includes("done       ticket B: builder"));

    // The code at 7e0547ab wrote nested entries with no parent, and no step worktrees.
    const recordJson = join(paths.records, `${runId}.json`);
    const toOldShape = () => {
      const json = JSON.parse(readFileSync(recordJson, "utf8")) as { nested: Record<string, Record<string, unknown>>; stepWorktrees?: unknown };
      for (const child of Object.values(json.nested)) delete child.parent;
      delete json.stepWorktrees;
      writeFileSync(recordJson, `${JSON.stringify(json, null, 2)}\n`);
    };
    const trees = ["nested1", "nested2"].map((n) => ({ dir: join(paths.worktrees, `${runId}-${n}`), branch: `sous/${runId}-${n}` }));
    assert.deepEqual(
      Object.entries(loadRecord(paths, runId)!.nested!).map(([id, child]) => [id, child.cwd, child.branch]).sort(),
      trees.map((tree) => [tree.branch.slice("sous/".length), tree.dir, tree.branch]),
      "the nested worktrees keep the names <run>-nested<n>",
    );
    const newShape = await sous(paths, "show", runId);
    toOldShape();
    assert.equal(loadRecord(paths, runId)!.nested![`${runId}-nested1`]!.parent, runId, "the old reader finds the parent");
    const oldShape = await sous(paths, "show", runId);
    assert.equal(oldShape.out, newShape.out);
    assert.deepEqual(shownSteps(oldShape.out), [
      "  done  triage",
      `  ticket A  (workflow child, branch ${trees[0]!.branch})`,
      "    running builder",
      `  ticket B  (workflow child, branch ${trees[1]!.branch})`,
      "    done  builder",
    ]);

    toOldShape();
    assert.equal((await sous(paths, "stop", runId, "--step", "ticket A: builder")).code, 0);
    await running;
    assert.equal(readState(paths, runId)?.pauseReason, "step_stopped");
    assert.match(readFileSync(file, "utf8"), /stopping   ticket A: builder/);

    // A paused run keeps its nested worktrees, merged or not.
    git(projectDir, "merge", "-q", trees[1]!.branch);
    toOldShape();
    const paused = gcRuns(paths);
    assert.deepEqual(paused.removed, []);
    assert.deepEqual(
      paused.kept.filter((k) => k.branch.startsWith(`sous/${runId}-nested`)).map((k) => [k.branch, k.reason]),
      trees.map((tree) => [tree.branch, "its run has not finished"]),
    );

    toOldShape();
    hang = false;
    resumeRun(paths, workers.launch, runId);
    const done = await workers.ended(runId);
    assert.equal(done?.status, "completed");
    assert.deepEqual(calls.map((c) => c.prompt).sort(), ["build A", "build A", "build B", "look"]);
    assert.ok(trees.every((tree) => existsSync(join(tree.dir, `build ${tree === trees[0] ? "A" : "B"}.txt`))), "each ticket worked in its own worktree");

    // Once the run ended, gc removes each merged nested worktree.
    commit(projectDir, "merge", "-q", "--no-edit", trees[0]!.branch);
    toOldShape();
    const ended = gcRuns(paths);
    assert.deepEqual(
      ended.removed.filter((r) => r.branch.startsWith(`sous/${runId}-nested`)).map((r) => [r.branch, r.reason]),
      trees.map((tree) => [tree.branch, "merged"]),
    );
    assert.ok(trees.every((tree) => !existsSync(tree.dir)));
  });
});

describe("service", () => {
  it("starts a schedule once per matching minute, and skips it while its last run is unfinished", () => {
    const { paths, projectDir } = testHome({ nightly: `export const meta = { name: 'nightly', description: 'n' }\nreturn 1` });
    saveSchedules(paths, [{ name: "n", workflow: join(projectDir, ".sous", "workflows", "nightly.js"), projectDir, cron: "0 3 * * *", inputs: {}, enabled: true, createdAt: "" }]);
    const started: string[] = [];
    const launch = (_paths: unknown, runId: string) => started.push(runId);
    tick(paths, launch, { now: new Date(2026, 10, 21, 2, 59), log: quiet });
    assert.equal(started.length, 0);
    tick(paths, launch, { now: new Date(2026, 10, 21, 3, 0, 5), log: quiet });
    tick(paths, launch, { now: new Date(2026, 10, 21, 3, 0, 40), log: quiet });
    assert.equal(started.length, 1, "once in that minute");
    const record = loadRecord(paths, started[0]!);
    assert.equal(record?.origin, "schedule");
    assert.equal(record?.priority, "schedule");

    // The run never started, so it counts as unfinished only once the engine knows it. Mark it paused.
    const lines: string[] = [];
    plantState(paths, { runId: started[0]!, status: "paused", pauseReason: "requested", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), agents: [], logs: [], phases: [] });
    tick(paths, launch, { now: new Date(2026, 10, 22, 3, 0), log: (line) => lines.push(line) });
    assert.equal(started.length, 1);
    assert.match(lines.join("\n"), /skipped, run .* has not finished/);
  });

  it("starts a workflow on the cron in its meta, once sous has run in its project", () => {
    const nightly = `export const meta = { name: 'nightly', description: 'n', inputs: { who: 'Who' }, schedule: { cron: '0 3 * * *', inputs: { who: 'night' } } }\nreturn args.who`;
    const { paths, projectDir } = testHome({ nightly, hand: `export const meta = { name: 'hand', description: 'h' }\nreturn 1` });
    const file = join(projectDir, ".sous", "workflows", "nightly.js");
    const started: string[] = [];
    const launch = (_paths: unknown, runId: string) => started.push(runId);
    tick(paths, launch, { now: new Date(2026, 10, 21, 3, 0), log: quiet });
    assert.equal(started.length, 0, "the service does not know the project yet");

    createRun(paths, { workflow: "hand", projectDir, inputs: {} });
    assert.deepEqual(knownProjects(paths), [projectDir]);
    assert.deepEqual(fileSchedules(paths).map((schedule) => [schedule.name, schedule.cron]), [[file, "0 3 * * *"]]);
    tick(paths, launch, { now: new Date(2026, 10, 22, 2, 59), log: quiet });
    tick(paths, launch, { now: new Date(2026, 10, 22, 3, 0, 5), log: quiet });
    tick(paths, launch, { now: new Date(2026, 10, 22, 3, 0, 40), log: quiet });
    assert.equal(started.length, 1, "once in that minute");
    const record = loadRecord(paths, started[0]!);
    assert.equal(record?.origin, "schedule");
    assert.equal(record?.schedule, file);
    assert.deepEqual(record?.args, { who: "night" });
    assert.equal(checkWorkflow(paths, projectDir, "nightly").notes.some((note) => note.startsWith('the service starts it at "0 3 * * *"')), true);
  });

  it("refuses a bad schedule in the meta, and runs a home workflow's schedule in a scratch folder", () => {
    const { paths, projectDir } = testHome({
      badCron: `export const meta = { name: 'badCron', description: 'b', schedule: '0 25 * * *' }\nreturn 1`,
      noInput: `export const meta = { name: 'noInput', description: 'b', inputs: { who: 'Who' }, schedule: '0 3 * * *' }\nreturn 1`,
    });
    rememberProject(paths, projectDir);
    assert.match(checkWorkflow(paths, projectDir, "badCron").problems.join("\n"), /meta.schedule: bad hour in cron: "25"/);
    assert.match(checkWorkflow(paths, projectDir, "noInput").problems.join("\n"), /meta.schedule.inputs: missing input who/);
    assert.deepEqual(fileSchedules(paths), [], "a file with a problem in its meta has no schedule");

    mkdirSync(paths.workflows, { recursive: true });
    writeFileSync(join(paths.workflows, "digest.js"), `export const meta = { name: 'digest', description: 'd', place: 'worktree', schedule: '@daily' }\nreturn 1`);
    const started: string[] = [];
    tick(paths, (_paths, runId) => started.push(runId), { now: new Date(2026, 10, 22, 0, 0), log: quiet });
    assert.equal(started.length, 1);
    const record = loadRecord(paths, started[0]!);
    assert.equal(record?.place, "none");
    assert.equal(record?.projectDir, paths.home);
    assert.equal(record?.cwd, join(paths.scratch, record!.runId));
  });

  it("tells the user once about a run cut off by a crash and leaves it for them to resume, while a limit pause resumes", () => {
    const { paths, projectDir } = testHome({ job: `export const meta = { name: 'job', description: 'j' }\nreturn 1` });
    const cut = createRun(paths, { workflow: "job", projectDir, inputs: {} });
    const limited = createRun(paths, { workflow: "job", projectDir, inputs: {} });
    const at = new Date(2026, 10, 21, 10, 0).toISOString();
    const base = { startedAt: at, updatedAt: at, agents: [], logs: [], phases: [] };
    plantState(paths, { ...base, runId: cut.runId, status: "paused", pauseReason: "interrupted" });
    // A real paused state keeps its script, and the service resumes only when the file still matches it.
    plantState(paths, { ...base, runId: limited.runId, status: "paused", pauseReason: "usage_limit", resetHint: "Resets at 2026-11-21T10:30:00.000Z", script: readFileSync(limited.file, "utf8") });
    const spawned: string[] = [];
    const told: string[] = [];
    const launch = (_paths: unknown, runId: string) => spawned.push(runId);
    const deps = { notify: (title: string, body: string) => told.push(`${title}: ${body}`), log: quiet };
    tick(paths, launch, { ...deps, now: new Date("2026-11-21T11:00:00.000Z") });
    tick(paths, launch, { ...deps, now: new Date("2026-11-21T11:05:00.000Z") });
    assert.deepEqual(spawned, [limited.runId]);
    assert.deepEqual(told, [`job was cut off: sous resume ${cut.runId} goes on from where it stopped`]);
  });
});

describe("dry runs", () => {
  const gitProject = (workflows: Record<string, string>) => {
    const made = testHome(workflows, { defaultPlace: "folder" });
    git(made.projectDir, "init", "-q", "-b", "main");
    git(made.projectDir, "add", "-A");
    commit(made.projectDir, "commit", "-q", "-m", "start");
    return made;
  };
  const review = `export const meta = { name: 'review', description: 'loops with a reviewer', inputs: { rounds: { type: 'number', default: 3 } } }
const made = await sh('echo hi > out.txt && cat out.txt', { label: 'write' })
const verdictSchema = { type: 'object', properties: { approved: { type: 'boolean' }, review: { type: 'string' } }, required: ['approved', 'review'] }
let round = 0
let verdict
while (round < args.rounds) {
  round++
  verdict = await agent('Review', { label: 'reviewer ' + round, schema: verdictSchema })
  if (verdict.approved) break
}
const text = await agent('Write', { label: 'writer' })
const kept = await breakpoint('Keep it?', async () => text)
return { out: made.stdout.trim(), approved: verdict.approved, rounds: round, kept }`;

  it("a dry run runs the code steps in a copy, gives stand-in answers, and leaves nothing behind", async () => {
    const { paths, projectDir } = gitProject({ review });
    const lines: string[] = [];
    const dry = await dryRun(paths, { workflow: "review", projectDir, inputs: {}, log: (line) => lines.push(line.slice(9)) });
    assert.equal(dry.status, "completed");
    assert.deepEqual(dry.result, { out: "hi", approved: true, rounds: 1, kept: "stand-in answer from writer" });
    assert.deepEqual(dry.agents, ["reviewer 1", "writer"]);
    assert.ok(lines.some((line) => line.startsWith("question   Breakpoint: Keep it?")), lines.join("\n"));
    // The code step wrote in the copy, never in the project. The run, its worktree and its branch are gone.
    assert.equal(existsSync(join(projectDir, "out.txt")), false);
    assert.deepEqual(listRecords(paths), []);
    assert.deepEqual(existsSync(paths.worktrees) ? readdirSync(paths.worktrees) : [], []);
    assert.equal(git(projectDir, "branch", "--list", "sous/*"), "");
    assert.equal(runQuestions(paths).length, 0);
    // No file of the run is left in the home.
    const left = (readdirSync(paths.home, { recursive: true }) as string[]).filter((name) => name.includes(dry.runId));
    assert.deepEqual(left, []);
  });

  it("answers given by step label, in turn, drive a dry run through a loop", async () => {
    const { paths, projectDir } = gitProject({ review });
    const answers = { "reviewer *": [{ approved: false, review: "Add a test" }, { approved: true, review: "Good" }], writer: "the text" };
    const dry = await dryRun(paths, { workflow: "review", projectDir, inputs: {}, answers });
    assert.equal(dry.status, "completed");
    assert.deepEqual(dry.result, { out: "hi", approved: true, rounds: 2, kept: "the text" });
  });

  it("a dry run catches a step that reads a field its answer does not have", async () => {
    const { paths, projectDir } = gitProject({
      broken: `export const meta = { name: 'broken', description: 'reads a field the schema lacks' }
const verdict = await agent('Review', { label: 'reviewer', schema: { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'] } })
return verdict.details.length`,
    });
    const dry = await dryRun(paths, { workflow: "broken", projectDir, inputs: {} });
    assert.equal(dry.status, "failed");
    assert.match(dry.reason ?? "", /Cannot read properties of undefined \(reading 'length'\)/);
    assert.deepEqual(listRecords(paths), []);
  });

  it("a dry run keeps a workflow's scratch folder, and deletes it after", async () => {
    const { paths, projectDir } = gitProject({
      scratch: `export const meta = { name: 'scratch', description: 'works in a scratch folder', place: 'none' }
return (await sh('pwd', { label: 'where' })).stdout.trim()`,
    });
    const dry = await dryRun(paths, { workflow: "scratch", projectDir, inputs: {} });
    assert.equal(dry.status, "completed");
    assert.equal(String(dry.result).startsWith(realpathSync(paths.scratch)), true, String(dry.result));
    assert.equal(existsSync(String(dry.result)), false);
  });

  it("sous check --dry-run prints the run and exits 0 when it completes", async () => {
    const { paths, projectDir } = gitProject({ review });
    const printed: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    // The test runner reports through stdout too, so every chunk still goes out.
    process.stdout.write = ((chunk: string) => {
      printed.push(String(chunk));
      return write(chunk);
    }) as typeof process.stdout.write;
    const home = process.env.SOUS_HOME;
    process.env.SOUS_HOME = paths.home;
    try {
      assert.equal(await main(["check", "review", "--dry-run", "--project", projectDir]), 0);
    } finally {
      process.stdout.write = write;
      if (home === undefined) delete process.env.SOUS_HOME;
      else process.env.SOUS_HOME = home;
    }
    const text = printed.join("");
    assert.match(text, /dry run completed, with 2 agent steps answered by stand-ins/);
    assert.match(text, /"rounds": 1/);
  });
});

describe("sous schedule", () => {
  const workflows = {
    daily: `export const meta = { name: 'daily', description: 'd', inputs: { who: 'Who' } }\nreturn args.who`,
    nightly: `export const meta = { name: 'nightly', description: 'n', inputs: { who: 'Who' }, schedule: { cron: '0 3 * * *', inputs: { who: 'night' } } }\nreturn args.who`,
  };
  // sous shows a path in the home folder with ~. These tests set HOME to the folder that holds the
  // project, so the workflow files show as ~/project/....
  const scheduleIn = (paths: HomePaths, projectDir: string) => async (...args: string[]) => {
    const before = process.env.HOME;
    process.env.HOME = dirname(projectDir);
    try {
      return await sous(paths, ["schedule", ...args, "--project", projectDir]);
    } finally {
      if (before === undefined) delete process.env.HOME;
      else process.env.HOME = before;
    }
  };
  /** The output with each next start, a local time, as "next <time>". */
  const timed = (shown: { code: number; out: string }) => ({ ...shown, out: shown.out.replace(/next \S.*$/gm, "next <time>") });
  const daily = "~/project/.sous/workflows/daily.js";
  const nightly = "~/project/.sous/workflows/nightly.js";

  it("adds, lists, disables, enables, tests and removes a schedule, beside the one a workflow's meta sets", async () => {
    const { paths, projectDir } = testHome(workflows);
    const schedule = scheduleIn(paths, projectDir);
    const dailyFile = join(projectDir, ".sous", "workflows", "daily.js");
    const nightlyFile = join(projectDir, ".sous", "workflows", "nightly.js");
    const notRunning = "the service is not running, so nothing will start: sous daemon start\n";

    assert.deepEqual(timed(await schedule("add", "morning", "daily", "--cron", "0 9 * * 1-5", "--who", "me")), {
      code: 0,
      out: `schedule morning: daily at "0 9 * * 1-5", next <time>\n${notRunning}`,
    });
    assert.deepEqual(timed(await schedule("add", "often", "nightly", "--cron", "* * * * *", "--place", "folder")), {
      code: 0,
      out: `schedule often: nightly at "* * * * *", next <time>\nnote: nightly also sets "0 3 * * *" in its meta, and both start it\n${notRunning}`,
    });

    // sous schedule list remembers the project, so it also lists the schedule in nightly's meta.
    const listed = `morning  0 9 * * 1-5  ${daily}  next <time>\noften  * * * * *  ${nightly}  next <time>\n${nightly}  0 3 * * *  set in the file  next <time>\n\nthe service is not running: sous daemon start\n`;
    assert.deepEqual(timed(await schedule("list")), { code: 0, out: listed });
    assert.deepEqual(timed(await schedule()), { code: 0, out: listed }, "list is the default");

    const json = await schedule("list", "--json");
    assert.equal(json.code, 0);
    const [morning, often] = JSON.parse(json.out) as Array<{ createdAt: string }>;
    for (const one of [morning!, often!]) assert.match(one.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const stored = [
      { name: "morning", workflow: dailyFile, projectDir, cron: "0 9 * * 1-5", inputs: { who: "me" }, enabled: true, createdAt: morning!.createdAt },
      { name: "often", workflow: nightlyFile, projectDir, cron: "* * * * *", inputs: {}, place: "folder", enabled: true, createdAt: often!.createdAt },
      { name: nightlyFile, workflow: nightlyFile, projectDir, cron: "0 3 * * *", inputs: { who: "night" }, enabled: true, createdAt: "", fromFile: true },
    ];
    assert.equal(json.out, `${JSON.stringify(stored, null, 2)}\n`);

    assert.deepEqual(await schedule("disable", "morning"), { code: 0, out: "disabled morning\n" });
    assert.deepEqual(timed(await schedule("list")), { code: 0, out: listed.replace(`${daily}  next <time>`, `${daily}  disabled`) });
    assert.deepEqual(await schedule("enable", "morning"), { code: 0, out: "enabled morning\n" });
    assert.deepEqual(timed(await schedule("list")), { code: 0, out: listed });

    assert.deepEqual(timed(await schedule("test", "often")), { code: 0, out: "often matches now; next <time>\n" });
    const tested = await schedule("test", "morning");
    assert.equal(tested.code, 0);
    assert.match(tested.out, /^morning (matches|does not match) now; next \S.*\n$/);
    const inMeta = await schedule("test", nightlyFile);
    assert.equal(inMeta.code, 0);
    assert.match(inMeta.out, /^~\/project\/\.sous\/workflows\/nightly\.js (matches|does not match) now; next \S.*\n$/);

    assert.deepEqual(await schedule("remove", "often"), { code: 0, out: "removed often\n" });
    assert.deepEqual(timed(await schedule("list")), {
      code: 0,
      out: `morning  0 9 * * 1-5  ${daily}  next <time>\n${nightly}  0 3 * * *  set in the file  next <time>\n\nthe service is not running: sous daemon start\n`,
    });
  });

  it("refuses a name that exists, a bad cron, an unknown workflow, a bad place and a change to a schedule a meta sets, and writes nothing", async () => {
    const { paths, projectDir } = testHome(workflows);
    const schedule = scheduleIn(paths, projectDir);
    assert.equal((await schedule("add", "morning", "daily", "--cron", "0 9 * * *")).code, 0);
    const saved = readFileSync(paths.schedules, "utf8");

    assert.deepEqual(await schedule("add", "morning", "nightly", "--cron", "0 9 * * *"), { code: 1, out: 'sous: a schedule "morning" exists. Remove it first.\n' });
    assert.deepEqual(await schedule("add", "late", "daily", "--cron", "0 25 * * *"), { code: 1, out: 'sous: bad hour in cron: "25" (allowed 0-23)\n' });
    assert.deepEqual(await schedule("add", "late", "daily", "--cron", "0 9 * *"), { code: 1, out: 'sous: cron needs five fields (minute hour day month weekday), got "0 9 * *"\n' });
    assert.deepEqual(await schedule("add", "late", "nope", "--cron", "0 9 * * *"), {
      code: 1,
      out: `sous: no workflow "nope". Looked in ${join(projectDir, ".sous", "workflows")} and ${paths.workflows}. Saved workflows: daily, nightly.\n`,
    });
    assert.deepEqual(await schedule("add", "late", "daily", "--cron", "0 9 * * *", "--place", "moon"), { code: 64, out: 'usage: --place is worktree, folder or none, got "moon"\n' });
    // With two mistakes, the name that exists comes before the bad place.
    assert.deepEqual(await schedule("add", "morning", "daily", "--cron", "0 9 * * *", "--place", "moon"), { code: 1, out: 'sous: a schedule "morning" exists. Remove it first.\n' });
    assert.deepEqual(await schedule("add", "late", "daily"), { code: 64, out: 'usage: sous schedule add <name> <workflow> --cron "0 9 * * 1-5" [--name value ...]\n' });
    assert.equal(readFileSync(paths.schedules, "utf8"), saved, "a refused add writes nothing");

    // Once sous schedule list has remembered the project, the schedule in nightly's meta is known,
    // and sous refuses to change it.
    const nightlyFile = join(projectDir, ".sous", "workflows", "nightly.js");
    assert.equal((await schedule("list")).code, 0);
    const inMeta = `sous: the schedule of ${nightly} is set in its meta. Change or remove meta.schedule there.\n`;
    for (const action of ["remove", "disable", "enable"]) assert.deepEqual(await schedule(action, nightlyFile), { code: 1, out: inMeta }, action);
    for (const action of ["remove", "disable", "enable", "test"]) assert.deepEqual(await schedule(action, "nope"), { code: 1, out: 'sous: no schedule "nope". sous schedule list shows them.\n' }, action);
    assert.deepEqual(await schedule("launch"), { code: 64, out: "usage: sous schedule add|list|remove|enable|disable|test\n" });
    assert.equal(readFileSync(paths.schedules, "utf8"), saved, "a refused change writes nothing");
  });
});

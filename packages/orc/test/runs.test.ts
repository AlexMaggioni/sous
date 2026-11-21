import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WorkflowError, WorkflowErrorCode, type AgentRunner } from "@automatalabs/shared-types";
import { checkWorkflow } from "../src/check.js";
import { main, runningSteps } from "../src/cli.js";
import { saveSchedules, tick, unfinishedRuns } from "../src/daemon.js";
import { gcWorktrees } from "../src/places.js";
import { ensureHome, homePaths, type HomePaths } from "../src/home.js";
import { listQuestions, writeAnswer } from "../src/inbox.js";
import { createRun, logFile } from "../src/launch.js";
import { loadRecord, updateRecord } from "../src/records.js";
import { managerFor, runWorker } from "../src/worker.js";

// Whole runs in this process, with a fake agent runner, the way `orc run` drives them.

function setup(workflows: Record<string, string>, config: Record<string, unknown> = {}): { paths: HomePaths; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "orc-runs-"));
  const paths = ensureHome(homePaths(join(root, "home")));
  writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder", ...config }));
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".orchestrator", "workflows"), { recursive: true });
  mkdirSync(join(projectDir, ".orchestrator", "agents"), { recursive: true });
  for (const [name, script] of Object.entries(workflows)) writeFileSync(join(projectDir, ".orchestrator", "workflows", `${name}.js`), script);
  return { paths, projectDir };
}

interface Call {
  prompt: string;
  label?: string;
  options: Record<string, unknown>;
}

function fakeRunner(answer: (call: Call, calls: Call[]) => unknown): { runner: AgentRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner = {
    async run(prompt: string, options: Record<string, unknown> = {}) {
      const call = { prompt, label: options.label as string | undefined, options };
      calls.push(call);
      (options.onSessionOpen as ((ref: unknown) => void) | undefined)?.({ sessionId: `s${calls.length}`, backendId: "claude", cwd: options.cwd, reopen: { load: true, resume: true, list: true } });
      return answer(call, calls);
    },
  } as unknown as AgentRunner;
  return { runner, calls };
}

async function answerWhenAsked(paths: HomePaths, runId: string, reply: (prompt: string) => unknown, times = 1): Promise<string[]> {
  const asked: string[] = [];
  for (let waited = 0; asked.length < times && waited < 15_000; waited += 20) {
    const open = listQuestions(paths, runId);
    if (open.length) {
      const question = open[0]!;
      asked.push(question.prompt);
      writeAnswer(paths, question, reply(question.prompt));
      while (listQuestions(paths, runId).some((q) => q.id === question.id)) await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return asked;
}

const quiet = () => {};

describe("runs", () => {
  it("an agent asks a question, the answer comes through the inbox, and the same session goes on", async () => {
    const { paths, projectDir } = setup({
      asking: `export const meta = { name: 'asking', description: 'asks', inputs: { task: 'What to do' } }
const out = await agent('Do ' + args.task, { label: 'worker', ask: true })
return out`,
    });
    const { runner, calls } = fakeRunner((call) => (call.label === "worker" ? "QUESTION: Postgres or SQLite?" : `built with ${/answered: (\w+)/.exec(call.prompt)?.[1]}`));
    const record = createRun(paths, { workflow: "asking", projectDir, inputs: { task: "the store" } });
    const running = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    const asked = await answerWhenAsked(paths, record.runId, () => "SQLite");
    const result = await running;
    assert.equal(result?.status, "completed");
    assert.equal(result?.result, "built with SQLite");
    assert.match(asked[0]!, /worker asks: Postgres or SQLite\?/);
    assert.equal((calls[1]!.options.continueFromSession as { sessionId: string }).sessionId, "s1");
    assert.equal(loadRecord(paths, record.runId)?.pid, undefined, "the record forgets the worker once it ends");
  });

  it("a breakpoint sent back with a note runs the step again with that note, then approve goes on", async () => {
    const { paths, projectDir } = setup({
      checked: `export const meta = { name: 'checked', description: 'a breakpoint' }
const draft = await breakpoint('Check the plan', (note) => agent('Plan it' + (note ? '. Change: ' + note : ''), { label: 'planner' }))
return draft`,
    });
    const { runner, calls } = fakeRunner((call) => (call.prompt.includes("Change: shorter") ? "short plan" : "long plan"));
    const record = createRun(paths, { workflow: "checked", projectDir, inputs: {} });
    const running = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    const replies = [{ decision: "send back", note: "shorter" }, "approve"];
    const asked = await answerWhenAsked(paths, record.runId, () => replies.shift(), 2);
    const result = await running;
    assert.equal(result?.status, "completed");
    assert.equal(result?.result, "short plan");
    assert.equal(calls.length, 2);
    assert.match(asked[0]!, /^Breakpoint: Check the plan\n\nlong plan/);
    assert.match(asked[1]!, /short plan/);
  });

  it("a step that keeps failing pauses the run on it, and resume runs it again while finished steps stay done", async () => {
    const { paths, projectDir } = setup(
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
    const record = createRun(paths, { workflow: "flaky", projectDir, inputs: {} });
    const paused = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(paused?.status, "paused");
    const state = managerFor(paths, projectDir).getPersistence().load(record.runId);
    assert.equal(state?.pauseReason, "step_failed");
    assert.match(String(state?.reason), /step "second" failed after 2 tries: .*the tests fail/);
    assert.deepEqual(calls.map((c) => c.label), ["first", "second", "second"]);

    broken = false;
    const resumed = await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(resumed?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(resumed?.result)), { first: "first done", second: "second done" });
    assert.deepEqual(calls.slice(3).map((c) => c.label), ["second"], "first is not run again");
  });

  it("a run keeps the workflows it started with, and resume asks before it takes an edit", async () => {
    const childFile = (projectDir: string) => join(projectDir, ".orchestrator", "workflows", "child.js");
    const child = (version: string) => `export const meta = { name: 'child', description: 'child' }\nreturn await agent('${version}', { label: 'build' })`;
    const { paths, projectDir } = setup(
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
    const record = createRun(paths, { workflow: "parent", projectDir, inputs: {} });
    assert.equal((await runWorker(record.runId, "start", { paths, inner: runner, log: quiet }))?.status, "paused");
    assert.deepEqual(calls.filter((c) => c.label === "build").map((c) => c.prompt), ["v1", "v1"], "the edit did not reach the run");

    const before = process.env.ORC_HOME;
    process.env.ORC_HOME = paths.home;
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (errors.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      assert.equal(await main(["resume", record.runId]), 1);
    } finally {
      process.stderr.write = write;
      if (before === undefined) delete process.env.ORC_HOME;
      else process.env.ORC_HOME = before;
    }
    assert.match(errors.join(""), /child changed since .*--latest takes the new version.*--same goes on with the version it started with/);

    await runWorker(record.runId, "resume", { paths, inner: runner, log: quiet });
    assert.equal(managerFor(paths, projectDir).getPersistence().load(record.runId)?.status, "paused");
    assert.equal(calls.at(-1)?.prompt, "v1", "a plain resume keeps the run's version");

    updateRecord(paths, record.runId, { resumeLatest: true });
    broken = false;
    const done = await runWorker(record.runId, "resume", { paths, inner: runner, log: quiet });
    assert.equal(done?.result, "v2 done");
    assert.equal(loadRecord(paths, record.runId)?.resumeLatest, undefined);
    assert.equal(calls.filter((c) => c.label === "look").length, 1, "the finished step is not run again");
  });

  it("stopping one step pauses the run on it, and resume runs it again", async () => {
    const { paths, projectDir } = setup({
      child: `export const meta = { name: 'child', description: 'child' }\nreturn await agent('build it', { label: 'build' })`,
      parent: `export const meta = { name: 'parent', description: 'parent' }
const first = await agent('first', { label: 'first' })
const built = await workflow('child', {}, { label: 'ticket A' })
return { first, built }`,
    });
    let hang = true;
    const { runner, calls } = fakeRunner((call) =>
      call.label === "build" && hang
        ? new Promise((_, reject) => (call.options.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted"))))
        : `${call.label} done`,
    );
    const record = createRun(paths, { workflow: "parent", projectDir, inputs: {} });
    const file = logFile(paths, record.runId);
    const log = (line: string) => appendFileSync(file, `${line}\n`);
    const running = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log, handleSignals: true });
    for (let i = 0; i < 500 && !calls.some((c) => c.label === "build"); i++) await new Promise((r) => setTimeout(r, 10));

    const before = process.env.ORC_HOME;
    process.env.ORC_HOME = paths.home;
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (errors.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      assert.equal(await main(["stop", record.runId, "--step", "build"]), 1);
      assert.equal(await main(["stop", record.runId, "--step", "ticket A: build"]), 0);
    } finally {
      process.stderr.write = write;
      if (before === undefined) delete process.env.ORC_HOME;
      else process.env.ORC_HOME = before;
    }
    assert.match(errors.join(""), /no step named "build" runs .*Running now: "ticket A: build"/);

    await running;
    const state = managerFor(paths, projectDir).getPersistence().load(record.runId);
    assert.equal(state?.status, "paused");
    assert.equal(state?.pauseReason, "step_stopped");
    assert.match(readFileSync(file, "utf8"), /stopping   ticket A: build/);
    assert.equal(loadRecord(paths, record.runId)?.stopSteps, undefined);

    hang = false;
    const done = await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(done?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), { first: "first done", built: "build done" });
    assert.deepEqual(calls.map((c) => c.label), ["first", "build", "build"], "first is not run again");
  });

  it("a workflow's time limit stops the running steps and pauses the run, and resume runs them again", async () => {
    const { paths, projectDir } = setup({
      slow: `export const meta = { name: 'slow', description: 'slow', timeout: '200ms' }
const first = await agent('first', { label: 'first' })
const second = await agent('second', { label: 'second' })
return { first, second }`,
      vague: `export const meta = { name: 'vague', description: 'vague', timeout: 'soon' }\nreturn 1`,
    });
    assert.throws(() => createRun(paths, { workflow: "vague", projectDir, inputs: {} }), /meta.timeout must be a time such as "90s", "10m" or "2h", got "soon"/);

    let hang = true;
    const { runner, calls } = fakeRunner((call) => (call.label === "second" && hang ? new Promise(() => {}) : `${call.label} done`));
    const record = createRun(paths, { workflow: "slow", projectDir, inputs: {} });
    assert.equal(record.timeout, "200ms");
    await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    const state = managerFor(paths, projectDir).getPersistence().load(record.runId);
    assert.equal(state?.status, "paused");
    assert.equal(state?.pauseReason, "time_limit");
    assert.match(String(state?.reason), /step "second" was stopped: the workflow's time limit of 200ms was reached/);

    hang = false;
    const done = await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(done?.status, "completed");
    assert.deepEqual(calls.map((c) => c.label), ["first", "second", "second"]);
  });

  it("the running steps come from the log", () => {
    const text = [
      "10:00:00 start      first (claude/haiku)",
      "10:00:01 done       first, 12 tokens",
      "10:00:01 start      ticket A: build (exec)",
      "10:00:01 start      ticket B: build",
      "10:00:02 failed     ticket B: build: the tests fail",
    ].join("\n");
    assert.deepEqual(runningSteps(text), ["ticket A: build"]);
  });

  it("per-run step changes and a default model reach the agent", async () => {
    const { paths, projectDir } = setup({
      changes: `export const meta = { name: 'changes', description: 'step changes' }
return await agent('review', { label: 'reviewer' })`,
    });
    const { runner, calls } = fakeRunner(() => "ok");
    const record = createRun(paths, { workflow: "changes", projectDir, inputs: {}, overrides: { reviewer: { model: "claude/opus" } } });
    await runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
    assert.equal(calls[0]!.options.model, "claude/opus");
    // Each step keeps its own start and end time.
    const step = managerFor(paths, projectDir).getPersistence().load(record.runId)!.agents[0]!;
    assert.ok(step.startedAt && step.endedAt && step.endedAt >= step.startedAt);
  });

  it("show lists the step that runs now, before the run saves it", async () => {
    const { paths, projectDir } = setup({
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
    const record = createRun(paths, { workflow: "slow", projectDir, inputs: {} });
    const running = runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
    await started;
    const before = process.env.ORC_HOME;
    process.env.ORC_HOME = paths.home;
    const printed: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      assert.equal(await main(["show", record.runId, "--json"]), 0);
    } finally {
      process.stdout.write = write;
      if (before === undefined) delete process.env.ORC_HOME;
      else process.env.ORC_HOME = before;
      release();
    }
    await running;
    const shown = JSON.parse(printed.join("")) as { state: { agents: { label: string; status: string }[] } };
    assert.deepEqual(shown.state.agents.map((a) => [a.label, a.status]), [["first", "done"], ["second", "running"]]);
  });

  it("a code step in a scratch folder finds the project through ORC_PROJECT", async () => {
    const { paths, projectDir } = setup({
      where: `export const meta = { name: 'where', description: 'where', place: 'none' }
const step = await js('return { project: process.env.ORC_PROJECT, cwd: process.cwd() }', null)
return step.result`,
    });
    const { runner } = fakeRunner(() => "ok");
    const record = createRun(paths, { workflow: "where", projectDir, inputs: {} });
    const result = await runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
    const found = result!.result as { project: string; cwd: string };
    assert.equal(found.project, projectDir);
    assert.notEqual(realpathSync(found.cwd), realpathSync(projectDir));
  });

  it("a nested workflow gets the defaults of its inputs, and a missing input fails the call", async () => {
    const { paths, projectDir } = setup({
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
    const record = createRun(paths, { workflow: "parent", projectDir, inputs: {} });
    const result = await runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
    const out = result!.result as { given: Record<string, unknown>; missing: string };
    assert.deepEqual(out.given, { task: "fix it", rounds: 2, test: "npm test" });
    assert.match(out.missing, /workflow\("child"\): missing input --task/);
  });

  it("show puts a nested workflow's steps under it, by the label the script gave it", async () => {
    const { paths, projectDir } = setup({
      child: `export const meta = { name: 'child', description: 'child', inputs: { task: 'The task' } }
return await agent('do ' + args.task, { label: 'implementer' })`,
      parent: `export const meta = { name: 'parent', description: 'parent' }
await agent('look', { label: 'triage' })
return await parallel(['A', 'B'].map((id) => () => workflow('child', { task: id }, { label: 'ticket ' + id })))`,
    });
    const { runner } = fakeRunner(() => "ok");
    const record = createRun(paths, { workflow: "parent", projectDir, inputs: {} });
    await runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
    const before = process.env.ORC_HOME;
    process.env.ORC_HOME = paths.home;
    const printed: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      assert.equal(await main(["show", record.runId]), 0);
    } finally {
      process.stdout.write = write;
      if (before === undefined) delete process.env.ORC_HOME;
      else process.env.ORC_HOME = before;
    }
    const text = printed.join("");
    const steps = text.slice(text.indexOf("steps\n") + 6, text.indexOf("result\n")).trimEnd().split("\n");
    assert.deepEqual(
      steps.map((l) => l.replace(/\s+\([^)]*tokens\)$/, "")),
      ["  done  triage", "  ticket A  (workflow child)", "    done  implementer", "  ticket B  (workflow child)", "    done  implementer"],
    );
  });

  it("the log starts a nested run's lines with its label", async () => {
    const { paths, projectDir } = setup({
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
    const record = createRun(paths, { workflow: "parent", projectDir, inputs: {} });
    const lines: string[] = [];
    await runWorker(record.runId, "start", { paths, inner: runner, log: (line) => lines.push(line.slice(9)) });
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

describe("places and reruns", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const gitProject = (workflows: Record<string, string>) => {
    const made = setup(workflows, { defaultPlace: "worktree" });
    git(made.projectDir, "init", "-q", "-b", "main");
    git(made.projectDir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
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
    const reader = createRun(paths, { workflow: "look", projectDir, inputs: {} });
    const writer = createRun(paths, { workflow: "write", projectDir, inputs: {} });
    assert.ok(existsSync(reader.worktree!) && existsSync(writer.worktree!));
    await runWorker(reader.runId, "start", { paths, inner: runner, log: quiet });
    await runWorker(writer.runId, "start", { paths, inner: runner, log: quiet });
    assert.equal(existsSync(reader.worktree!), false, "nothing changed, so the worktree is gone");
    assert.equal(git(projectDir, "branch", "--list", reader.branch!), "", "and its branch");
    assert.equal(existsSync(join(writer.worktree!, "new.txt")), true, "the writer's work stays for review");

    // Cleanup keeps the worktree of a run that has not finished, even with no commit yet, and
    // removes a finished run's worktree once its branch is merged.
    const waiting = createRun(paths, { workflow: "look", projectDir, inputs: {} });
    git(writer.worktree!, "add", "new.txt");
    git(writer.worktree!, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "work");
    git(projectDir, "merge", "-q", writer.branch!);
    const records = [loadRecord(paths, waiting.runId)!, loadRecord(paths, writer.runId)!];
    const result = gcWorktrees(paths, [projectDir], { unfinished: unfinishedRuns(paths, records) });
    assert.deepEqual(result.removed.map((r) => r.reason), ["merged"]);
    assert.equal(existsSync(writer.worktree!), false);
    assert.equal(existsSync(waiting.worktree!), true);

    // Discarding a run deletes its branch and worktree, but only with --yes.
    const before = process.env.ORC_HOME;
    process.env.ORC_HOME = paths.home;
    try {
      assert.equal(await main(["discard", waiting.runId]), 1);
      assert.equal(existsSync(waiting.worktree!), true);
      assert.equal(await main(["discard", waiting.runId, "--yes"]), 0);
    } finally {
      if (before === undefined) delete process.env.ORC_HOME;
      else process.env.ORC_HOME = before;
    }
    assert.equal(existsSync(waiting.worktree!), false);
    assert.equal(git(projectDir, "branch", "--list", waiting.branch!), "");
  });

  it("a rerun after an edit reuses the steps before the edit, in the same place", async () => {
    const { paths, projectDir } = setup({
      two: `export const meta = { name: 'two', description: 'two steps' }
const plan = await agent('plan it', { label: 'planner' })
const build = await agent('build ' + plan, { label: 'builder' })
return build`,
    });
    const { runner, calls } = fakeRunner((call) => (call.label === "planner" ? "the plan" : `built: ${call.prompt}`));
    const first = createRun(paths, { workflow: "two", projectDir, inputs: {} });
    await runWorker(first.runId, "start", { paths, inner: runner, log: quiet });
    writeFileSync(join(projectDir, ".orchestrator", "workflows", "two.js"), `export const meta = { name: 'two', description: 'two steps' }
const plan = await agent('plan it', { label: 'planner' })
const build = await agent('build carefully ' + plan, { label: 'builder' })
return build`);
    const again = createRun(paths, { workflow: "two", projectDir, inputs: {}, reuseFrom: first, origin: "rerun", rerunOf: first.runId });
    assert.equal(again.cwd, first.cwd);
    const result = await runWorker(again.runId, "start", { paths, inner: runner, log: quiet });
    assert.equal(result?.result, "built: build carefully the plan");
    assert.deepEqual(calls.map((c) => c.label), ["planner", "builder", "builder"], "the planner ran once");
  });

  it("an agent cannot start a workflow kept for people, nor pick it", async () => {
    const { paths, projectDir } = setup({
      private: `export const meta = { name: 'private', description: 'people only', startedBy: 'people' }\nreturn 1`,
      open: `export const meta = { name: 'open', description: 'anyone' }\nreturn 2`,
      picker: `export const meta = { name: 'picker', description: 'lets an agent pick' }\nreturn await choose('Pick one', { any: true })`,
    });
    assert.throws(() => createRun(paths, { workflow: "private", projectDir, inputs: {}, startedByRun: "r1" }), /started by people only/);
    assert.ok(createRun(paths, { workflow: "private", projectDir, inputs: {} }), "a person can");
    const { runner, calls } = fakeRunner(() => ({ choice: "open", reason: "it is open" }));
    const record = createRun(paths, { workflow: "picker", projectDir, inputs: {} });
    const result = await runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
    assert.match(calls[0]!.prompt, /- open: anyone/);
    assert.doesNotMatch(calls[0]!.prompt, /private/);
    assert.equal((result?.result as { result: unknown }).result, 2);
  });
});

describe("check", () => {
  it("finds missing workflows, agents and MCP servers without running anything", () => {
    const { paths, projectDir } = setup({
      outer: `export const meta = { name: 'outer', description: 'nests', inputs: { ticket: 'The ticket' } }
await workflow('inner', {})
await workflow('ghost', {})
await agent('x', { agentType: 'implementer', mcp: ['linear'] })
await agent('y', { agentType: 'reviewer' })`,
      inner: `export const meta = { name: 'inner', description: 'inner' }
await agent('z', { agentType: 'nobody' })`,
    });
    writeFileSync(join(projectDir, ".orchestrator", "agents", "implementer.md"), "---\nname: implementer\ndescription: builds\n---\nBuild it.\n");
    writeFileSync(join(projectDir, ".orchestrator", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\n---\nReview it.\n");
    const result = checkWorkflow(paths, projectDir, "outer", { tickt: "x" });
    assert.deepEqual(result.problems.sort(), [
      'MCP server "linear" is not in mcp.json',
      'no agent "nobody" (in inner). Agents live in .orchestrator/agents/ or ~/.orchestrator/agents/ as <name>.md.',
      'no saved workflow "ghost"',
      "missing input --ticket (The ticket)",
      "unknown input --tickt. This workflow takes: --ticket",
    ].sort());
    writeFileSync(join(projectDir, ".orchestrator", "mcp.json"), JSON.stringify({ linear: { command: "npx", args: ["linear-mcp"] } }));
    assert.equal(checkWorkflow(paths, projectDir, "outer").problems.some((p) => p.includes("linear")), false);
  });
});

describe("service", () => {
  it("starts a schedule once per matching minute, and skips it while its last run is unfinished", () => {
    const { paths, projectDir } = setup({ nightly: `export const meta = { name: 'nightly', description: 'n' }\nreturn 1` });
    saveSchedules(paths, [{ name: "n", workflow: join(projectDir, ".orchestrator", "workflows", "nightly.js"), projectDir, cron: "0 3 * * *", inputs: {}, enabled: true, createdAt: "" }]);
    const started: string[] = [];
    const spawn = (runId: string) => started.push(runId);
    tick(paths, { now: new Date(2026, 10, 21, 2, 59), spawn, log: quiet });
    assert.equal(started.length, 0);
    tick(paths, { now: new Date(2026, 10, 21, 3, 0, 5), spawn, log: quiet });
    tick(paths, { now: new Date(2026, 10, 21, 3, 0, 40), spawn, log: quiet });
    assert.equal(started.length, 1, "once in that minute");
    const record = loadRecord(paths, started[0]!);
    assert.equal(record?.origin, "schedule");
    assert.equal(record?.priority, "schedule");

    // The run never started, so it counts as unfinished only once the engine knows it. Mark it paused.
    const lines: string[] = [];
    const manager = managerFor(paths, projectDir);
    const persistence = manager.getPersistence() as unknown as { save?: (state: unknown) => void };
    if (typeof persistence.save === "function") {
      persistence.save({ runId: started[0], status: "paused", pauseReason: "requested", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), agents: [], logs: [], phases: [] });
      tick(paths, { now: new Date(2026, 10, 22, 3, 0), spawn, log: (line) => lines.push(line) });
      assert.equal(started.length, 1);
      assert.match(lines.join("\n"), /skipped, run .* has not finished/);
    }
  });

  it("tells the user once about a run cut off by a crash and leaves it for them to resume, while a limit pause resumes", () => {
    const { paths, projectDir } = setup({ job: `export const meta = { name: 'job', description: 'j' }\nreturn 1` });
    const cut = createRun(paths, { workflow: "job", projectDir, inputs: {} });
    const limited = createRun(paths, { workflow: "job", projectDir, inputs: {} });
    const persistence = managerFor(paths, projectDir).getPersistence() as unknown as { save: (state: unknown) => void };
    const at = new Date(2026, 10, 21, 10, 0).toISOString();
    const base = { startedAt: at, updatedAt: at, agents: [], logs: [], phases: [] };
    persistence.save({ ...base, runId: cut.runId, status: "paused", pauseReason: "interrupted" });
    persistence.save({ ...base, runId: limited.runId, status: "paused", pauseReason: "usage_limit", resetHint: "Resets at 2026-11-21T10:30:00.000Z" });
    const spawned: string[] = [];
    const told: string[] = [];
    const deps = { spawn: (runId: string) => spawned.push(runId), notify: (title: string, body: string) => told.push(`${title}: ${body}`), log: quiet };
    tick(paths, { ...deps, now: new Date("2026-11-21T11:00:00.000Z") });
    tick(paths, { ...deps, now: new Date("2026-11-21T11:05:00.000Z") });
    assert.deepEqual(spawned, [limited.runId]);
    assert.deepEqual(told, [`job was cut off: orc resume ${cut.runId} goes on from where it stopped`]);
  });
});

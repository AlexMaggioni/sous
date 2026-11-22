import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  busyWorktrees,
  createRun,
  dryRun,
  ensureHome,
  fileSchedules,
  gcWorktrees,
  homePaths,
  listQuestions,
  listRecords,
  loadRecord,
  logFile,
  rememberProject,
  saveSchedules,
  writeAnswer,
  type HomePaths,
} from "@orchestrator/engine";
// orc does not import these, so the engine entry does not export them. The tests load the
// engine's built modules by path. They are the same modules the entry loads.
import { WorkflowError, WorkflowErrorCode } from "../../engine/dist/errors.js";
import { knownProjects } from "../../engine/dist/runs/home.js";
import { updateRecord } from "../../engine/dist/runs/records.js";
import { tick } from "../../engine/dist/runs/service.js";
import { managerFor, runWorker } from "../../engine/dist/runs/worker.js";
import type { AgentRunner } from "../../engine/dist/steps/agent-runner.js";
import { checkWorkflow } from "../src/check.js";
import { main } from "../src/cli.js";

// Whole runs in this process, with a fake agent runner, the way `orc run` drives them.

// The agent lookup reads the harnesses' home folders. These tests give it empty ones.
const harnessHome = mkdtempSync(join(tmpdir(), "orc-harness-home-"));
process.env.CLAUDE_CONFIG_DIR = join(harnessHome, ".claude");
process.env.CODEX_HOME = join(harnessHome, ".codex");
process.env.XDG_CONFIG_HOME = join(harnessHome, ".config");
delete process.env.AGENTPRISM_DEFAULT_BACKEND;

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function setup(workflows: Record<string, string>, config: Record<string, unknown> = {}): { paths: HomePaths; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "orc-runs-"));
  const paths = ensureHome(homePaths(join(root, "home")));
  writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder", ...config }));
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".orchestrator", "workflows"), { recursive: true });
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
/** These tests start no worker process, so orc's cli file is never run. */
const NO_CLI = "/nonexistent/orc/cli.js";

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

  it("a run paused for a lost login says why a resume cannot start, and resumes once the person logs in again", async () => {
    const { paths, projectDir } = setup({
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
    // The stand-in for the programs knows whether its login is back.
    Object.assign(runner, { auth: { canResume: () => loggedIn } });
    const record = createRun(paths, { workflow: "login", projectDir, inputs: {} });
    await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(managerFor(paths, projectDir).getPersistence().load(record.runId)?.pauseReason, "auth_required");
    assert.deepEqual(calls.map((c) => c.label), ["first", "second"]);

    const lines: string[] = [];
    await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line) });
    assert.equal(calls.length, 2, "no step runs while the login is still gone");
    assert.match(lines.at(-1)!, /paused +login \(auth_required\): .*claude/, "the log says why the resume did not start");

    loggedIn = true;
    const done = await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(done?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), { first: "first done", second: "second done" });
    assert.deepEqual(calls.map((c) => c.label), ["first", "second", "second"], "first is not run again");
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

describe("agents and harnesses", () => {
  it("runs one rulesync agent on each harness with that harness's block, and stops a harness's own agent sent elsewhere", async () => {
    const { paths, projectDir } = setup({
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
    const record = createRun(paths, { workflow: "both", projectDir, inputs: {} });
    const result = await runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
    assert.equal(result?.status, "completed");
    const [claude, codex] = calls;
    assert.deepEqual([claude!.options.model, claude!.options.toolNames], ["claude/haiku", ["Read"]]);
    assert.deepEqual([codex!.options.model, codex!.options.toolNames], ["codex/gpt-test", undefined]);
    // Each harness gets its block's effort.
    assert.deepEqual([claude!.options.effort, codex!.options.effort], ["high", "low"]);
    assert.match(String(codex!.options.instructions), /Answer REVIEW\./);
    // orc show lists each step with its harness and model.
    const state = managerFor(paths, projectDir).getPersistence().load(record.runId);
    assert.deepEqual(state?.agents.map((step) => [step.label, step.model]), [["on claude", "claude/haiku"], ["on codex", "codex/gpt-test"]]);

    const before = calls.length;
    const wrong = createRun(paths, { workflow: "wrong", projectDir, inputs: { harness: "claude" } });
    const stopped = await runWorker(wrong.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.notEqual(stopped?.status, "completed");
    const wrongState = managerFor(paths, projectDir).getPersistence().load(wrong.runId);
    assert.match(String(wrongState?.reason), /step "fixer": agent "fixer" comes from .*fixer\.toml, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code\. Move it to rulesync/);
    assert.equal(calls.length, before, "the agent never started");
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
    const result = gcWorktrees(paths, [projectDir], { busy: busyWorktrees(paths, records) });
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

describe("the run tree", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (cwd: string, ...args: string[]) => git(cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args);

  /** Run one orc command on this home, and keep what it prints. */
  async function orc(paths: HomePaths, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const before = process.env.ORC_HOME;
    process.env.ORC_HOME = paths.home;
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
      if (before === undefined) delete process.env.ORC_HOME;
      else process.env.ORC_HOME = before;
    }
  }

  /** The step lines `orc show` prints, without their times and tokens. */
  const shownSteps = (text: string) =>
    text
      .slice(text.indexOf("steps\n") + 6)
      .split("\n")
      .filter((line, i, all) => line.startsWith("  ") && all.slice(0, i).every((l) => l.startsWith("  ")))
      .map((line) => line.replace(/\s+\(\d+s(, \d+ tokens)?\)$|\s+\(\d+ tokens\)$/, ""));

  const waitFor = async (ready: () => boolean) => {
    for (let i = 0; i < 500 && !ready(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(ready(), "timed out");
  };

  const hangUntilAborted = (call: Call) =>
    new Promise((_, reject) => (call.options.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted"))));

  it("two levels of nesting with two nested runs at once: show, the log and stop --step name each step by its path", async () => {
    const { paths, projectDir } = setup({
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
    const record = createRun(paths, { workflow: "parent", projectDir, inputs: {} });
    const file = logFile(paths, record.runId);
    const log = (line: string) => appendFileSync(file, `${line}\n`);
    const running = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log, handleSignals: true });
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

    const wrong = await orc(paths, "stop", record.runId, "--step", "checker");
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /no step named "checker" runs .*Running now: "ticket A \/ check A: checker"/);
    assert.equal((await orc(paths, "stop", record.runId, "--step", "ticket A / check A: checker")).code, 0);
    await running;
    const state = managerFor(paths, projectDir).getPersistence().load(record.runId);
    assert.equal(state?.status, "paused");
    assert.equal(state?.pauseReason, "step_stopped");

    hang = false;
    const done = await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log });
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

    const shown = await orc(paths, "show", record.runId);
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
    const { paths, projectDir } = setup(
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
    const record = createRun(paths, { workflow: "parent", projectDir, inputs: {} });
    const runId = record.runId;
    const file = logFile(paths, runId);
    const log = (line: string) => appendFileSync(file, `${line}\n`);
    const running = runWorker(runId, "start", { paths, inner: runner, pollMs: 20, log, handleSignals: true });
    await waitFor(() => calls.some((c) => c.prompt === "build A") && readFileSync(file, "utf8").includes("done       ticket B: builder"));

    // The code at 7e0547ab wrote nested entries with no parent, and no step worktrees.
    const recordJson = join(paths.records, `${runId}.json`);
    const toOldShape = () => {
      const json = JSON.parse(readFileSync(recordJson, "utf8")) as { nested: Record<string, Record<string, unknown>>; stepWorktrees?: unknown };
      for (const child of Object.values(json.nested)) delete child.parent;
      delete json.stepWorktrees;
      writeFileSync(recordJson, `${JSON.stringify(json, null, 2)}\n`);
    };
    const trees = ["nested1", "nested2"].map((n) => ({ dir: join(paths.worktrees, `${runId}-${n}`), branch: `orc/${runId}-${n}` }));
    assert.deepEqual(
      Object.entries(loadRecord(paths, runId)!.nested!).map(([id, child]) => [id, child.cwd, child.branch]).sort(),
      trees.map((tree) => [tree.branch.slice(4), tree.dir, tree.branch]),
      "the nested worktrees keep the names <run>-nested<n>",
    );
    const newShape = await orc(paths, "show", runId);
    toOldShape();
    assert.equal(loadRecord(paths, runId)!.nested![`${runId}-nested1`]!.parent, runId, "the old reader finds the parent");
    const oldShape = await orc(paths, "show", runId);
    assert.equal(oldShape.out, newShape.out);
    assert.deepEqual(shownSteps(oldShape.out), [
      "  done  triage",
      `  ticket A  (workflow child, branch ${trees[0]!.branch})`,
      "    running builder",
      `  ticket B  (workflow child, branch ${trees[1]!.branch})`,
      "    done  builder",
    ]);

    toOldShape();
    assert.equal((await orc(paths, "stop", runId, "--step", "ticket A: builder")).code, 0);
    await running;
    assert.equal(managerFor(paths, projectDir).getPersistence().load(runId)?.pauseReason, "step_stopped");
    assert.match(readFileSync(file, "utf8"), /stopping   ticket A: builder/);

    // A paused run keeps its nested worktrees, merged or not.
    git(projectDir, "merge", "-q", trees[1]!.branch);
    toOldShape();
    const paused = gcWorktrees(paths, [projectDir], { busy: busyWorktrees(paths, listRecords(paths)) });
    assert.deepEqual(paused.removed, []);
    assert.deepEqual(
      paused.kept.filter((k) => k.branch.startsWith(`orc/${runId}-nested`)).map((k) => [k.branch, k.reason]),
      trees.map((tree) => [tree.branch, "its run has not finished"]),
    );

    toOldShape();
    hang = false;
    const done = await runWorker(runId, "resume", { paths, inner: runner, pollMs: 20, log });
    assert.equal(done?.status, "completed");
    assert.deepEqual(calls.map((c) => c.prompt).sort(), ["build A", "build A", "build B", "look"]);
    assert.ok(trees.every((tree) => existsSync(join(tree.dir, `build ${tree === trees[0] ? "A" : "B"}.txt`))), "each ticket worked in its own worktree");

    // Once the run ended, gc removes each merged nested worktree.
    commit(projectDir, "merge", "-q", "--no-edit", trees[0]!.branch);
    toOldShape();
    const ended = gcWorktrees(paths, [projectDir], { busy: busyWorktrees(paths, listRecords(paths)) });
    assert.deepEqual(
      ended.removed.filter((r) => r.branch.startsWith(`orc/${runId}-nested`)).map((r) => [r.branch, r.reason]),
      trees.map((tree) => [tree.branch, "merged"]),
    );
    assert.ok(trees.every((tree) => !existsSync(tree.dir)));
  });
});

describe("check", () => {
  it("finds missing workflows, agents and MCP servers, and agents sent to a harness they can't run on", () => {
    const { paths, projectDir } = setup({
      outer: `export const meta = { name: 'outer', description: 'nests', inputs: { ticket: 'The ticket', harness: { type: 'string', description: 'The harness', default: 'claude' } } }
await workflow('inner', {})
await workflow('ghost', {})
await agent('x', { agentType: 'implementer', mcp: ['linear'] })
await agent('y', { agentType: 'reviewer', model: 'codex' })
await agent('w', { agentType: 'fixer', model: 'claude/haiku' })
await agent('v', { agentType: 'fixer', model: args.harness })`,
      inner: `export const meta = { name: 'inner', description: 'inner' }
await agent('z', { agentType: 'nobody' })`,
    });
    write(join(projectDir, ".rulesync", "subagents", "implementer.md"), "---\nname: implementer\ndescription: builds\n---\nBuild it.\n");
    write(join(projectDir, ".rulesync", "subagents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\ncodexcli:\n  model: gpt-test\n---\nReview it.\n");
    write(join(projectDir, ".codex", "agents", "fixer.toml"), 'name = "fixer"\ndescription = "fixes"\ndeveloper_instructions = "Fix it."\n');
    const result = checkWorkflow(paths, projectDir, "outer", { tickt: "x" });
    const expected = [
      /^no MCP server "linear" for Claude Code\. orc looks in .*Add it to \.rulesync\/mcp\.jsonc\.$/,
      /^agent "fixer" comes from .*\/\.codex\/agents\/fixer\.toml, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code\. Move it to rulesync, as \.rulesync\/subagents\/fixer\.md/,
      /^in inner: no agent "nobody"\. orc looks in \.rulesync\/subagents\/, then the global rulesync folder/,
      /^no saved workflow "ghost"$/,
      /^missing input --ticket \(The ticket\)$/,
      /^unknown input --tickt\. This workflow takes: --ticket, --harness$/,
    ];
    assert.equal(result.problems.length, expected.length, result.problems.join("\n"));
    for (const pattern of expected) assert.ok(result.problems.some((p) => pattern.test(p)), `${pattern} in:\n${result.problems.join("\n")}`);
    assert.ok(result.notes.some((n) => /a step with agent "fixer" picks its harness while running\. The agent comes from .*fixer\.toml, so the step stops on any harness but Codex\./.test(n)));
    write(join(projectDir, ".rulesync", "mcp.jsonc"), `{ "mcpServers": { "linear": { "command": "npx", "args": ["linear-mcp"] } } }`);
    assert.equal(checkWorkflow(paths, projectDir, "outer").problems.some((p) => p.includes("linear")), false);
  });

  it("refuses a step model or a default that names Pi or OpenCode, which orc no longer runs", () => {
    const { paths, projectDir } = setup({
      gone: `export const meta = { name: 'gone', description: 'old harnesses' }
await agent('a', { model: 'pi/gpt-test' })
await agent('b', { model: "opencode/big" })
await agent('c', { model: 'claude/haiku' })`,
    }, { defaultHarness: "opencode", defaultModel: "pi/gpt-test" });
    const problems = checkWorkflow(paths, projectDir, "gone").problems;
    const expected = [
      /^model "pi\/gpt-test" names the harness "pi", which orc no longer runs\. Use one of claude, codex\.$/,
      /^model "opencode\/big" names the harness "opencode", which orc no longer runs\. Use one of claude, codex\.$/,
      /^the configured default harness "opencode" is not one orc runs\. Use one of claude, codex\.$/,
      /^the configured default model "pi\/gpt-test" names the harness "pi"/,
    ];
    assert.equal(problems.length, expected.length, problems.join("\n"));
    for (const pattern of expected) assert.ok(problems.some((p) => pattern.test(p)), `${pattern} in:\n${problems.join("\n")}`);
  });

  // Until step 4, check found names with regular expressions over the script text. It reads them
  // from the parsed script now. Each test below is a script where the two differ, and says how.
  describe("reads names from the parsed script", () => {
    const check = (body: string, withFixer = false) => {
      const { paths, projectDir } = setup({ diff: `export const meta = { name: 'diff', description: 'd' }\n${body}\nreturn 1` });
      if (withFixer) write(join(projectDir, ".codex", "agents", "fixer.toml"), 'name = "fixer"\ndescription = "fixes"\ndeveloper_instructions = "Fix it."\n');
      const result = checkWorkflow(paths, projectDir, "diff");
      return { problems: result.problems, notes: result.notes.filter((note) => note !== "declares no inputs, so it takes any") };
    };
    const fromCodex = /^agent "fixer" comes from .*\/\.codex\/agents\/fixer\.toml, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code\./;

    it("skips names in comments and in the text of strings, which the text scan read", () => {
      const result = check(`// await workflow('ghost', {})
/* await agent('a', { model: 'pi/gpt-test' }) */
const text = "run('missing.sh')"`);
      assert.deepEqual(result, { problems: [], notes: [] });
    });

    it("skips workflow() and run() called on an object, which the text scan read as the global ones", () => {
      const result = check(`const tools = { workflow: async () => 1, run: async () => 2 }
await tools.workflow('ghost', {})
await tools.run('missing.sh')`);
      assert.deepEqual(result, { problems: [], notes: [] });
    });

    it("reads a quoted key, which the text scan missed", () => {
      const result = check(`await agent('a', { "model": "pi/gpt-test" })`);
      assert.deepEqual(result, { problems: ['model "pi/gpt-test" names the harness "pi", which orc no longer runs. Use one of claude, codex.'], notes: [] });
    });

    it("reads a template string with nothing in it to fill, which the text scan missed", () => {
      // The text scan found no workflow here, and read the model as one picked while running.
      const result = check("await workflow(`ghost`, {})\nawait agent('a', { agentType: 'fixer', model: `claude/haiku` })", true);
      assert.equal(result.problems.length, 2, result.problems.join("\n"));
      assert.equal(result.problems[0], 'no saved workflow "ghost"');
      assert.match(result.problems[1]!, fromCodex);
      assert.deepEqual(result.notes, []);
    });

    it("reads a shorthand model as a model picked while running, which the text scan missed", () => {
      const result = check(`const model = args.harness
await agent('a', { agentType: 'fixer', model })`, true);
      assert.deepEqual(result.problems, []);
      assert.equal(result.notes.length, 1, result.notes.join("\n"));
      assert.match(result.notes[0]!, /^a step with agent "fixer" picks its harness while running\. The agent comes from .*fixer\.toml, so the step stops on any harness but Codex\.$/);
    });

    it("reads a step's own keys only, where the text scan also read the objects inside it", () => {
      // The text scan took the inner model as the step's, so it sent fixer to Claude Code.
      const result = check(`await agent('a', { agentType: 'fixer', extra: { model: 'claude/haiku' } })`, true);
      assert.deepEqual(result, { problems: [], notes: [] });
      assert.match(check(`await agent('a', { agentType: 'fixer', model: 'claude/haiku' })`, true).problems.join("\n"), fromCodex);
    });

    it("finds any: true after a parenthesis in choose(), which the text scan missed", () => {
      const result = check(`await choose('pick one (or none)', { any: true })`);
      assert.deepEqual(result, { problems: [], notes: ["an agent may pick any saved workflow"] });
    });
  });
});

describe("service", () => {
  it("starts a schedule once per matching minute, and skips it while its last run is unfinished", () => {
    const { paths, projectDir } = setup({ nightly: `export const meta = { name: 'nightly', description: 'n' }\nreturn 1` });
    saveSchedules(paths, [{ name: "n", workflow: join(projectDir, ".orchestrator", "workflows", "nightly.js"), projectDir, cron: "0 3 * * *", inputs: {}, enabled: true, createdAt: "" }]);
    const started: string[] = [];
    const spawn = (runId: string) => started.push(runId);
    tick(paths, NO_CLI, { now: new Date(2026, 10, 21, 2, 59), spawn, log: quiet });
    assert.equal(started.length, 0);
    tick(paths, NO_CLI, { now: new Date(2026, 10, 21, 3, 0, 5), spawn, log: quiet });
    tick(paths, NO_CLI, { now: new Date(2026, 10, 21, 3, 0, 40), spawn, log: quiet });
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
      tick(paths, NO_CLI, { now: new Date(2026, 10, 22, 3, 0), spawn, log: (line) => lines.push(line) });
      assert.equal(started.length, 1);
      assert.match(lines.join("\n"), /skipped, run .* has not finished/);
    }
  });

  it("starts a workflow on the cron in its meta, once orc has run in its project", () => {
    const nightly = `export const meta = { name: 'nightly', description: 'n', inputs: { who: 'Who' }, schedule: { cron: '0 3 * * *', inputs: { who: 'night' } } }\nreturn args.who`;
    const { paths, projectDir } = setup({ nightly, hand: `export const meta = { name: 'hand', description: 'h' }\nreturn 1` });
    const file = join(projectDir, ".orchestrator", "workflows", "nightly.js");
    const started: string[] = [];
    const spawn = (runId: string) => started.push(runId);
    tick(paths, NO_CLI, { now: new Date(2026, 10, 21, 3, 0), spawn, log: quiet });
    assert.equal(started.length, 0, "the service does not know the project yet");

    createRun(paths, { workflow: "hand", projectDir, inputs: {} });
    assert.deepEqual(knownProjects(paths), [projectDir]);
    assert.deepEqual(fileSchedules(paths).map((schedule) => [schedule.name, schedule.cron]), [[file, "0 3 * * *"]]);
    tick(paths, NO_CLI, { now: new Date(2026, 10, 22, 2, 59), spawn, log: quiet });
    tick(paths, NO_CLI, { now: new Date(2026, 10, 22, 3, 0, 5), spawn, log: quiet });
    tick(paths, NO_CLI, { now: new Date(2026, 10, 22, 3, 0, 40), spawn, log: quiet });
    assert.equal(started.length, 1, "once in that minute");
    const record = loadRecord(paths, started[0]!);
    assert.equal(record?.origin, "schedule");
    assert.equal(record?.schedule, file);
    assert.deepEqual(record?.args, { who: "night" });
    assert.equal(checkWorkflow(paths, projectDir, "nightly").notes.some((note) => note.startsWith('the service starts it at "0 3 * * *"')), true);
  });

  it("refuses a bad schedule in the meta, and runs a home workflow's schedule in a scratch folder", () => {
    const { paths, projectDir } = setup({
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
    tick(paths, NO_CLI, { now: new Date(2026, 10, 22, 0, 0), spawn: (runId: string) => started.push(runId), log: quiet });
    assert.equal(started.length, 1);
    const record = loadRecord(paths, started[0]!);
    assert.equal(record?.place, "none");
    assert.equal(record?.projectDir, paths.home);
    assert.equal(record?.cwd, join(paths.scratch, record!.runId));
  });

  it("tells the user once about a run cut off by a crash and leaves it for them to resume, while a limit pause resumes", () => {
    const { paths, projectDir } = setup({ job: `export const meta = { name: 'job', description: 'j' }\nreturn 1` });
    const cut = createRun(paths, { workflow: "job", projectDir, inputs: {} });
    const limited = createRun(paths, { workflow: "job", projectDir, inputs: {} });
    const persistence = managerFor(paths, projectDir).getPersistence() as unknown as { save: (state: unknown) => void };
    const at = new Date(2026, 10, 21, 10, 0).toISOString();
    const base = { startedAt: at, updatedAt: at, agents: [], logs: [], phases: [] };
    persistence.save({ ...base, runId: cut.runId, status: "paused", pauseReason: "interrupted" });
    // A real paused state keeps its script, and the service resumes only when the file still matches it.
    persistence.save({ ...base, runId: limited.runId, status: "paused", pauseReason: "usage_limit", resetHint: "Resets at 2026-11-21T10:30:00.000Z", script: readFileSync(limited.file, "utf8") });
    const spawned: string[] = [];
    const told: string[] = [];
    const deps = { spawn: (runId: string) => spawned.push(runId), notify: (title: string, body: string) => told.push(`${title}: ${body}`), log: quiet };
    tick(paths, NO_CLI, { ...deps, now: new Date("2026-11-21T11:00:00.000Z") });
    tick(paths, NO_CLI, { ...deps, now: new Date("2026-11-21T11:05:00.000Z") });
    assert.deepEqual(spawned, [limited.runId]);
    assert.deepEqual(told, [`job was cut off: orc resume ${cut.runId} goes on from where it stopped`]);
  });
});

describe("dry runs", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const gitProject = (workflows: Record<string, string>) => {
    const made = setup(workflows, { defaultPlace: "folder" });
    git(made.projectDir, "init", "-q", "-b", "main");
    git(made.projectDir, "add", "-A");
    git(made.projectDir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "start");
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
    assert.equal(git(projectDir, "branch", "--list", "orc/*"), "");
    assert.equal(listQuestions(paths).length, 0);
    // The engine keeps a small note that the run was deleted, and nothing else.
    const left = (readdirSync(paths.home, { recursive: true }) as string[]).filter((name) => name.includes(dry.runId) && !name.endsWith(".lineage"));
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

  it("orc check --dry-run prints the run and exits 0 when it completes", async () => {
    const { paths, projectDir } = gitProject({ review });
    const printed: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    // The test runner reports through stdout too, so every chunk still goes out.
    process.stdout.write = ((chunk: string) => {
      printed.push(String(chunk));
      return write(chunk);
    }) as typeof process.stdout.write;
    const home = process.env.ORC_HOME;
    process.env.ORC_HOME = paths.home;
    try {
      assert.equal(await main(["check", "review", "--dry-run", "--project", projectDir]), 0);
    } finally {
      process.stdout.write = write;
      if (home === undefined) delete process.env.ORC_HOME;
      else process.env.ORC_HOME = home;
    }
    const text = printed.join("");
    assert.match(text, /dry run completed, with 2 agent steps answered by stand-ins/);
    assert.match(text, /"rounds": 1/);
  });
});

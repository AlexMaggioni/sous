import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { ensureHome, homePaths, runQuestions, type HomePaths } from "@orchestrator/engine";
// orc does not import these, so the engine entry does not export them. The tests load the
// engine's built modules by path. They are the same modules the entry loads.
import { WorkflowError, WorkflowErrorCode } from "../../engine/dist/errors.js";
import { writeAnswer } from "../../engine/dist/runs/inbox.js";
import { createRun } from "../../engine/dist/runs/launch.js";
import { workflowProjectPaths } from "../../engine/dist/runs/persistence/project-paths.js";
import { updateRecord } from "../../engine/dist/runs/records.js";
import { readState } from "../../engine/dist/runs/store.js";
import { runWorker } from "../../engine/dist/runs/worker.js";
import type { AgentRunner } from "../../engine/dist/steps/agent-runner.js";
import { main } from "../src/cli.js";

// Which steps run again when a run resumes. Each test pauses a run with a fake agent, resumes it,
// and checks the prompts the fake gets on the resume. A failed step, `orc stop --step` and the
// time limit each rerun only their step: runs.test.ts pins those three.

// The agent lookup reads the harnesses' home folders. These tests give it empty ones.
const harnessHome = mkdtempSync(join(tmpdir(), "orc-harness-home-"));
process.env.CLAUDE_CONFIG_DIR = join(harnessHome, ".claude");
process.env.CODEX_HOME = join(harnessHome, ".codex");
process.env.XDG_CONFIG_HOME = join(harnessHome, ".config");
delete process.env.AGENTPRISM_DEFAULT_BACKEND;

function setup(workflows: Record<string, string>): { paths: HomePaths; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "orc-resume-"));
  const paths = ensureHome(homePaths(join(root, "home")));
  writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder", retries: 0 }));
  const projectDir = join(root, "project");
  for (const [name, script] of Object.entries(workflows)) edit(projectDir, name, script);
  return { paths, projectDir };
}

function edit(projectDir: string, name: string, script: string): void {
  const file = join(projectDir, ".orchestrator", "workflows", `${name}.js`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, script);
}

interface Call {
  prompt: string;
  options: Record<string, unknown>;
}

/** A fake agent that answers "<prompt> done". `fail` picks the prompts that fail. B is slow, so a
 *  parallel sibling of B ends first. */
function fake(fail: (prompt: string) => Error | undefined = () => undefined): { runner: AgentRunner; calls: Call[]; since: (n: number) => string[] } {
  const calls: Call[] = [];
  const runner = {
    async run(prompt: string, options: Record<string, unknown> = {}) {
      calls.push({ prompt, options });
      if (prompt === "B") await new Promise((r) => setTimeout(r, 80));
      (options.onSessionOpen as ((ref: unknown) => void) | undefined)?.({ sessionId: `s${calls.length}`, backendId: "claude", cwd: options.cwd, reopen: { load: true, resume: true, list: true } });
      const error = fail(prompt);
      if (error) throw error;
      return `${prompt} done`;
    },
  } as unknown as AgentRunner;
  return { runner, calls, since: (n) => calls.slice(n).map((call) => call.prompt) };
}

const boom = () => new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
const quiet = () => {};
const start = (paths: HomePaths, runId: string, runner: AgentRunner, handleSignals = false) =>
  runWorker(runId, "start", { paths, inner: runner, pollMs: 20, log: quiet, handleSignals });
const resume = (paths: HomePaths, runId: string, runner: AgentRunner) => runWorker(runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });

/** Answer the run's questions until `done` holds, and return the prompts it asked. */
async function answerUntil(paths: HomePaths, runId: string, reply: unknown, done: () => boolean): Promise<string[]> {
  const asked: string[] = [];
  while (!done()) {
    for (const question of runQuestions(paths, runId)) {
      asked.push(question.prompt);
      writeAnswer(paths, question, reply);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return asked;
}

/** Run orc on this home, and drop what it prints. */
async function orc(paths: HomePaths, argv: string[]): Promise<number> {
  const before = process.env.ORC_HOME;
  process.env.ORC_HOME = paths.home;
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await main(argv);
  } finally {
    process.stdout.write = write;
    if (before === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = before;
  }
}

const three = (a: string, b = "B", c = "C") => `export const meta = { name: 'three', description: 'three steps' }
const a = await agent('${a}', { label: 'a' })
const b = await agent('${b}', { label: 'b' })
const c = await agent('${c}', { label: 'c' })
return [a, b, c]`;

const child = (x: string) => `export const meta = { name: 'child', description: 'two steps' }
const x = await agent('${x}', { label: 'x' })
const y = await agent('Y', { label: 'y' })
return [x, y]`;

const parent = (a: string) => `export const meta = { name: 'parent', description: 'a nested workflow' }
const a = await agent('${a}', { label: 'a' })
const n = await workflow('child', {})
const c = await agent('C', { label: 'c' })
return [a, n, c]`;

const par = (comment = "") => `export const meta = { name: 'par', description: 'parallel' }${comment}
const a = await agent('A', { label: 'a' })
const [b, c] = await parallel([() => agent('B', { label: 'b' }), () => agent('C', { label: 'c' })])
const d = await agent('D', { label: 'd' })
return [a, b, c, d]`;

const asks = (a: string) => `export const meta = { name: 'asks', description: 'asks' }
const a = await agent('${a}', { label: 'a' })
const name = await checkpoint('Name it', { kind: 'input' })
return await agent('Build ' + name, { label: 'build' })`;

/** Pause `three` with C failed, edit it, and resume it with --latest. Returns the prompts of the resume. */
async function latest(edited: string, before?: (paths: HomePaths, runId: string) => void) {
  const { paths, projectDir } = setup({ three: three("A") });
  let broken = true;
  const { runner, since } = fake((prompt) => (broken && prompt === "C" ? boom() : undefined));
  const record = createRun(paths, { workflow: "three", projectDir, inputs: {} });
  assert.equal((await start(paths, record.runId, runner))?.status, "paused");
  before?.(paths, record.runId);
  edit(projectDir, "three", edited);
  updateRecord(paths, record.runId, { resumeLatest: true });
  broken = false;
  const done = await resume(paths, record.runId, runner);
  assert.equal(done?.status, "completed");
  return { live: since(3), done, state: readState(paths, record.runId)! };
}

describe("resume", () => {
  it("keeps a parallel sibling that finished after the failed step", async () => {
    const { paths, projectDir } = setup({
      par: `export const meta = { name: 'par', description: 'parallel' }
const a = await agent('A', { label: 'a' })
const [b, c] = await parallel([() => agent('B', { label: 'b' }), () => agent('C', { label: 'c' })])
const d = await agent('D', { label: 'd' })
return [a, b, c, d]`,
    });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt === "B" ? boom() : undefined));
    const record = createRun(paths, { workflow: "par", projectDir, inputs: {} });
    assert.equal((await start(paths, record.runId, runner))?.status, "paused");
    assert.deepEqual(since(0), ["A", "B", "C"]);
    broken = false;
    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(3), ["B", "D"]);
  });

  it("replays a loop of identical steps", async () => {
    const { paths, projectDir } = setup({
      loop: `export const meta = { name: 'loop', description: 'a loop' }
const out = []
for (let i = 0; i < 3; i++) out.push(await agent('check', { label: 'check' }))
out.push(await agent('L', { label: 'last' }))
return out`,
    });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt === "L" ? boom() : undefined));
    const record = createRun(paths, { workflow: "loop", projectDir, inputs: {} });
    await start(paths, record.runId, runner);
    broken = false;
    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(4), ["L"]);
  });

  it("replays the steps of a nested workflow", async () => {
    const { paths, projectDir } = setup({ child: child("X"), parent: parent("A") });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt === "C" ? boom() : undefined));
    const record = createRun(paths, { workflow: "parent", projectDir, inputs: {} });
    await start(paths, record.runId, runner);
    assert.deepEqual(since(0), ["A", "X", "Y", "C"]);
    broken = false;
    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(4), ["C"]);
  });

  it("with --latest and only a nested step edited, runs the edited step and the failed one", async () => {
    const { paths, projectDir } = setup({ child: child("X"), parent: parent("A") });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt === "C" ? boom() : undefined));
    const record = createRun(paths, { workflow: "parent", projectDir, inputs: {} });
    await start(paths, record.runId, runner);
    edit(projectDir, "child", child("X2"));
    updateRecord(paths, record.runId, { resumeLatest: true });
    broken = false;
    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(4), ["X2", "C"]);
  });

  it("with --latest and a root step edited, keeps the nested workflow's steps", async () => {
    const { paths, projectDir } = setup({ child: child("X"), parent: parent("A") });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt === "C" ? boom() : undefined));
    const record = createRun(paths, { workflow: "parent", projectDir, inputs: {} });
    await start(paths, record.runId, runner);
    edit(projectDir, "parent", parent("A2"));
    updateRecord(paths, record.runId, { resumeLatest: true });
    broken = false;
    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(4), ["A2", "C"]);
  });

  it("without --latest, goes on with the version the run started with", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt === "C" ? boom() : undefined));
    const record = createRun(paths, { workflow: "three", projectDir, inputs: {} });
    await start(paths, record.runId, runner);
    edit(projectDir, "three", three("A2"));
    broken = false;
    // `orc resume --same` starts the worker with no resumeLatest, as here.
    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(3), ["C"]);
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), ["A done", "B done", "C done"]);
  });

  it("replays an answered question, and asks no new one", async () => {
    const { paths, projectDir } = setup({
      asks: `export const meta = { name: 'asks', description: 'asks' }
const a = await agent('A', { label: 'a' })
const name = await checkpoint('Name it', { kind: 'input' })
return await agent('Build ' + name, { label: 'build' })`,
    });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt.startsWith("Build") ? boom() : undefined));
    const record = createRun(paths, { workflow: "asks", projectDir, inputs: {} });
    let ended = false;
    const answering = answerUntil(paths, record.runId, "orc", () => ended);
    const paused = await start(paths, record.runId, runner);
    ended = true;
    assert.deepEqual(await answering, ["Name it"]);
    assert.equal(paused?.status, "paused");

    broken = false;
    ended = false;
    const again = answerUntil(paths, record.runId, "other", () => ended);
    const done = await resume(paths, record.runId, runner);
    ended = true;
    assert.deepEqual(await again, [], "no question is asked again");
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(2), ["Build orc"]);
  });

  it("takes an answer given while the run waited, by the question's id", async () => {
    const { paths, projectDir } = setup({
      asks: `export const meta = { name: 'asks', description: 'asks' }
const a = await agent('A', { label: 'a' })
const name = await checkpoint('Name it', { kind: 'input' })
return await agent('Build ' + name, { label: 'build' })`,
    });
    const { runner, since } = fake();
    const record = createRun(paths, { workflow: "asks", projectDir, inputs: {} });
    const running = start(paths, record.runId, runner, true);
    for (let i = 0; i < 500 && runQuestions(paths, record.runId).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const [question] = runQuestions(paths, record.runId);
    assert.equal(question?.id, `${record.runId}--1`);

    assert.equal(await orc(paths, ["pause", record.runId]), 0);
    assert.equal((await running)?.status, "paused");
    assert.deepEqual(runQuestions(paths, record.runId).map((q) => q.id), [question!.id], "the question waits while the run is paused");
    writeAnswer(paths, question!, "orc");

    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(1), ["Build orc"]);
    assert.deepEqual(runQuestions(paths, record.runId), []);
  });

  it("at a usage limit, goes on in the failed step's session", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    let limited = true;
    const { runner, calls, since } = fake((prompt) =>
      limited && prompt === "B" ? new WorkflowError("You've hit your limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false }) : undefined,
    );
    const record = createRun(paths, { workflow: "three", projectDir, inputs: {} });
    await start(paths, record.runId, runner);
    assert.equal(readState(paths, record.runId)?.pauseReason, "usage_limit");
    assert.deepEqual(since(0), ["A", "B"]);

    limited = false;
    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(2), ["B", "C"]);
    assert.equal((calls[2]!.options.continueFromSession as { sessionId?: string } | undefined)?.sessionId, "s2", "B goes on in its own session");
    assert.equal(calls[3]!.options.continueFromSession, undefined);
  });

  it("resumes a paused reuse run with its source's later steps", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt === "B2" ? boom() : undefined));
    const first = createRun(paths, { workflow: "three", projectDir, inputs: {} });
    assert.equal((await start(paths, first.runId, runner))?.status, "completed");
    edit(projectDir, "three", three("A", "B2"));
    const again = createRun(paths, { workflow: "three", projectDir, inputs: {}, reuseFrom: first });
    assert.equal((await start(paths, again.runId, runner))?.status, "paused");
    assert.deepEqual(since(3), ["B2"]);

    broken = false;
    const done = await resume(paths, again.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(4), ["B2"], "C replays from the source");
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), ["A done", "B2 done", "C done"]);
    assert.equal(readState(paths, again.runId)?.resumeSeed, undefined, "a completed run keeps no seed");
  });

  it("without --latest, replays a step whose inputs hash changed", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt === "C" ? boom() : undefined));
    const record = createRun(paths, { workflow: "three", projectDir, inputs: {} });
    await start(paths, record.runId, runner);
    // A hand edit stands in for any change that moves only the inputs hash of A.
    const state = readState(paths, record.runId)!;
    const rowA = state.calls!.find((call) => call.label === "a")!;
    rowA.inputsHash = "0".repeat(64);
    const { runsDir } = workflowProjectPaths(paths.home, { persistenceRoot: paths.runs });
    writeFileSync(join(runsDir, `${record.runId}.json`), JSON.stringify(state, null, 2));

    broken = false;
    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(3), ["C"]);
  });

  it("with --latest and step 1 edited, keeps the steps after it", async () => {
    const { live, done, state } = await latest(three("A2"));
    assert.deepEqual(live, ["A2", "C"]);
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), ["A2 done", "B done", "C done"]);
    assert.equal(state.resumeReport?.strategy, "occurrence-v1");
    assert.equal(state.replayEligibility?.strategy, "occurrence-v1");
    assert.deepEqual(
      state.resumeReport?.calls.map((call) => [call.index, call.action, call.match ?? call.reason]),
      [[0, "live", "not-recorded"], [1, "replayed", "occurrence"], [2, "live", "not-recorded"]],
    );
  });

  it("with --latest and a step inserted first, keeps the steps after it", async () => {
    const inserted = three("A").replace("const a =", "const z = await agent('Z', { label: 'z' })\nconst a =");
    const { live } = await latest(inserted);
    assert.deepEqual(live, ["Z", "C"]);
  });

  it("with --latest and a comment-only edit, keeps a parallel sibling that finished after the failed step", async () => {
    const { paths, projectDir } = setup({ par: par() });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt === "B" ? boom() : undefined));
    const record = createRun(paths, { workflow: "par", projectDir, inputs: {} });
    assert.equal((await start(paths, record.runId, runner))?.status, "paused");
    edit(projectDir, "par", par("\n// a comment"));
    updateRecord(paths, record.runId, { resumeLatest: true });
    broken = false;
    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(3), ["B", "D"]);
  });

  it("with --latest, replays a question answered after the edited step", async () => {
    const { paths, projectDir } = setup({ asks: asks("A") });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt.startsWith("Build") ? boom() : undefined));
    const record = createRun(paths, { workflow: "asks", projectDir, inputs: {} });
    let ended = false;
    const answering = answerUntil(paths, record.runId, "orc", () => ended);
    assert.equal((await start(paths, record.runId, runner))?.status, "paused");
    ended = true;
    assert.deepEqual(await answering, ["Name it"]);

    edit(projectDir, "asks", asks("A2"));
    updateRecord(paths, record.runId, { resumeLatest: true });
    broken = false;
    ended = false;
    const again = answerUntil(paths, record.runId, "other", () => ended);
    const done = await resume(paths, record.runId, runner);
    ended = true;
    assert.deepEqual(await again, [], "no question is asked again");
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(2), ["A2", "Build orc"]);
  });

  it("with --latest, runs a step whose inputs hash changed", async () => {
    const { live } = await latest(`${three("A")}\n// a comment`, (paths, runId) => {
      // A hand edit stands in for any change that moves only the inputs hash of A.
      const state = readState(paths, runId)!;
      state.calls!.find((call) => call.label === "a")!.inputsHash = "0".repeat(64);
      const { runsDir } = workflowProjectPaths(paths.home, { persistenceRoot: paths.runs });
      writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify(state, null, 2));
    });
    assert.deepEqual(live, ["A", "C"]);
  });

  it("with --latest and a step inserted first, goes on in the session of the step at the usage limit", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    let limited = true;
    const { runner, calls, since } = fake((prompt) =>
      limited && prompt === "B" ? new WorkflowError("You've hit your limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false }) : undefined,
    );
    const record = createRun(paths, { workflow: "three", projectDir, inputs: {} });
    await start(paths, record.runId, runner);
    assert.equal(readState(paths, record.runId)?.pauseReason, "usage_limit");
    edit(projectDir, "three", three("A").replace("const a =", "const z = await agent('Z', { label: 'z' })\nconst a ="));
    updateRecord(paths, record.runId, { resumeLatest: true });

    limited = false;
    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(2), ["Z", "B", "C"]);
    assert.equal(calls[2]!.options.continueFromSession, undefined);
    assert.equal((calls[3]!.options.continueFromSession as { sessionId?: string } | undefined)?.sessionId, "s2", "B goes on in its own session");
  });

  it("with --latest, keeps the steps it has not reached when it pauses again", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    const broken = new Set(["C"]);
    const { runner, since } = fake((prompt) => (broken.has(prompt) ? boom() : undefined));
    const record = createRun(paths, { workflow: "three", projectDir, inputs: {} });
    assert.equal((await start(paths, record.runId, runner))?.status, "paused");
    edit(projectDir, "three", three("A2"));
    updateRecord(paths, record.runId, { resumeLatest: true });
    broken.add("A2");
    await resume(paths, record.runId, runner);
    assert.equal(readState(paths, record.runId)?.status, "paused");
    assert.deepEqual(since(3), ["A2"]);

    broken.clear();
    const done = await resume(paths, record.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(4), ["A2", "C"], "B replays from the first version");
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), ["A2 done", "B done", "C done"]);
  });

  it("reuses the steps of a resumed run after an edited first step", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    let broken = true;
    const { runner, since } = fake((prompt) => (broken && prompt === "C" ? boom() : undefined));
    const first = createRun(paths, { workflow: "three", projectDir, inputs: {} });
    assert.equal((await start(paths, first.runId, runner))?.status, "paused");
    broken = false;
    assert.equal((await resume(paths, first.runId, runner))?.status, "completed");
    assert.deepEqual(since(3), ["C"]);

    edit(projectDir, "three", three("A2"));
    const again = createRun(paths, { workflow: "three", projectDir, inputs: {}, reuseFrom: first });
    const done = await start(paths, again.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(4), ["A2"]);
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), ["A2 done", "B done", "C done"]);
    const state = readState(paths, again.runId)!;
    assert.equal(state.resumeReport?.strategy, "occurrence-v1");
    assert.equal(state.replayEligibility?.strategy, "occurrence-v1");
    assert.deepEqual(
      state.resumeReport?.calls.map((call) => [call.index, call.action, call.match ?? call.reason]),
      [[0, "live", "not-recorded"], [1, "replayed", "occurrence"], [2, "replayed", "occurrence"]],
    );
  });

  it("reuses the steps of a nested workflow", async () => {
    const { paths, projectDir } = setup({ child: child("X"), parent: parent("A") });
    const { runner, since } = fake();
    const first = createRun(paths, { workflow: "parent", projectDir, inputs: {} });
    assert.equal((await start(paths, first.runId, runner))?.status, "completed");
    assert.deepEqual(since(0), ["A", "X", "Y", "C"]);

    edit(projectDir, "parent", parent("A").replace("agent('C'", "agent('C2'"));
    const again = createRun(paths, { workflow: "parent", projectDir, inputs: {}, reuseFrom: first });
    const done = await start(paths, again.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(4), ["C2"]);
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), ["A done", ["X done", "Y done"], "C2 done"]);
  });

  it("reuses a loop of identical steps", async () => {
    const loop = (last: string) => `export const meta = { name: 'loop', description: 'a loop' }
const out = []
for (let i = 0; i < 3; i++) out.push(await agent('check', { label: 'check' }))
out.push(await agent('${last}', { label: 'last' }))
return out`;
    const { paths, projectDir } = setup({ loop: loop("L") });
    const { runner, since } = fake();
    const first = createRun(paths, { workflow: "loop", projectDir, inputs: {} });
    assert.equal((await start(paths, first.runId, runner))?.status, "completed");
    assert.deepEqual(since(0), ["check", "check", "check", "L"]);

    edit(projectDir, "loop", loop("L2"));
    const again = createRun(paths, { workflow: "loop", projectDir, inputs: {}, reuseFrom: first });
    const done = await start(paths, again.runId, runner);
    assert.equal(done?.status, "completed");
    assert.deepEqual(since(4), ["L2"]);
  });
});

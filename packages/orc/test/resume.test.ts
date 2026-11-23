import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { rerunRun, resumeRun, runQuestions, startRun, type HomePaths, type RunRecord } from "@orchestrator/engine";
import { fakeRunner, inProcess, plantState, readState, testHome, writeAnswer, WorkflowError, WorkflowErrorCode } from "@orchestrator/engine/testing";
import { orc } from "./orc.js";

// Which steps run again when a run resumes. Each test pauses a run with a fake agent, resumes it
// as `orc resume` does, and checks the prompts the fake gets on the resume. A failed step,
// `orc stop --step` and the time limit each rerun only their step: runs.test.ts pins those three.

// The agent lookup reads the harnesses' home folders. These tests give it empty ones.
const harnessHome = mkdtempSync(join(tmpdir(), "orc-harness-home-"));
process.env.CLAUDE_CONFIG_DIR = join(harnessHome, ".claude");
process.env.CODEX_HOME = join(harnessHome, ".codex");
process.env.XDG_CONFIG_HOME = join(harnessHome, ".config");
delete process.env.AGENTPRISM_DEFAULT_BACKEND;

const setup = (workflows: Record<string, string>) => testHome(workflows, { retries: 0 });

function edit(projectDir: string, name: string, script: string): void {
  writeFileSync(join(projectDir, ".orchestrator", "workflows", `${name}.js`), script);
}

/** A fake agent that answers "<prompt> done", and the workers it runs in. `fail` picks the
 *  prompts that fail. B is slow, so a parallel sibling of B ends first. */
function fake(fail: (prompt: string) => Error | undefined = () => undefined, handleSignals = false) {
  const { runner, calls } = fakeRunner(async (call) => {
    if (call.prompt === "B") await new Promise((r) => setTimeout(r, 80));
    const error = fail(call.prompt);
    if (error) throw error;
    return `${call.prompt} done`;
  });
  const workers = inProcess({ inner: runner, handleSignals });
  return { calls, launch: workers.launch, ended: workers.ended, since: (n: number) => calls.slice(n).map((call) => call.prompt) };
}

type Fake = ReturnType<typeof fake>;

const boom = () => new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });

/** Start the workflow as `orc run` does. `agent.ended` gives the worker's result. */
const start = (paths: HomePaths, projectDir: string, workflow: string, agent: Fake) => startRun(paths, agent.launch, { workflow, projectDir, inputs: {} });

/** Resume the run as `orc resume` does, with --latest or --same when given, and wait for its worker. */
function resume(paths: HomePaths, runId: string, agent: Fake, choice?: "latest" | "same") {
  resumeRun(paths, agent.launch, runId, choice);
  return agent.ended(runId);
}

/** Run it again as `orc rerun --reuse` does. `agent.ended` gives the new run's result. */
const reuse = (paths: HomePaths, first: RunRecord, agent: Fake) => rerunRun(paths, agent.launch, first.runId, { place: first.place, reuse: true });

/** A hand edit of the saved state that stands in for any change that moves only the inputs hash of step a. */
function moveInputsHashOfA(paths: HomePaths, runId: string): void {
  const state = readState(paths, runId)!;
  state.calls!.find((call) => call.label === "a")!.inputsHash = "0".repeat(64);
  plantState(paths, state);
}

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

const loop = (last: string) => `export const meta = { name: 'loop', description: 'a loop' }
const out = []
for (let i = 0; i < 3; i++) out.push(await agent('check', { label: 'check' }))
out.push(await agent('${last}', { label: 'last' }))
return out`;

const asks = (a: string) => `export const meta = { name: 'asks', description: 'asks' }
const a = await agent('${a}', { label: 'a' })
const name = await checkpoint('Name it', { kind: 'input' })
return await agent('Build ' + name, { label: 'build' })`;

/** Pause the workflow with the prompt `fails` failing, apply the edits, and resume it as `orc resume` does.
 *  Returns the prompts of the first run and of the resume. */
async function resumed(options: {
  workflows: Record<string, string>;
  workflow: string;
  fails: string;
  edits?: Record<string, string>;
  mode?: "latest" | "same";
  before?: (paths: HomePaths, runId: string) => void;
}) {
  const { paths, projectDir } = setup(options.workflows);
  let broken = true;
  const agent = fake((prompt) => (broken && prompt === options.fails ? boom() : undefined));
  const record = start(paths, projectDir, options.workflow, agent);
  assert.equal((await agent.ended(record.runId))?.status, "paused");
  const first = agent.since(0);
  options.before?.(paths, record.runId);
  for (const [name, script] of Object.entries(options.edits ?? {})) edit(projectDir, name, script);
  broken = false;
  const done = await resume(paths, record.runId, agent, options.mode);
  assert.equal(done?.status, "completed");
  return { first, live: agent.since(first.length), done, state: readState(paths, record.runId)! };
}

/** Pause `three` with C failed, edit it, and resume it with --latest. */
const latest = (edited: string, before?: (paths: HomePaths, runId: string) => void) =>
  resumed({ workflows: { three: three("A") }, workflow: "three", fails: "C", edits: { three: edited }, mode: "latest", before });

/** Run the workflow to its end, apply the edits, and run it again as `orc rerun --reuse` does.
 *  Returns the prompts of the first run, the prompts of the second, and the second's result. */
async function reuseAfterEdit(workflows: Record<string, string>, workflow: string, edits: Record<string, string>) {
  const { paths, projectDir } = setup(workflows);
  const agent = fake();
  const first = start(paths, projectDir, workflow, agent);
  assert.equal((await agent.ended(first.runId))?.status, "completed");
  const before = agent.since(0);
  for (const [name, script] of Object.entries(edits)) edit(projectDir, name, script);
  const again = reuse(paths, first, agent);
  const done = await agent.ended(again.runId);
  assert.equal(done?.status, "completed");
  return { first: before, live: agent.since(before.length), result: JSON.parse(JSON.stringify(done?.result)) as unknown };
}

const NESTED = { child: child("X"), parent: parent("A") };

/** One row per case. A step fails, the workflow may change, and the run resumes in one mode.
 *  `first` is what the first run called, `live` what the resume calls again. */
const RESUMES: Array<{
  title: string;
  workflows: Record<string, string>;
  workflow: string;
  fails: string;
  edits?: Record<string, string>;
  mode?: "latest" | "same";
  first: string[];
  live: string[];
  result?: unknown;
}> = [
  { title: "keeps a parallel sibling that finished after the failed step", workflows: { par: par() }, workflow: "par", fails: "B", first: ["A", "B", "C"], live: ["B", "D"] },
  { title: "replays a loop of identical steps", workflows: { loop: loop("L") }, workflow: "loop", fails: "L", first: ["check", "check", "check", "L"], live: ["L"] },
  { title: "replays the steps of a nested workflow", workflows: NESTED, workflow: "parent", fails: "C", first: ["A", "X", "Y", "C"], live: ["C"] },
  {
    title: "with --latest and only a nested step edited, runs the edited step and the failed one",
    workflows: NESTED, workflow: "parent", fails: "C", edits: { child: child("X2") }, mode: "latest", first: ["A", "X", "Y", "C"], live: ["X2", "C"],
  },
  {
    title: "with --latest and a root step edited, keeps the nested workflow's steps",
    workflows: NESTED, workflow: "parent", fails: "C", edits: { parent: parent("A2") }, mode: "latest", first: ["A", "X", "Y", "C"], live: ["A2", "C"],
  },
  {
    title: "without --latest, goes on with the version the run started with",
    workflows: { three: three("A") }, workflow: "three", fails: "C", edits: { three: three("A2") }, mode: "same", first: ["A", "B", "C"], live: ["C"],
    result: ["A done", "B done", "C done"],
  },
  {
    title: "with --latest and a comment-only edit, keeps a parallel sibling that finished after the failed step",
    workflows: { par: par() }, workflow: "par", fails: "B", edits: { par: par("\n// a comment") }, mode: "latest", first: ["A", "B", "C"], live: ["B", "D"],
  },
];

describe("resume", () => {
  for (const { title, result, first, live, ...row } of RESUMES) {
    it(title, async () => {
      const resumedRun = await resumed(row);
      assert.deepEqual(resumedRun.first, first);
      assert.deepEqual(resumedRun.live, live);
      if (result !== undefined) assert.deepEqual(JSON.parse(JSON.stringify(resumedRun.done?.result)), result);
    });
  }

  it("replays an answered question, and asks no new one", async () => {
    const { paths, projectDir } = setup({
      asks: `export const meta = { name: 'asks', description: 'asks' }
const a = await agent('A', { label: 'a' })
const name = await checkpoint('Name it', { kind: 'input' })
return await agent('Build ' + name, { label: 'build' })`,
    });
    let broken = true;
    const agent = fake((prompt) => (broken && prompt.startsWith("Build") ? boom() : undefined));
    const record = start(paths, projectDir, "asks", agent);
    let ended = false;
    const answering = answerUntil(paths, record.runId, "orc", () => ended);
    const paused = await agent.ended(record.runId);
    ended = true;
    assert.deepEqual(await answering, ["Name it"]);
    assert.equal(paused?.status, "paused");

    broken = false;
    ended = false;
    const again = answerUntil(paths, record.runId, "other", () => ended);
    const done = await resume(paths, record.runId, agent);
    ended = true;
    assert.deepEqual(await again, [], "no question is asked again");
    assert.equal(done?.status, "completed");
    assert.deepEqual(agent.since(2), ["Build orc"]);
  });

  it("takes an answer given while the run waited, by the question's id", async () => {
    const { paths, projectDir } = setup({
      asks: `export const meta = { name: 'asks', description: 'asks' }
const a = await agent('A', { label: 'a' })
const name = await checkpoint('Name it', { kind: 'input' })
return await agent('Build ' + name, { label: 'build' })`,
    });
    const agent = fake(undefined, true);
    const record = start(paths, projectDir, "asks", agent);
    const running = agent.ended(record.runId);
    for (let i = 0; i < 500 && runQuestions(paths, record.runId).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const [question] = runQuestions(paths, record.runId);
    assert.equal(question?.id, `${record.runId}--1`);

    assert.equal((await orc(paths, ["pause", record.runId])).code, 0);
    assert.equal((await running)?.status, "paused");
    assert.deepEqual(runQuestions(paths, record.runId).map((q) => q.id), [question!.id], "the question waits while the run is paused");
    writeAnswer(paths, question!, "orc");

    const done = await resume(paths, record.runId, agent);
    assert.equal(done?.status, "completed");
    assert.deepEqual(agent.since(1), ["Build orc"]);
    assert.deepEqual(runQuestions(paths, record.runId), []);
  });

  it("at a usage limit, goes on in the failed step's session", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    let limited = true;
    const agent = fake((prompt) =>
      limited && prompt === "B" ? new WorkflowError("You've hit your limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false }) : undefined,
    );
    const record = start(paths, projectDir, "three", agent);
    await agent.ended(record.runId);
    assert.equal(readState(paths, record.runId)?.pauseReason, "usage_limit");
    assert.deepEqual(agent.since(0), ["A", "B"]);

    limited = false;
    const done = await resume(paths, record.runId, agent);
    assert.equal(done?.status, "completed");
    assert.deepEqual(agent.since(2), ["B", "C"]);
    assert.equal((agent.calls[2]!.options.continueFromSession as { sessionId?: string } | undefined)?.sessionId, "s2", "B goes on in its own session");
    assert.equal(agent.calls[3]!.options.continueFromSession, undefined);
  });

  it("resumes a paused reuse run with its source's later steps", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    let broken = true;
    const agent = fake((prompt) => (broken && prompt === "B2" ? boom() : undefined));
    const first = start(paths, projectDir, "three", agent);
    assert.equal((await agent.ended(first.runId))?.status, "completed");
    edit(projectDir, "three", three("A", "B2"));
    const again = reuse(paths, first, agent);
    assert.equal((await agent.ended(again.runId))?.status, "paused");
    assert.deepEqual(agent.since(3), ["B2"]);

    broken = false;
    const done = await resume(paths, again.runId, agent);
    assert.equal(done?.status, "completed");
    assert.deepEqual(agent.since(4), ["B2"], "C replays from the source");
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), ["A done", "B2 done", "C done"]);
    assert.equal(readState(paths, again.runId)?.resumeSeed, undefined, "a completed run keeps no seed");
  });

  it("without --latest, replays a step whose inputs hash changed", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    let broken = true;
    const agent = fake((prompt) => (broken && prompt === "C" ? boom() : undefined));
    const record = start(paths, projectDir, "three", agent);
    await agent.ended(record.runId);
    moveInputsHashOfA(paths, record.runId);

    broken = false;
    const done = await resume(paths, record.runId, agent);
    assert.equal(done?.status, "completed");
    assert.deepEqual(agent.since(3), ["C"]);
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

  it("with --latest, replays a question answered after the edited step", async () => {
    const { paths, projectDir } = setup({ asks: asks("A") });
    let broken = true;
    const agent = fake((prompt) => (broken && prompt.startsWith("Build") ? boom() : undefined));
    const record = start(paths, projectDir, "asks", agent);
    let ended = false;
    const answering = answerUntil(paths, record.runId, "orc", () => ended);
    assert.equal((await agent.ended(record.runId))?.status, "paused");
    ended = true;
    assert.deepEqual(await answering, ["Name it"]);

    edit(projectDir, "asks", asks("A2"));
    broken = false;
    ended = false;
    const again = answerUntil(paths, record.runId, "other", () => ended);
    const done = await resume(paths, record.runId, agent, "latest");
    ended = true;
    assert.deepEqual(await again, [], "no question is asked again");
    assert.equal(done?.status, "completed");
    assert.deepEqual(agent.since(2), ["A2", "Build orc"]);
  });

  it("with --latest, runs a step whose inputs hash changed", async () => {
    const { live } = await latest(`${three("A")}\n// a comment`, moveInputsHashOfA);
    assert.deepEqual(live, ["A", "C"]);
  });

  it("with --latest and a step inserted first, goes on in the session of the step at the usage limit", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    let limited = true;
    const agent = fake((prompt) =>
      limited && prompt === "B" ? new WorkflowError("You've hit your limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false }) : undefined,
    );
    const record = start(paths, projectDir, "three", agent);
    await agent.ended(record.runId);
    assert.equal(readState(paths, record.runId)?.pauseReason, "usage_limit");
    edit(projectDir, "three", three("A").replace("const a =", "const z = await agent('Z', { label: 'z' })\nconst a ="));

    limited = false;
    const done = await resume(paths, record.runId, agent, "latest");
    assert.equal(done?.status, "completed");
    assert.deepEqual(agent.since(2), ["Z", "B", "C"]);
    assert.equal(agent.calls[2]!.options.continueFromSession, undefined);
    assert.equal((agent.calls[3]!.options.continueFromSession as { sessionId?: string } | undefined)?.sessionId, "s2", "B goes on in its own session");
  });

  it("with --latest, keeps the steps it has not reached when it pauses again", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    const broken = new Set(["C"]);
    const agent = fake((prompt) => (broken.has(prompt) ? boom() : undefined));
    const record = start(paths, projectDir, "three", agent);
    assert.equal((await agent.ended(record.runId))?.status, "paused");
    edit(projectDir, "three", three("A2"));
    broken.add("A2");
    await resume(paths, record.runId, agent, "latest");
    assert.equal(readState(paths, record.runId)?.status, "paused");
    assert.deepEqual(agent.since(3), ["A2"]);

    broken.clear();
    const done = await resume(paths, record.runId, agent);
    assert.equal(done?.status, "completed");
    assert.deepEqual(agent.since(4), ["A2", "C"], "B replays from the first version");
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), ["A2 done", "B done", "C done"]);
  });

  it("reuses the steps of a resumed run after an edited first step", async () => {
    const { paths, projectDir } = setup({ three: three("A") });
    let broken = true;
    const agent = fake((prompt) => (broken && prompt === "C" ? boom() : undefined));
    const first = start(paths, projectDir, "three", agent);
    assert.equal((await agent.ended(first.runId))?.status, "paused");
    broken = false;
    assert.equal((await resume(paths, first.runId, agent))?.status, "completed");
    assert.deepEqual(agent.since(3), ["C"]);

    edit(projectDir, "three", three("A2"));
    const again = reuse(paths, first, agent);
    const done = await agent.ended(again.runId);
    assert.equal(done?.status, "completed");
    assert.deepEqual(agent.since(4), ["A2"]);
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
    const { first, live, result } = await reuseAfterEdit(NESTED, "parent", { parent: parent("A").replace("agent('C'", "agent('C2'") });
    assert.deepEqual(first, ["A", "X", "Y", "C"]);
    assert.deepEqual(live, ["C2"]);
    assert.deepEqual(result, ["A done", ["X done", "Y done"], "C2 done"]);
  });

  it("reuses a loop of identical steps", async () => {
    const { first, live } = await reuseAfterEdit({ loop: loop("L") }, "loop", { loop: loop("L2") });
    assert.deepEqual(first, ["check", "check", "check", "L"]);
    assert.deepEqual(live, ["L2"]);
  });
});

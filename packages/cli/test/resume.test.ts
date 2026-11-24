import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRecord, rerunRun, resumeRun, runQuestions, startRun, type HomePaths, type RunRecord } from "@sous/engine";
import { PERSON, fakeRunner, inProcess, plantState, readState, testHome, writeAnswer, WorkflowError, WorkflowErrorCode, type PersistedRunState } from "@sous/engine/testing";
import { sous, waitFor } from "./sous.js";
import { callProblem, words } from "./helpers/calls.js";

// Which steps run again when a run resumes. Each test pauses a run with a fake agent, resumes it
// as `sous resume` does, and checks the prompts the fake gets on the resume. A failed step,
// `sous stop --step` and the time limit each rerun only their step: runs.test.ts pins those three.


const setup = (workflows: Record<string, string>) => testHome(workflows, { retries: 0 });

function edit(projectDir: string, name: string, script: string): void {
  writeFileSync(join(projectDir, ".sous", "workflows", `${name}.js`), script);
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

/** Start the workflow as `sous run` does. `agent.ended` gives the worker's result. */
const start = (paths: HomePaths, projectDir: string, workflow: string, agent: Fake) => startRun(paths, agent.launch, { who: PERSON, workflow, projectDir, inputs: {} });

/** Resume the run as `sous resume` does, with --latest or --same when given, and wait for its worker. */
function resume(paths: HomePaths, runId: string, agent: Fake, choice?: "latest" | "same") {
  resumeRun(paths, agent.launch, runId, PERSON, { choice });
  return agent.ended(runId);
}

/** Run it again as `sous rerun --reuse` does. `agent.ended` gives the new run's result. */
const reuse = (paths: HomePaths, first: RunRecord, agent: Fake) => rerunRun(paths, agent.launch, first.runId, { who: PERSON, place: first.place, reuse: true });

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

/** `three` with these options on step a, in place of its label alone. */
const threeWith = (options: string) => three("A").replace("{ label: 'a' }", `{ ${options} }`);

const asks = (a: string) => `export const meta = { name: 'asks', description: 'asks' }
const a = await agent('${a}', { label: 'a' })
const name = await checkpoint('Name it', { kind: 'input' })
return await agent('Build ' + name, { label: 'build' })`;

/** Pause the workflow with the prompt `fails` failing, apply the edits, and resume it as `sous resume` does.
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
  return { first, live: agent.since(first.length), done, paths, runId: record.runId };
}

/** The engine's state of the run, as `sous show --full --json` prints it. */
async function shownState(paths: HomePaths, runId: string): Promise<PersistedRunState> {
  const shown = await sous(paths, ["show", runId, "--full", "--json"]);
  assert.equal(shown.code, 0, shown.out);
  return (JSON.parse(shown.out) as { state: PersistedRunState }).state;
}

/** Pause `three` with C failed, edit it, and resume it with --latest. */
const latest = (edited: string, before?: (paths: HomePaths, runId: string) => void) =>
  resumed({ workflows: { three: three("A") }, workflow: "three", fails: "C", edits: { three: edited }, mode: "latest", before });

/** Run the workflow to its end, apply the edits, and run it again as `sous rerun --reuse` does.
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
  // The guide: a step matches on the same prompt, model, agent, options and label. Each row below
  // edits one of these on step 1 and nothing else.
  {
    title: "with --latest and only the model of step 1 edited, runs it again and keeps the steps after it",
    workflows: { three: threeWith("label: 'a', model: 'claude/haiku'") }, workflow: "three", fails: "C",
    edits: { three: threeWith("label: 'a', model: 'claude/sonnet'") }, mode: "latest", first: ["A", "B", "C"], live: ["A", "C"],
  },
  {
    title: "with --latest and only an option of step 1 edited, runs it again and keeps the steps after it",
    workflows: { three: threeWith("label: 'a', effort: 'low'") }, workflow: "three", fails: "C",
    edits: { three: threeWith("label: 'a', effort: 'high'") }, mode: "latest", first: ["A", "B", "C"], live: ["A", "C"],
  },
  {
    title: "with --latest and only the label of step 1 edited, runs it again and keeps the steps after it",
    workflows: { three: three("A") }, workflow: "three", fails: "C",
    edits: { three: threeWith("label: 'first'") }, mode: "latest", first: ["A", "B", "C"], live: ["A", "C"],
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
    const { paths, projectDir } = setup({ asks: asks("A") });
    let broken = true;
    const agent = fake((prompt) => (broken && prompt.startsWith("Build") ? boom() : undefined));
    const record = start(paths, projectDir, "asks", agent);
    let ended = false;
    const answering = answerUntil(paths, record.runId, "sous", () => ended);
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
    assert.deepEqual(agent.since(2), ["Build sous"]);
  });

  it("takes an answer given while the run waited, by the question's id", async () => {
    const { paths, projectDir } = setup({ asks: asks("A") });
    const agent = fake(undefined, true);
    const record = start(paths, projectDir, "asks", agent);
    const running = agent.ended(record.runId);
    await waitFor(() => runQuestions(paths, record.runId).length > 0, "the question");
    const [question] = runQuestions(paths, record.runId);
    assert.equal(question?.id, `${record.runId}--1`);

    assert.equal((await sous(paths, ["pause", record.runId])).code, 0);
    assert.equal((await running)?.status, "paused");
    assert.deepEqual(runQuestions(paths, record.runId).map((q) => q.id), [question!.id], "the question waits while the run is paused");
    writeAnswer(paths, question!, "sous");

    const done = await resume(paths, record.runId, agent);
    assert.equal(done?.status, "completed");
    assert.deepEqual(agent.since(1), ["Build sous"]);
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
    const { live, done, paths, runId } = await latest(three("A2"));
    assert.deepEqual(live, ["A2", "C"]);
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), ["A2 done", "B done", "C done"]);
    const state = await shownState(paths, runId);
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
    const answering = answerUntil(paths, record.runId, "sous", () => ended);
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
    assert.deepEqual(agent.since(2), ["A2", "Build sous"]);
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
    const state = await shownState(paths, again.runId);
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

// Piece 13, resume with a note. `sous resume <run> --note "..." [--step <step>]` gives the note to
// the first agent call that runs in this go, or to the first call of the named step (design,
// "Resume with a note"). These runs are worker processes of their own on the fake programs in
// test/fakes, as a user's run is, so the note goes through the cli, the record and the worker.
//
// Choices the design leaves open, made here:
// - `--step` takes the step's name as `sous log` shows it, or its plain label, as `sous step` and
//   `tell --step` do. The step_not_running refusal of `sous tell` gives a nested step by its name
//   in the log ("sub: impl"), so the call it hands out must run as given, and one rule for every
//   --step flag is less to learn.
// - `--step` names a step the run has had, as `sous show` lists it. A name it never had fails with
//   no_such_step (65), as `tell --step` and `stop --step` do, and the run does not resume.
// - `--step` without `--note` is a usage error (64): it has nothing to aim.
// - The resume line in events.jsonl holds the note as `text`, and `step` when given. The note
//   stays outside the call hash, so the line and the step's activity are its record.

const NOTE_FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "SOUS_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];

const NOTE = "Use the v2 API.";
const onFake = (name: string, body: string) => `export const meta = { name: '${name}', description: '${name}', place: 'none' }\n${body}`;
const NOTE_WORKFLOWS = {
  abc: onFake(
    "abc",
    ["a", "b", "c"].map((label) => `await agent('Do ${label.toUpperCase()}.', { label: '${label}', model: 'claude/haiku' })`).join("\n") + "\nreturn 'done'",
  ),
  child: onFake("child", "return await agent('Build the part.', { label: 'impl', model: 'claude/haiku' })"),
  nest: onFake(
    "nest",
    "await agent('Build the top.', { label: 'impl', model: 'claude/haiku' })\nawait workflow('child', {}, { label: 'sub' })\nreturn await agent('Check the top.', { label: 'impl', model: 'claude/haiku' })",
  ),
};

interface FakeLine {
  program: string;
  prompt?: string;
}

/** The fakes' log and rules, in a folder of their own. */
function noteFakes(rules: object[]) {
  const dir = mkdtempSync(join(tmpdir(), "sous-resume-note-"));
  process.env.FAKE_LOG = join(dir, "fake.log");
  process.env.FAKE_RULES = join(dir, "rules.json");
  writeFileSync(process.env.FAKE_RULES, JSON.stringify(rules));
  const log = process.env.FAKE_LOG;
  return { prompts: (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeLine) : []).flatMap((line) => (line.prompt === undefined ? [] : [line.prompt])) };
}

/** The JSON sous printed. */
function printedJson(printed: { code: number; out: string }): Record<string, any> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  return parsed as Record<string, any>;
}

/** Poll a read until it holds, or 20 seconds pass. */
async function untilHolds(ready: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await ready()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** The worker ended: it clears its pid last. */
const workerGone = (paths: HomePaths, runId: string) => loadRecord(paths, runId)?.pid === undefined;

/** Start a workflow on a worker process of its own, with the fake whose prompts match `fails`
 *  failing once, and wait for the run to pause on it. */
async function pausedOnFake(workflow: keyof typeof NOTE_WORKFLOWS, fails: string) {
  const fakes = noteFakes([{ match: fails, fail: "broken", times: 1 }]);
  const { paths, projectDir } = testHome(NOTE_WORKFLOWS, { claudePath: join(NOTE_FAKES, "claude"), codexPath: join(NOTE_FAKES, "codex"), retries: 0 });
  const run = await sous(paths, ["run", workflow, "--json", "--project", projectDir]);
  assert.equal(run.code, 0, run.out);
  const runId = printedJson(run).runId as string;
  await untilHolds(() => readState(paths, runId)?.status === "paused" && workerGone(paths, runId), "the run to pause on the failed step");
  return { paths, runId, fakes, ran: fakes.prompts().length };
}

/** Wait for the resumed run to end, and stop it when it does not. */
async function resumedEnd(paths: HomePaths, runId: string): Promise<void> {
  try {
    await untilHolds(() => readState(paths, runId)?.status !== "paused" && workerGone(paths, runId), "the resumed run to end");
  } catch (error) {
    await sous(paths, ["stop", runId, "--json"]);
    throw error;
  }
}

interface NoteAction {
  act: string;
  by: string;
  runId?: string;
  step?: string;
  text?: string;
}
const noteActions = (paths: HomePaths): NoteAction[] => {
  const file = join(paths.home, "events.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as NoteAction) : [];
};

/** The activity `sous step --json` shows for a step. */
async function stepActivity(paths: HomePaths, runId: string, step: string): Promise<Array<{ kind: string; text: string }>> {
  const printed = await sous(paths, ["step", runId, step, "--json"]);
  assert.equal(printed.code, 0, printed.out);
  return (printedJson(printed).activity ?? []) as Array<{ kind: string; text: string }>;
}

describe("piece 13: sous resume --note", () => {
  it("a failed fake agent step resumed with --note gets the note in its prompt and its activity, and the resume line holds it", async () => {
    const { paths, runId, fakes, ran } = await pausedOnFake("abc", "Do B");
    const before = noteActions(paths).length;
    const printed = await sous(paths, ["resume", runId, "--note", NOTE, "--json"]);
    assert.equal(printed.code, 0, printed.out);
    await resumedEnd(paths, runId);
    assert.equal(readState(paths, runId)?.status, "completed");

    // This go ran B again, then C. B, the first agent call that ran, got the note, and C did not.
    const live = fakes.prompts().slice(ran);
    assert.equal(live.length, 2, `the resume ran B and C: ${JSON.stringify(live)}`);
    const [b, c] = live;
    assert.match(b ?? "", /Do B\./);
    assert.ok((b ?? "").trimEnd().endsWith(NOTE), `B's prompt ends with the note:\n${b}`);
    assert.ok(!(c ?? "").includes(NOTE), `C's prompt has no note:\n${c}`);

    const activity = await stepActivity(paths, runId, "b");
    assert.ok(
      activity.some((line) => line.kind === "note" && line.text.includes(NOTE)),
      `b's activity has a note line with the note: ${JSON.stringify(activity)}`,
    );
    const added = noteActions(paths).slice(before).filter((line) => line.act === "resume");
    assert.equal(added.length, 1, `one resume line: ${JSON.stringify(added)}`);
    assert.deepEqual({ by: added[0]!.by, runId: added[0]!.runId, text: added[0]!.text }, { by: "person", runId, text: NOTE });
  });

  it("the resume call that tell's step_not_running gives for a nested step runs as given and reaches that step only", async () => {
    const { paths, runId, fakes, ran } = await pausedOnFake("nest", "Build the part");
    const refusal = await sous(paths, ["tell", runId, "--step", "sub: impl", NOTE, "--json"]);
    assert.equal(refusal.code, 65, refusal.out);
    const { error } = printedJson(refusal);
    assert.equal(error?.code, "step_not_running", refusal.out);
    const call = error.call as string;
    assert.match(call, new RegExp(`^sous resume ${runId} --note `), call);
    assert.equal(callProblem(call), undefined, callProblem(call));

    const before = noteActions(paths).length;
    const printed = await sous(paths, words(call).slice(1));
    assert.equal(printed.code, 0, `${call} runs as given:\n${printed.out}`);
    await resumedEnd(paths, runId);
    assert.equal(readState(paths, runId)?.status, "completed");

    const live = fakes.prompts().slice(ran);
    const part = live.filter((prompt) => prompt.includes("Build the part"));
    const top = live.filter((prompt) => prompt.includes("Check the top"));
    assert.equal(part.length, 1, `the nested impl ran again once: ${JSON.stringify(live)}`);
    assert.ok(part[0]!.trimEnd().endsWith(NOTE), `the nested impl's prompt ends with the note:\n${part[0]}`);
    assert.equal(top.length, 1, `the top-level impl after it ran: ${JSON.stringify(live)}`);
    assert.ok(!top[0]!.includes(NOTE), `the top-level impl got no note:\n${top[0]}`);
    const activity = await stepActivity(paths, runId, "sub: impl");
    assert.ok(activity.some((line) => line.kind === "note" && line.text.includes(NOTE)), `the nested step's activity has the note: ${JSON.stringify(activity)}`);
    const added = noteActions(paths).slice(before).filter((line) => line.act === "resume");
    assert.equal(added.length, 1, `one resume line: ${JSON.stringify(added)}`);
    assert.deepEqual({ text: added[0]!.text, step: added[0]!.step }, { text: NOTE, step: "sub: impl" });
  });

  it("--step nosuch exits 65 with no_such_step and leaves the run paused, and --step without --note is a usage error", async () => {
    const { paths, runId, fakes, ran } = await pausedOnFake("abc", "Do B");
    const before = noteActions(paths).length;
    const printed = await sous(paths, ["resume", runId, "--note", NOTE, "--step", "nosuch", "--json"]);
    try {
      assert.equal(printed.code, 65, printed.out);
      const { error } = printedJson(printed);
      assert.equal(error?.code, "no_such_step", printed.out);
      assert.ok(typeof error.change === "string" && error.change.length > 0, printed.out);
      assert.ok(typeof error.call === "string" && error.call.startsWith("sous "), printed.out);
      assert.equal(callProblem(error.call), undefined, callProblem(error.call));
      assert.equal(noteActions(paths).length, before, "a refused resume adds no line");
      assert.equal(readState(paths, runId)?.status, "paused", "the run did not resume");
      assert.ok(workerGone(paths, runId), "no worker started");
      assert.equal(fakes.prompts().length, ran, "no step ran");

      const bare = await sous(paths, ["resume", runId, "--step", "b", "--json"]);
      assert.equal(bare.code, 64, bare.out);
      assert.equal(printedJson(bare).error?.code, "bad_argument", bare.out);
      assert.match(printedJson(bare).error.message, /--note/, "the error says --step needs --note");
      assert.equal(readState(paths, runId)?.status, "paused", "the run did not resume");
    } finally {
      if (!workerGone(paths, runId)) await resumedEnd(paths, runId).catch(() => undefined);
    }
  });

  it("--step naming a finished step resumes the run with a note that the step already finished and gets the note only if called again, and no call gets the note", async () => {
    const { paths, runId, fakes, ran } = await pausedOnFake("abc", "Do B");
    const before = noteActions(paths).length;
    const printed = await sous(paths, ["resume", runId, "--note", NOTE, "--step", "a", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    const reply = printedJson(printed);
    await resumedEnd(paths, runId);
    assert.ok(Array.isArray(reply.notes), printed.out);
    assert.ok(
      (reply.notes as string[]).some((note) => /["'`]a["'`]|step a\b/.test(note) && /already finished/.test(note) && /only if the workflow calls .* again/.test(note)),
      `a note names step a, says it already finished, and says the note reaches it only if the workflow calls it again: ${JSON.stringify(reply.notes)}`,
    );
    assert.equal(readState(paths, runId)?.status, "completed");
    const live = fakes.prompts().slice(ran);
    assert.equal(live.length, 2, `the resume ran B and C: ${JSON.stringify(live)}`);
    assert.ok(live.every((prompt) => !prompt.includes(NOTE)), `no call got the note: ${JSON.stringify(live)}`);
    const added = noteActions(paths).slice(before).filter((line) => line.act === "resume");
    assert.equal(added.length, 1, `one resume line: ${JSON.stringify(added)}`);
    assert.deepEqual({ text: added[0]!.text, step: added[0]!.step }, { text: NOTE, step: "a" });
  });

  it("--step naming a later step the run has not reached, by the label its text writes, gives the note to that step only", async () => {
    const { paths, runId, fakes, ran } = await pausedOnFake("abc", "Do A");
    const before = noteActions(paths).length;
    const printed = await sous(paths, ["resume", runId, "--note", NOTE, "--step", "c", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    const reply = printedJson(printed);
    await resumedEnd(paths, runId);
    assert.equal(readState(paths, runId)?.status, "completed");
    assert.ok(!(reply.notes as string[]).some((note) => /already finished/.test(note)), `no note says c finished: ${JSON.stringify(reply.notes)}`);

    // This go ran A again, then B and C. Only C got the note.
    const live = fakes.prompts().slice(ran);
    assert.equal(live.length, 3, `the resume ran A, B and C: ${JSON.stringify(live)}`);
    const [a, b, c] = live;
    assert.match(a ?? "", /Do A\./);
    assert.match(b ?? "", /Do B\./);
    assert.match(c ?? "", /Do C\./);
    assert.ok(!(a ?? "").includes(NOTE) && !(b ?? "").includes(NOTE), `A and B got no note: ${JSON.stringify([a, b])}`);
    assert.ok((c ?? "").trimEnd().endsWith(NOTE), `C's prompt ends with the note:\n${c}`);
    const activity = await stepActivity(paths, runId, "c");
    assert.ok(activity.some((line) => line.kind === "note" && line.text.includes(NOTE)), `c's activity has the note: ${JSON.stringify(activity)}`);
    const added = noteActions(paths).slice(before).filter((line) => line.act === "resume");
    assert.equal(added.length, 1, `one resume line: ${JSON.stringify(added)}`);
    assert.deepEqual({ text: added[0]!.text, step: added[0]!.step }, { text: NOTE, step: "c" });
  });

  it("resume --note on a run that runs already loses no note: a note and next give the sous tell call, which runs as given", async () => {
    noteFakes([{ match: "Do A", tool: "echo working", hold: "go", answer: "Done." }]);
    const gate = join(dirname(process.env.FAKE_LOG!), "go");
    const { paths, projectDir } = testHome(NOTE_WORKFLOWS, { claudePath: join(NOTE_FAKES, "claude"), codexPath: join(NOTE_FAKES, "codex"), retries: 0 });
    const run = await sous(paths, ["run", "abc", "--json", "--project", projectDir]);
    assert.equal(run.code, 0, run.out);
    const runId = printedJson(run).runId as string;
    try {
      await untilHolds(async () => (await stepActivity(paths, runId, "a").catch(() => [])).some((line) => line.kind === "tool"), "step a to run its tool call");
      const before = noteActions(paths).length;
      const printed = await sous(paths, ["resume", runId, "--note", NOTE, "--json"]);
      assert.equal(printed.code, 0, printed.out);
      const reply = printedJson(printed);
      assert.equal(reply.status, "running", printed.out);
      const tell = `sous tell ${runId} --step a 'Use the v2 API.' --json`;
      assert.ok((reply.notes as string[]).some((note) => note.includes(tell)), `a note gives ${tell}: ${JSON.stringify(reply.notes)}`);
      assert.equal(reply.next?.[0]?.call, tell, printed.out);
      assert.equal(callProblem(tell), undefined, callProblem(tell));
      assert.equal(noteActions(paths).length, before, "a resume that did not resume adds no line");

      const told = await sous(paths, words(tell).slice(1));
      assert.equal(told.code, 0, `${tell} runs as given:\n${told.out}`);
      // The tell reached the worker. Whether the fake reads it in this turn is the tell tests' matter.
      assert.equal(printedJson(told).told, true, told.out);
    } finally {
      writeFileSync(gate, "");
      await resumedEnd(paths, runId);
    }
    assert.equal(readState(paths, runId)?.status, "completed");
  });

  it("sous guide pauses names resume --note and --step", async () => {
    const { paths } = testHome();
    const printed = await sous(paths, ["guide", "pauses"]);
    assert.equal(printed.code, 0, printed.out);
    for (const flag of ["resume", "--note", "--step"]) assert.ok(printed.out.includes(flag), `the pauses topic names ${flag}`);
  });
});

// Piece 12, tell. `sous tell <run> --step <step> [--call n] "message"` gives a running agent step a
// message it reads after its current tool call, without stopping it. The cli writes the request,
// signals the worker, and waits up to 5 seconds for the worker's receipt in the step's activity
// (design, "The engine side").
//
// The runs below are worker processes of their own on the fake programs in test/fakes, as a
// user's run is, so the request goes through the real signal and the real steer seam. A rule's
// `tool` and `hold` keep the step inside a tool call until the test writes the gate file.
//
// Choices the design leaves open, made here:
// - turn_not_steerable exits 66. It is a Refusal whose `missing` is false: the step exists and
//   runs, and its turn refused the message. The design's table puts what is not found at 65 and
//   every other refusal at 66, and decision 15 calls it a failure to act. Its call is the same
//   tell, since the turn kind that refuses (a compact) ends soon.
// - A tell is one line in events.jsonl, also when it reaches two calls. The line records one act
//   of one caller, as one `stop --step` is one line whatever it stops. The calls it reached are in
//   the reply and in each call's activity.
// - A tell the worker got but the turn refused (turn_not_steerable) keeps its one line. The write
//   happened: the request reached the worker. A tell refused before any write (no_such_run,
//   no_such_step, step_not_running, step_takes_no_message, no_person_here) adds no line, as
//   piece 7 has it.
// - Who may tell: the person, an agent and a step of a run. Steering is what the owner wants an
//   agent to do for the person, and a step that supervises others steers them too. Each line has
//   by and through as piece 7 gives them, so a run's step is by "agent" through that run.
//   `--by person` from an agent records by "person" through the agent. `--by person` from a step
//   of a run fails with no_person_here.
// - A label that matches two running calls reaches both, and a note names `--call`. `--call n`
//   counts the calls of the label from 1, as `sous step --call` does.
// - A label the run never had fails with no_such_step (65), as `stop --step` does.
// - The message and --step are required. Without one, tell is a usage error (64), before any run
//   is looked up.
// - A code step (sh, js, py) is refused with step_takes_no_message only while it runs. A finished
//   one fails with step_not_running first, in the design's order of checks. The shell step here is
//   named boom, after the fails fixture, and waits on a gate so that it runs.
// - The reply's `calls` lists the calls told, one entry per call.
//
// MainOptions gains tellWaitMs, the time the cli waits for the receipt, 5000 by default. The
// pending test passes a short one through a cast, since MainOptions has no such field yet.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRecord, logFile, type HomePaths } from "@sous/engine";
import { readState, requestStepStop, stopRequestFile, testHome } from "@sous/engine/testing";
import type { MainOptions } from "../src/cli.js";
import { sous } from "./sous.js";
import { callProblem, words } from "./helpers/calls.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "SOUS_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];

const PERSON: NodeJS.ProcessEnv = {};
const CLAUDE: NodeJS.ProcessEnv = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };
const CODEX: NodeJS.ProcessEnv = { CODEX_THREAD_ID: "t1" };
const RUN_STEP: NodeJS.ProcessEnv = { SOUS_RUN_ID: "r1", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };

/** The keys the design gives a line of events.jsonl. */
const ACTION_KEYS = new Set(["at", "act", "by", "through", "runId", "workflow", "question", "prompt", "schedule", "step", "value", "text", "hash"]);

const workflow = (name: string, body: string) => `export const meta = { name: '${name}', description: '${name}', place: 'none' }\n${body}`;
const WORKFLOWS = {
  one: workflow("one", "return await agent('Build it.', { label: 'impl', model: 'codex/gpt-fake' })"),
  claude: workflow("claude", "return await agent('Build it.', { label: 'impl', model: 'claude/haiku' })"),
  two: workflow("two", "return await parallel([() => agent('Build part A.', { label: 'impl', model: 'codex/gpt-fake' }), () => agent('Build part B.', { label: 'impl', model: 'codex/gpt-fake' })])"),
  pair: workflow("pair", "return await parallel([() => agent('Build it.', { label: 'impl', model: 'codex/gpt-fake' }), () => agent('Check it.', { label: 'check', model: 'codex/gpt-fake' })])"),
  code: workflow("code", `await sh('while [ ! -f "$SOUS_PROJECT/gate" ]; do sleep 0.1; done', { label: 'boom' })\nreturn 'done'`),
  fails: workflow("fails", "await agent('Build it.', { label: 'impl', model: 'codex/gpt-fake' })\nawait sh('exit 3', { label: 'boom' })\nreturn 'done'"),
};

/** Each agent step runs one tool call and stays in it until the test writes the gate file "go". */
const HELD = [{ match: "Build|Check", tool: "echo working", hold: "go", answer: "Done." }];

interface LogLine {
  program: string;
  sessionId?: string;
  prompt?: string;
  steer?: { id: string | null; text: string };
  state?: string;
}

/** The fakes' log and rules, in a folder of their own. */
function fakePlace(rules: object[]) {
  const dir = mkdtempSync(join(tmpdir(), "sous-tell-"));
  process.env.FAKE_LOG = join(dir, "fake.log");
  process.env.FAKE_RULES = join(dir, "rules.json");
  writeFileSync(process.env.FAKE_RULES, JSON.stringify(rules));
  const log = process.env.FAKE_LOG;
  return {
    gate: (name: string) => writeFileSync(join(dir, name), ""),
    lines: (): LogLine[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine) : []),
  };
}

type Place = ReturnType<typeof fakePlace>;

/** Start a run of one of the workflows above, on a worker process of its own. */
async function start(name: keyof typeof WORKFLOWS, rules: object[] = HELD): Promise<{ paths: HomePaths; projectDir: string; runId: string; place: Place }> {
  const place = fakePlace(rules);
  const { paths, projectDir } = testHome(WORKFLOWS, { claudePath: join(FAKES, "claude"), codexPath: join(FAKES, "codex") });
  const run = await sous(paths, ["run", name, "--json", "--project", projectDir], { env: PERSON });
  assert.equal(run.code, 0, run.out);
  return { paths, projectDir, runId: json(run).runId as string, place };
}

/** The JSON sous printed. */
function json(printed: { code: number; out: string }): Record<string, any> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  return parsed as Record<string, any>;
}

/** A tell's success reply, with its notes and next checked. */
function told(printed: { code: number; out: string }): Record<string, any> & { notes: string[]; next: Array<{ call: string; does: string }> } {
  assert.equal(printed.code, 0, printed.out);
  const reply = json(printed);
  assert.equal(reply.told, true, printed.out);
  assert.ok(Array.isArray(reply.notes), `notes is an array: ${printed.out}`);
  assert.ok(Array.isArray(reply.next), `next is an array: ${printed.out}`);
  assert.ok(Array.isArray(reply.calls), `calls is an array: ${printed.out}`);
  return reply as Record<string, any> & { notes: string[]; next: Array<{ call: string; does: string }> };
}

/** The error a refusal printed. */
function refused(printed: { code: number; out: string }, exit: number, code: string): { code: string; message: string; change: string; call: string | null } {
  assert.equal(printed.code, exit, printed.out);
  const { error } = json(printed);
  assert.ok(error, printed.out);
  assert.equal(error.code, code, printed.out);
  assert.equal(typeof error.message, "string", printed.out);
  assert.ok(typeof error.change === "string" && error.change.length > 0, printed.out);
  return error;
}

interface Action {
  at: string;
  act: string;
  by: string;
  through: Record<string, unknown>;
  runId?: string;
  step?: string;
  text?: string;
  [key: string]: unknown;
}
const actions = (paths: HomePaths): Action[] => {
  const file = join(paths.home, "events.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Action) : [];
};
const tells = (paths: HomePaths) => actions(paths).filter((line) => line.act === "tell");

/** The one line a tell added since `before` lines, checked against the design's shape. */
function oneTell(paths: HomePaths, before: number, what: string): Action {
  const now = actions(paths);
  assert.equal(now.length, before + 1, `${what} adds exactly one line to events.jsonl:\n${now.slice(before).map((line) => JSON.stringify(line)).join("\n")}`);
  const line = now.at(-1)!;
  for (const key of Object.keys(line)) assert.ok(ACTION_KEYS.has(key), `${what}: a line has no key "${key}": ${JSON.stringify(line)}`);
  assert.equal(line.act, "tell", JSON.stringify(line));
  assert.ok(Math.abs(Date.now() - Date.parse(line.at)) < 60_000, `${what}: at is the time of the write: ${line.at}`);
  return line;
}

/** Poll an async read until it holds, or 20 seconds pass. */
async function until(ready: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await ready()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

interface StepReply {
  status?: string;
  prompt?: string;
  activity?: Array<{ kind: string; text: string }>;
  next?: Array<{ call: string; does: string }>;
}

/** What `sous step --json` shows of one call of a step, or undefined while it shows nothing. */
async function stepOf(paths: HomePaths, runId: string, step: string, call?: number): Promise<StepReply | undefined> {
  const printed = await sous(paths, ["step", runId, step, ...(call === undefined ? [] : ["--call", String(call)]), "--json"], { env: PERSON });
  return printed.code === 0 ? (JSON.parse(printed.out) as StepReply) : undefined;
}

/** The call runs and is inside its tool call, so its turn has opened the steer seam. */
async function inTool(paths: HomePaths, runId: string, step: string, call?: number): Promise<void> {
  await until(async () => {
    const shown = await stepOf(paths, runId, step, call);
    return shown?.status === "running" && (shown.activity ?? []).some((line) => line.kind === "tool");
  }, `${step}${call ? ` call ${call}` : ""} to run its tool call`);
}

/** The call's activity lines of kind tell. */
async function tellLines(paths: HomePaths, runId: string, step: string, call?: number): Promise<string[]> {
  return ((await stepOf(paths, runId, step, call))?.activity ?? []).filter((line) => line.kind === "tell").map((line) => line.text);
}

/** The worker ended: it clears its pid last. */
const ended = (paths: HomePaths, runId: string) => loadRecord(paths, runId)?.pid === undefined;

/** Let the held steps go and wait for the worker to end. A worker that does not end is stopped. */
async function finish(paths: HomePaths, runId: string, place: Place, projectDir?: string): Promise<void> {
  place.gate("go");
  if (projectDir) writeFileSync(join(projectDir, "gate"), "");
  try {
    await until(() => ended(paths, runId), "the worker to end");
  } catch {
    await sous(paths, ["stop", runId, "--json"], { env: PERSON });
  }
}

/** The steer lines the fakes logged for one message, with what became of it. */
const steered = (place: Place, text: string) => place.lines().filter((line) => line.steer?.text === text);

const MESSAGE = "Use the v2 API.";

describe("piece 12: sous tell", () => {
  it("a tell to a running agent step exits 0 with told, delivered and its call, and the step's activity and events.jsonl record it", async () => {
    const { paths, runId, place } = await start("one");
    try {
      await inTool(paths, runId, "impl");
      const before = actions(paths).length;
      const reply = told(await sous(paths, ["tell", runId, "--step", "impl", MESSAGE, "--json"], { env: PERSON }));
      assert.equal(reply.delivery, "delivered");
      assert.equal(reply.calls.length, 1, JSON.stringify(reply.calls));
      const line = oneTell(paths, before, "a tell");
      assert.deepEqual(
        { by: line.by, through: line.through, runId: line.runId, step: line.step, text: line.text },
        { by: "person", through: { kind: "person" }, runId, step: "impl", text: MESSAGE },
      );
      // The program read it, and the step's activity shows it with its receipt.
      assert.deepEqual(
        steered(place, MESSAGE).map((entry) => entry.state),
        ["read"],
      );
      const lines = await tellLines(paths, runId, "impl");
      assert.ok(
        lines.some((text) => text.includes(MESSAGE)),
        `a tell line holds the message: ${JSON.stringify(lines)}`,
      );
      assert.ok(
        lines.some((text) => /delivered/.test(text)),
        `a tell line says delivered: ${JSON.stringify(lines)}`,
      );
    } finally {
      await finish(paths, runId, place);
    }
    assert.equal(readState(paths, runId)?.status, "completed", "the step went on to its end, with no restart");
  });

  it("sous step on a running agent step gives a tell call in next that sous runs as it is", async () => {
    const { paths, runId, place } = await start("one");
    try {
      await inTool(paths, runId, "impl");
      const shown = await stepOf(paths, runId, "impl");
      const call = (shown?.next ?? []).map((next) => next.call).find((call) => call.startsWith("sous tell "));
      assert.ok(call, `next holds a tell call: ${JSON.stringify(shown?.next)}`);
      assert.equal(callProblem(call), undefined, callProblem(call));
      // The call with a message in place of "...".
      const argv = words(call).slice(1);
      assert.ok(argv.includes("..."), `the call leaves "..." for the message: ${call}`);
      const reply = told(await sous(paths, argv.map((word) => (word === "..." ? MESSAGE : word)), { env: PERSON }));
      assert.equal(reply.delivery, "delivered");
      assert.deepEqual(
        steered(place, MESSAGE).map((entry) => entry.state),
        ["read"],
      );
    } finally {
      await finish(paths, runId, place);
    }
  });

  it("a tell to a running shell step exits 66 with step_takes_no_message and the stop call, and adds no line", async () => {
    const { paths, projectDir, runId, place } = await start("code", []);
    try {
      await until(async () => (await stepOf(paths, runId, "boom"))?.status === "running", "the shell step to run");
      const before = actions(paths).length;
      const error = refused(await sous(paths, ["tell", runId, "--step", "boom", MESSAGE, "--json"], { env: PERSON }), 66, "step_takes_no_message");
      assert.ok(error.call?.startsWith(`sous stop ${runId} --step boom`), JSON.stringify(error));
      assert.equal(callProblem(error.call!), undefined, callProblem(error.call!));
      assert.equal(actions(paths).length, before, "a refused tell adds no line");
    } finally {
      await finish(paths, runId, place, projectDir);
    }
  });

  it("a tell to a finished step exits 65 with step_not_running and a resume --note call, and a label the run never had gives no_such_step", async () => {
    const { paths, runId, place } = await start("fails", []);
    try {
      await until(() => ended(paths, runId), "the run to stop at the failed step");
      assert.equal(readState(paths, runId)?.status, "paused");
      const before = actions(paths).length;
      const error = refused(await sous(paths, ["tell", runId, "--step", "impl", MESSAGE, "--json"], { env: PERSON }), 65, "step_not_running");
      assert.match(error.call ?? "", new RegExp(`^sous resume ${runId} --note `), JSON.stringify(error));
      assert.match(error.call ?? "", / --step impl /, `the resume call names the step: ${JSON.stringify(error)}`);
      const missing = refused(await sous(paths, ["tell", runId, "--step", "nosuch", MESSAGE, "--json"], { env: PERSON }), 65, "no_such_step");
      assert.ok(missing.call?.startsWith(`sous show ${runId}`), JSON.stringify(missing));
      assert.equal(actions(paths).length, before, "a refused tell adds no line");
    } finally {
      await finish(paths, runId, place);
    }
  });

  it("a tell to a step of a run that completed exits 65 with step_not_running and a show call", async () => {
    const { paths, runId, place } = await start("one", []);
    try {
      await until(() => ended(paths, runId), "the run to end");
      assert.equal(readState(paths, runId)?.status, "completed");
      const error = refused(await sous(paths, ["tell", runId, "--step", "impl", MESSAGE, "--json"], { env: PERSON }), 65, "step_not_running");
      assert.ok(error.call?.startsWith(`sous show ${runId}`), JSON.stringify(error));
    } finally {
      await finish(paths, runId, place);
    }
  });

  it("a tell to a run that does not exist exits 65 with no_such_run", async () => {
    const { paths } = testHome();
    const error = refused(await sous(paths, ["tell", "run-nosuch", "--step", "impl", MESSAGE, "--json"], { env: PERSON }), 65, "no_such_run");
    assert.ok(error.call?.startsWith("sous "), JSON.stringify(error));
    assert.equal(tells(paths).length, 0);
  });

  it("a tell without a message or without --step is a usage error, exit 64", async () => {
    const { paths } = testHome();
    const noMessage = await sous(paths, ["tell", "run-nosuch", "--step", "impl", "--json"], { env: PERSON });
    assert.equal(noMessage.code, 64, noMessage.out);
    assert.equal(json(noMessage).error?.code, "bad_argument", noMessage.out);
    assert.match(json(noMessage).error.message, /message/, "the error says the message is missing");
    const noStep = await sous(paths, ["tell", "run-nosuch", MESSAGE, "--json"], { env: PERSON });
    assert.equal(noStep.code, 64, noStep.out);
    assert.equal(json(noStep).error?.code, "bad_argument", noStep.out);
    assert.match(json(noStep).error.message, /--step/, "the error says --step is missing");
  });

  it("a tell while a step stop is pending: the worker takes the stop and the tell", async () => {
    const { paths, runId, place } = await start("pair");
    try {
      await inTool(paths, runId, "impl");
      await inTool(paths, runId, "check");
      // A stop request the worker has not taken yet, as `sous stop --step` leaves it before its signal.
      requestStepStop(paths, runId, { step: "check", calls: [{ scope: runId, label: "check" }] });
      const reply = told(await sous(paths, ["tell", runId, "--step", "impl", MESSAGE, "--json"], { env: PERSON }));
      assert.equal(reply.delivery, "delivered");
      assert.deepEqual(
        steered(place, MESSAGE).map((entry) => entry.state),
        ["read"],
      );
      await until(() => readFileSync(logFile(paths, runId), "utf8").includes("stopping   check"), "the worker to stop check");
      assert.equal(existsSync(stopRequestFile(paths, runId)), false, "the worker took the stop request");
    } finally {
      await finish(paths, runId, place);
    }
    assert.equal(readState(paths, runId)?.pauseReason, "step_stopped");
  });

  it("a tell the program has not read within the wait exits 0 with delivery pending and a note, and sous step shows it once read", async () => {
    const { paths, runId, place } = await start("claude");
    try {
      await inTool(paths, runId, "impl");
      const started = Date.now();
      const options = { env: PERSON, tellWaitMs: 300 } as MainOptions & { tellWaitMs: number };
      const reply = told(await sous(paths, ["tell", runId, "--step", "impl", MESSAGE, "--json"], options));
      assert.ok(Date.now() - started < 4_000, `the wait came from tellWaitMs, not the default 5 seconds: ${Date.now() - started} ms`);
      assert.equal(reply.delivery, "pending");
      assert.equal(reply.calls.length, 1, JSON.stringify(reply.calls));
      assert.ok(
        reply.notes.some((note) => /after its current tool call/.test(note)),
        `a note says when the step reads it: ${JSON.stringify(reply.notes)}`,
      );
      // Claude Code queued the message. The step reads it once its tool call ends.
      assert.deepEqual(
        steered(place, MESSAGE).map((entry) => entry.state),
        ["queued"],
      );
      place.gate("go");
      await until(async () => (await tellLines(paths, runId, "impl")).some((text) => text.includes(MESSAGE)), "sous step to show the tell");
      assert.deepEqual(
        steered(place, MESSAGE).map((entry) => entry.state),
        ["queued", "read"],
      );
    } finally {
      await finish(paths, runId, place);
    }
    assert.equal(readState(paths, runId)?.status, "completed");
  });

  it("a tell to a turn that cannot take one exits 66 with turn_not_steerable and the same tell as its call", async () => {
    const { paths, runId, place } = await start("one", [{ ...HELD[0], notSteerable: "compact" }]);
    try {
      await inTool(paths, runId, "impl");
      const before = actions(paths).length;
      const error = refused(await sous(paths, ["tell", runId, "--step", "impl", MESSAGE, "--json"], { env: PERSON }), 66, "turn_not_steerable");
      assert.ok(error.call?.startsWith(`sous tell ${runId} --step impl`), JSON.stringify(error));
      assert.equal(callProblem(error.call!), undefined, callProblem(error.call!));
      assert.deepEqual(
        steered(place, MESSAGE).map((entry) => entry.state),
        ["not_steerable"],
      );
      // The request reached the worker, so the tell keeps its line.
      oneTell(paths, before, "a tell the turn refused");
    } finally {
      await finish(paths, runId, place);
    }
  });

  it("a label that matches two running calls reaches both with a note, as one line, and --call 2 reaches only the second", async () => {
    const { paths, runId, place } = await start("two");
    try {
      await inTool(paths, runId, "impl", 1);
      await inTool(paths, runId, "impl", 2);
      const before = actions(paths).length;
      const both = told(await sous(paths, ["tell", runId, "--step", "impl", MESSAGE, "--json"], { env: PERSON }));
      assert.equal(both.delivery, "delivered");
      assert.equal(both.calls.length, 2, JSON.stringify(both.calls));
      assert.ok(
        both.notes.some((note) => note.includes("--call")),
        `a note says the tell reached two calls and names --call: ${JSON.stringify(both.notes)}`,
      );
      const read = steered(place, MESSAGE);
      assert.deepEqual(
        read.map((entry) => entry.state),
        ["read", "read"],
      );
      assert.equal(new Set(read.map((entry) => entry.sessionId)).size, 2, "each call's session read it once");
      oneTell(paths, before, "a tell that reached two calls");

      const only = "Only part two.";
      const second = told(await sous(paths, ["tell", runId, "--step", "impl", "--call", "2", only, "--json"], { env: PERSON }));
      assert.equal(second.delivery, "delivered");
      assert.equal(second.calls.length, 1, JSON.stringify(second.calls));
      // The second call, as sous step --call 2 shows it.
      const prompt = (await stepOf(paths, runId, "impl", 2))?.prompt ?? "";
      assert.ok(prompt, "sous step --call 2 shows the second call's prompt");
      const session = place.lines().find((line) => line.prompt !== undefined && !line.steer && line.prompt.includes(prompt))?.sessionId;
      assert.ok(session, `the fakes logged the second call's prompt: ${prompt}`);
      assert.deepEqual(
        steered(place, only).map((entry) => [entry.sessionId, entry.state]),
        [[session, "read"]],
      );
      assert.deepEqual((await tellLines(paths, runId, "impl", 1)).filter((text) => text.includes(only)), [], "the first call shows no tell it did not get");
      assert.equal(tells(paths).length, 2, "two tells, two lines");
    } finally {
      await finish(paths, runId, place);
    }
  });
});

describe("piece 12: who may tell", () => {
  it("an agent and a step of a run may tell, each recorded with by and through; --by person from a run fails with no_person_here", async () => {
    const { paths, runId, place } = await start("one");
    try {
      await inTool(paths, runId, "impl");
      const cases: Array<{ env: NodeJS.ProcessEnv; by?: string; who: { by: string; through: Record<string, unknown> } }> = [
        { env: CLAUDE, who: { by: "agent", through: { kind: "agent", program: "claude", session: "s1" } } },
        { env: CODEX, who: { by: "agent", through: { kind: "agent", program: "codex", session: "t1" } } },
        { env: RUN_STEP, who: { by: "agent", through: { kind: "run", runId: "r1" } } },
        { env: CLAUDE, by: "person", who: { by: "person", through: { kind: "agent", program: "claude", session: "s1" } } },
      ];
      for (const [i, { env, by, who }] of cases.entries()) {
        const text = `Message ${i + 1}.`;
        const before = actions(paths).length;
        const reply = told(await sous(paths, ["tell", runId, "--step", "impl", text, ...(by ? ["--by", by] : []), "--json"], { env }));
        assert.equal(reply.delivery, "delivered", `case ${i + 1}`);
        const line = oneTell(paths, before, `tell case ${i + 1}`);
        assert.deepEqual({ by: line.by, through: line.through, runId: line.runId, step: line.step, text: line.text }, { ...who, runId, step: "impl", text }, `case ${i + 1}`);
      }
      const before = actions(paths).length;
      const error = refused(await sous(paths, ["tell", runId, "--step", "impl", "From a run.", "--by", "person", "--json"], { env: RUN_STEP }), 66, "no_person_here");
      assert.equal(error.call, null, JSON.stringify(error));
      assert.equal(actions(paths).length, before, "the refused tell adds no line");
      assert.deepEqual(steered(place, "From a run."), [], "the refused tell reached no step");
    } finally {
      await finish(paths, runId, place);
    }
  });
});

describe("piece 12: the steer guide topic", () => {
  it("sous guide steer names sous tell, --call and resume --note", async () => {
    const { paths } = testHome();
    const printed = await sous(paths, ["guide", "steer"], { env: PERSON });
    assert.equal(printed.code, 0, printed.out);
    for (const words of ["sous tell", "--call", "resume --note"]) assert.ok(printed.out.includes(words), `the steer topic names ${words}`);
  });
});

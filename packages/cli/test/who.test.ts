// Piece 7, who did it. sous works out who calls it from the shell markers of the environment main
// is given, never from process.env. `--by person` is the caller's word that the person decided.
// Every write adds one line to <home>/events.jsonl with {at, act, by, through, runId, ...}. A read
// adds none, and a refused write adds none: the refusal never reaches the engine's write, which is
// what records the line (design, "Who did it"). With SOUS_TRACE_CALLS=1, main adds one line per call
// to <home>/calls.jsonl, a refused call with its code.
//
// The tests read both files raw, so they hold whatever module writes them. whoIsCalling comes
// through a dynamic import, so the cli tests below fail on their own assertions while
// cli/src/through.ts does not exist yet. Every call passes its env, so the markers of the shell
// that runs the tests never count.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { listRecords, loadRecord, readRun, runQuestions, type HomePaths } from "@sous/engine";
import { inProcess, plantState, testHome, tick, updateRecord, type InnerRunner } from "@sous/engine/testing";
import { sous, waitFor } from "./sous.js";
import { deadPid } from "./helpers/process.js";

type Through =
  | { kind: "person" }
  | { kind: "agent"; program: "claude" | "codex"; session?: string }
  | { kind: "run"; runId: string }
  | { kind: "schedule"; schedule: string };
interface Who {
  by: "person" | "agent" | "sous";
  through: Through;
}
interface Action {
  at: string;
  act: string;
  by: string;
  through: Through;
  runId?: string;
  workflow?: string;
  question?: string;
  value?: unknown;
  [key: string]: unknown;
}
interface TraceLine {
  at: string;
  argv: string[];
  exit: number;
  code?: string;
  through: Through;
}

const through = async () => (await import("../src/through.js" as string)) as { whoIsCalling(env: NodeJS.ProcessEnv, by?: string): Who };

/** The keys the design gives a line of events.jsonl. */
const ACTION_KEYS = new Set(["at", "act", "by", "through", "runId", "workflow", "question", "step", "value", "text", "hash"]);

const PERSON: NodeJS.ProcessEnv = {};
const CLAUDE: NodeJS.ProcessEnv = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };
const CODEX: NodeJS.ProcessEnv = { CODEX_THREAD_ID: "t1" };
const RUN_STEP: NodeJS.ProcessEnv = { SOUS_RUN_ID: "r1", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };

const FIXTURES = join(import.meta.dirname, "fixtures", "workflows");
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.js`), "utf8");

/** These workflows run js, sh and ask steps, so no agent runs. */
const runner = { run: async () => "unused" } as unknown as InnerRunner;

function lines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
const actions = (paths: HomePaths) => lines<Action>(join(paths.home, "events.jsonl"));
const traced = (paths: HomePaths) => lines<TraceLine>(join(paths.home, "calls.jsonl"));

/** The JSON sous printed. */
function json(printed: { code: number; out: string }): Record<string, any> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  return parsed as Record<string, any>;
}

/** The one line a write added since `before` lines, checked against the design's shape. */
function oneNew(paths: HomePaths, before: number, what: string): Action {
  const now = actions(paths);
  assert.equal(now.length, before + 1, `${what} adds exactly one line to events.jsonl:\n${now.slice(before).map((line) => JSON.stringify(line)).join("\n")}`);
  const line = now.at(-1)!;
  for (const key of Object.keys(line)) assert.ok(ACTION_KEYS.has(key), `${what}: a line has no key "${key}": ${JSON.stringify(line)}`);
  assert.equal(typeof line.at, "string", JSON.stringify(line));
  assert.ok(Math.abs(Date.now() - Date.parse(line.at)) < 60_000, `${what}: at is the time of the write: ${line.at}`);
  return line;
}

async function asked(paths: HomePaths, runId: string): Promise<string> {
  await waitFor(() => runQuestions(paths, runId).length > 0, "the run to ask");
  return runQuestions(paths, runId)[0]!.id;
}

describe("piece 7: whoIsCalling", () => {
  it("no marker gives the person", async () => {
    const { whoIsCalling } = await through();
    assert.deepEqual(whoIsCalling({}), { by: "person", through: { kind: "person" } });
    assert.deepEqual(whoIsCalling({ HOME: "/home/x", TERM: "xterm" }), { by: "person", through: { kind: "person" } });
  });

  it("CLAUDECODE=1 with CLAUDE_CODE_SESSION_ID gives an agent through Claude with that session", async () => {
    const { whoIsCalling } = await through();
    assert.deepEqual(whoIsCalling({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" }), { by: "agent", through: { kind: "agent", program: "claude", session: "s1" } });
  });

  it("CLAUDECODE=1 alone gives an agent through Claude with no session", async () => {
    const { whoIsCalling } = await through();
    const who = whoIsCalling({ CLAUDECODE: "1" });
    assert.equal(who.by, "agent");
    assert.equal(who.through.kind, "agent");
    assert.equal((who.through as { program?: string }).program, "claude");
    assert.equal((who.through as { session?: string }).session, undefined);
  });

  // The marker is CLAUDECODE=1, as the design's MARKERS give it. Claude Code always sets it with the
  // session id (spike findings, section 3), so a session id alone is no Claude Code shell, such as
  // an id a person exported by hand. The same goes for CODEX_SESSION_ID without CODEX_THREAD_ID and
  // for the other variables Claude Code sets beside its marker. An agent that clears its marker on
  // purpose gets through, which the proposal accepts as a real cheat.
  it("a partial marker is no marker: a session id without CLAUDECODE=1, CODEX_SESSION_ID alone, an empty SOUS_RUN_ID", async () => {
    const { whoIsCalling } = await through();
    const person = { by: "person", through: { kind: "person" } };
    assert.deepEqual(whoIsCalling({ CLAUDE_CODE_SESSION_ID: "s1" }), person);
    assert.deepEqual(whoIsCalling({ CLAUDECODE: "0", CLAUDE_CODE_SESSION_ID: "s1" }), person);
    assert.deepEqual(whoIsCalling({ CLAUDECODE: "" }), person);
    assert.deepEqual(whoIsCalling({ CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: "42" }), person);
    assert.deepEqual(whoIsCalling({ CODEX_SESSION_ID: "c1", CODEX_SANDBOX: "seatbelt" }), person);
    assert.deepEqual(whoIsCalling({ SOUS_RUN_ID: "" }), person);
  });

  it("CODEX_THREAD_ID gives an agent through Codex, and wins over the Claude markers", async () => {
    const { whoIsCalling } = await through();
    const codex = { by: "agent", through: { kind: "agent", program: "codex", session: "t1" } };
    assert.deepEqual(whoIsCalling({ CODEX_THREAD_ID: "t1" }), codex);
    assert.deepEqual(whoIsCalling({ CODEX_THREAD_ID: "t1", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" }), codex);
  });

  it("SOUS_RUN_ID wins over both programs' markers", async () => {
    const { whoIsCalling } = await through();
    const step = { by: "agent", through: { kind: "run", runId: "r1" } };
    assert.deepEqual(whoIsCalling({ SOUS_RUN_ID: "r1" }), step);
    assert.deepEqual(whoIsCalling({ SOUS_RUN_ID: "r1", CODEX_THREAD_ID: "t1", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" }), step);
  });

  it("--by person sets by and keeps through, from an agent and from the person", async () => {
    const { whoIsCalling } = await through();
    assert.deepEqual(whoIsCalling(CLAUDE, "person"), { by: "person", through: { kind: "agent", program: "claude", session: "s1" } });
    assert.deepEqual(whoIsCalling(CODEX, "person"), { by: "person", through: { kind: "agent", program: "codex", session: "t1" } });
    assert.deepEqual(whoIsCalling(PERSON, "person"), { by: "person", through: { kind: "person" } });
  });

  it("--by person from a step of a run fails with no_person_here and no call", async () => {
    const { whoIsCalling } = await through();
    assert.throws(
      () => whoIsCalling(RUN_STEP, "person"),
      (error: { code?: string; call?: unknown }) => error.code === "no_person_here" && error.call === null,
    );
  });

  it("--by takes only person", async () => {
    const { whoIsCalling } = await through();
    for (const by of ["agent", "sous", "Person", ""]) {
      assert.throws(() => whoIsCalling(CLAUDE, by), (error: { code?: string }) => error.code === "bad_argument", `--by ${JSON.stringify(by)}`);
    }
  });
});

describe("piece 7: people workflows", () => {
  it("an agent's sous run deploy exits 66 with started_by_people, no call and the command for the person, and writes nothing", async () => {
    const { paths, projectDir } = testHome({ deploy: fixture("deploy") });
    const workers = inProcess({ inner: runner });
    for (const [env, argv] of [
      [CLAUDE, ["run", "deploy", "--json", "--project", projectDir]],
      [CODEX, ["run", "deploy", "--json", "--project", projectDir]],
      // The agent's word that the person asked changes nothing: the person types this command.
      [CLAUDE, ["run", "deploy", "--by", "person", "--json", "--project", projectDir]],
      // A step of a run is refused the same way, with the same shape.
      [RUN_STEP, ["run", "deploy", "--json", "--project", projectDir]],
    ] as const) {
      const refused = await sous(paths, [...argv], { env, launch: workers.launch });
      assert.equal(refused.code, 66, `${JSON.stringify(env)} ${argv.join(" ")}:\n${refused.out}`);
      const { error } = json(refused);
      assert.equal(error?.code, "started_by_people", refused.out);
      assert.equal(error.call, null, refused.out);
      assert.match(error.forPerson, /^sous run deploy( |$)/, refused.out);
    }
    assert.deepEqual(workers.launched, [], "no worker starts");
    assert.equal(listRecords(paths).length, 0, "no run record exists");
    assert.deepEqual(actions(paths), [], "a refused write adds no line to events.jsonl");
  });

  it("the refusal's forPerson keeps the agent's inputs, and its change points to the person's own terminal", async () => {
    const { paths, projectDir } = testHome({ deploy: fixture("deploy") });
    const refused = await sous(paths, ["run", "deploy", "--env", "prod", "--json", "--project", projectDir], { env: CLAUDE, launch: inProcess({ inner: runner }).launch });
    assert.equal(refused.code, 66, refused.out);
    const { error } = json(refused);
    assert.match(error.forPerson, /^sous run deploy .*--env prod/, refused.out);
    assert.match(error.change, /terminal/, refused.out);
  });

  it("with no marker the same run starts, and its line says the person did it", async () => {
    const { paths, projectDir } = testHome({ deploy: fixture("deploy") });
    const workers = inProcess({ inner: runner });
    const run = await sous(paths, ["run", "deploy", "--json", "--project", projectDir], { env: PERSON, launch: workers.launch });
    assert.equal(run.code, 0, run.out);
    const runId = json(run).runId as string;
    assert.equal((await workers.ended(runId))?.status, "completed");
    const line = oneNew(paths, 0, "sous run deploy");
    assert.equal(line.act, "run");
    assert.equal(line.by, "person");
    assert.deepEqual(line.through, { kind: "person" });
    assert.equal(line.runId, runId);
    assert.equal(line.workflow, "deploy");
  });

  it("an agent's rerun of a people run is refused the same way", async () => {
    const { paths, projectDir } = testHome({ deploy: fixture("deploy") });
    const workers = inProcess({ inner: runner });
    const run = await sous(paths, ["run", "deploy", "--json", "--project", projectDir], { env: PERSON, launch: workers.launch });
    assert.equal(run.code, 0, run.out);
    const runId = json(run).runId as string;
    await workers.ended(runId);
    const before = actions(paths).length;
    const rerun = await sous(paths, ["rerun", runId, "--json"], { env: CLAUDE, launch: workers.launch });
    assert.equal(rerun.code, 66, rerun.out);
    assert.equal(json(rerun).error?.code, "started_by_people", rerun.out);
    assert.equal(workers.launched.length, 1, "the rerun starts no worker");
    assert.equal(actions(paths).length, before, "the refused rerun adds no line");
  });

  // The daemon passes {by: "sous", through: {kind: "schedule", schedule}} itself and never reads
  // markers. A schedule may start a people workflow, since the person typed `sous schedule add`.
  it("a scheduled start by the daemon is no agent: its line names the schedule, whatever the markers", async () => {
    const { paths, projectDir } = testHome({ deploy: fixture("deploy"), hello: fixture("hello") });
    const createdAt = new Date().toISOString();
    writeFileSync(
      paths.schedules,
      JSON.stringify([
        { name: "nightly-deploy", workflow: "deploy", projectDir, cron: "* * * * *", inputs: {}, enabled: true, createdAt },
        { name: "morning-hello", workflow: "hello", projectDir, cron: "* * * * *", inputs: { name: "Ada" }, enabled: true, createdAt },
      ]),
    );
    const spawned: string[] = [];
    const logged: string[] = [];
    const before = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID: process.env.CODEX_THREAD_ID };
    Object.assign(process.env, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1", CODEX_THREAD_ID: "t1" });
    try {
      tick(paths, (_paths, runId) => spawned.push(runId), { log: (line) => logged.push(line), notify: () => {} });
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    assert.equal(spawned.length, 2, logged.join("\n"));
    const lines = actions(paths);
    assert.equal(lines.length, 2, JSON.stringify(lines));
    for (const [schedule, workflow] of [["nightly-deploy", "deploy"], ["morning-hello", "hello"]] as const) {
      const line = lines.find((item) => item.workflow === workflow);
      assert.ok(line, `a line for ${workflow}: ${JSON.stringify(lines)}`);
      assert.equal(line.act, "run");
      assert.equal(line.by, "sous");
      assert.deepEqual(line.through, { kind: "schedule", schedule });
      assert.ok(spawned.includes(line.runId!), JSON.stringify(line));
    }
  });
});

describe("piece 7: events.jsonl", () => {
  it("sous stop with CODEX_THREAD_ID=t1 adds one stop line by an agent through Codex", async () => {
    const { paths, projectDir } = testHome({ fails: fixture("fails") });
    const workers = inProcess({ inner: runner });
    const run = await sous(paths, ["run", "fails", "--json", "--project", projectDir], { env: PERSON, launch: workers.launch });
    const runId = json(run).runId as string;
    assert.equal((await workers.ended(runId))?.status, "paused");
    const before = actions(paths).length;
    const stop = await sous(paths, ["stop", runId, "--json"], { env: CODEX });
    assert.equal(stop.code, 0, stop.out);
    const line = oneNew(paths, before, "sous stop");
    assert.equal(line.act, "stop");
    assert.equal(line.runId, runId);
    assert.equal(line.by, "agent");
    assert.deepEqual(line.through, { kind: "agent", program: "codex", session: "t1" });
  });

  it("each write adds exactly one line: run, answer, rerun, pause, resume, stop and approve, and reads add none", async () => {
    const { paths, projectDir } = testHome({ asks: fixture("asks"), review: fixture("review") });
    const workers = inProcess({ inner: runner, handleSignals: true });
    const write = async (env: NodeJS.ProcessEnv, argv: string[], act: string) => {
      const before = actions(paths).length;
      const printed = await sous(paths, [...argv, "--json"], { env, launch: workers.launch });
      assert.equal(printed.code, 0, `${argv.join(" ")}:\n${printed.out}`);
      const line = oneNew(paths, before, `sous ${argv.join(" ")}`);
      assert.equal(line.act, act, JSON.stringify(line));
      return { reply: json(printed), line };
    };
    const reads = async (runId: string) => {
      const before = actions(paths).length;
      for (const argv of [["show", runId], ["show", runId, "--full"], ["status"], ["wait", runId, "--timeout", "1"], ["log", runId], ["step", runId, "ask 1"], ["list"], ["inbox"], ["workflows", "--project", projectDir]]) {
        await sous(paths, [...argv, "--json"], { env: CLAUDE, launch: workers.launch });
        assert.equal(actions(paths).length, before, `sous ${argv.join(" ")} is a read and adds no line`);
      }
    };

    try {
      // A person starts the run, and an agent passes on the person's answer.
      const { reply: started, line: run } = await write(PERSON, ["run", "asks", "--project", projectDir], "run");
      const first = started.runId as string;
      assert.equal(run.runId, first);
      assert.equal(run.workflow, "asks");
      assert.equal(run.by, "person");
      assert.deepEqual(run.through, { kind: "person" });
      const question = await asked(paths, first);
      await reads(first);
      const { line: answer } = await write(CLAUDE, ["answer", question, "blue", "--by", "person"], "answer");
      assert.equal(answer.runId, first);
      assert.equal(answer.question, question);
      assert.equal(answer.value, "blue");
      assert.equal(answer.by, "person");
      assert.deepEqual(answer.through, { kind: "agent", program: "claude", session: "s1" });
      assert.equal((await workers.ended(first))?.status, "completed");
      await reads(first);

      // The person runs it again. An agent pauses it at its question, another resumes and stops it.
      const { reply: again, line: rerun } = await write(PERSON, ["rerun", first], "rerun");
      const second = again.runId as string;
      assert.notEqual(second, first);
      assert.equal(rerun.runId, second, "the rerun's line names the new run");
      await asked(paths, second);
      const { line: pause } = await write(CLAUDE, ["pause", second], "pause");
      assert.equal(pause.runId, second);
      assert.equal(pause.by, "agent");
      assert.deepEqual(pause.through, { kind: "agent", program: "claude", session: "s1" });
      assert.equal((await workers.ended(second))?.status, "paused");
      const { line: resume } = await write(CODEX, ["resume", second], "resume");
      assert.equal(resume.runId, second);
      assert.deepEqual(resume.through, { kind: "agent", program: "codex", session: "t1" });
      await waitFor(() => readRun(paths, second).status === "asks", "the resumed run to ask again");
      const { line: stop } = await write(CODEX, ["stop", second], "stop");
      assert.equal(stop.runId, second);
      // A stopped resume rejects in the engine, so its worker gives no result. The run's view says it stopped.
      await workers.ended(second);
      assert.equal(readRun(paths, second).status, "stopped");

      // A person approves a breakpoint.
      const { reply: reviewed } = await write(PERSON, ["run", "review", "--project", projectDir], "run");
      const third = reviewed.runId as string;
      const breakpoint = await asked(paths, third);
      const { line: approve } = await write(PERSON, ["approve", breakpoint], "approve");
      assert.equal(approve.runId, third);
      assert.equal(approve.question, breakpoint);
      assert.equal(approve.by, "person");
      assert.equal((await workers.ended(third))?.status, "completed");
      await reads(third);
      assert.deepEqual(
        actions(paths).map((line) => line.act),
        ["run", "answer", "rerun", "pause", "resume", "stop", "run", "approve"],
      );
    } finally {
      // A failed check leaves a run waiting on its question. Stop it, so no worker outlives the test.
      for (const runId of new Set(workers.launched.map((item) => item.runId))) {
        if (["running", "asks"].includes(readRun(paths, runId).status)) await sous(paths, ["stop", runId, "--json"], { env: PERSON });
        await workers.ended(runId).catch(() => undefined);
      }
    }
  });

  it("markers come from the env main is given, not from process.env", async () => {
    const { paths, projectDir } = testHome({ fails: fixture("fails") });
    const workers = inProcess({ inner: runner });
    const run = await sous(paths, ["run", "fails", "--json", "--project", projectDir], { env: PERSON, launch: workers.launch });
    const runId = json(run).runId as string;
    await workers.ended(runId);
    const before = actions(paths).length;
    const saved = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      assert.equal((await sous(paths, ["stop", runId, "--json"], { env: PERSON })).code, 0);
    } finally {
      if (saved === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = saved;
    }
    const line = oneNew(paths, before, "sous stop");
    assert.equal(line.by, "person");
    assert.deepEqual(line.through, { kind: "person" });
  });
});

describe("piece 7: --by on the command line", () => {
  it("--by person from a step of a run exits 66 with no_person_here, stops nothing and adds no line", async () => {
    const { paths, projectDir } = testHome({ fails: fixture("fails") });
    const workers = inProcess({ inner: runner });
    const run = await sous(paths, ["run", "fails", "--json", "--project", projectDir], { env: PERSON, launch: workers.launch });
    const runId = json(run).runId as string;
    await workers.ended(runId);
    const before = actions(paths).length;
    const refused = await sous(paths, ["stop", runId, "--by", "person", "--json"], { env: RUN_STEP });
    assert.equal(refused.code, 66, refused.out);
    const { error } = json(refused);
    assert.equal(error?.code, "no_person_here", refused.out);
    assert.equal(error.call, null, refused.out);
    assert.equal(readRun(paths, runId).status, "paused", "the run is not stopped");
    assert.equal(actions(paths).length, before);
  });

  it("--by with another value than person is a bad argument, and the write does not happen", async () => {
    const { paths, projectDir } = testHome({ fails: fixture("fails") });
    const workers = inProcess({ inner: runner });
    const run = await sous(paths, ["run", "fails", "--json", "--project", projectDir], { env: PERSON, launch: workers.launch });
    const runId = json(run).runId as string;
    await workers.ended(runId);
    const before = actions(paths).length;
    const refused = await sous(paths, ["stop", runId, "--by", "agent", "--json"], { env: CLAUDE });
    assert.equal(refused.code, 64, refused.out);
    assert.equal(json(refused).error?.code, "bad_argument", refused.out);
    assert.equal(readRun(paths, runId).status, "paused", "the run is not stopped");
    assert.equal(actions(paths).length, before);
    const read = await sous(paths, ["status", "--by", "robot", "--json"], { env: CLAUDE });
    assert.equal(read.code, 64, read.out);
  });

  // A read decides nothing, so --by person on it changes nothing. That is no cheat and no broken
  // record, so the read works and says so in a note, as the owner's rule for refusals asks.
  it("--by person on a read exits 0 with a note, and adds no line", async () => {
    const { paths, projectDir } = testHome({ fails: fixture("fails") });
    const workers = inProcess({ inner: runner });
    const run = await sous(paths, ["run", "fails", "--json", "--project", projectDir], { env: PERSON, launch: workers.launch });
    const runId = json(run).runId as string;
    await workers.ended(runId);
    const before = actions(paths).length;
    for (const argv of [["show", runId], ["status"]]) {
      const read = await sous(paths, [...argv, "--by", "person", "--json"], { env: CLAUDE });
      assert.equal(read.code, 0, read.out);
      const notes = json(read).notes as string[];
      assert.ok(notes.some((note) => note.includes("--by")), `sous ${argv[0]} --by person notes that a read records no decision: ${read.out}`);
    }
    assert.equal(actions(paths).length, before);
  });

  it("sous run takes --by person: an agent starts an anyone workflow for the person, and the line keeps both", async () => {
    const { paths, projectDir } = testHome({ hello: fixture("hello") });
    const workers = inProcess({ inner: runner });
    const run = await sous(paths, ["run", "hello", "--name", "Ada", "--by", "person", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
    assert.equal(run.code, 0, run.out);
    const runId = json(run).runId as string;
    assert.equal((await workers.ended(runId))?.status, "completed");
    const line = oneNew(paths, 0, "sous run hello --by person");
    assert.equal(line.act, "run");
    assert.equal(line.by, "person");
    assert.deepEqual(line.through, { kind: "agent", program: "claude", session: "s1" });
  });
});

describe("piece 7: the call trace", () => {
  it("with SOUS_TRACE_CALLS=1, two calls add two lines to calls.jsonl, and the refused one carries its code", async () => {
    const { paths, projectDir } = testHome({ deploy: fixture("deploy") });
    const env = { ...CLAUDE, SOUS_TRACE_CALLS: "1" };
    const refusedArgv = ["run", "deploy", "--json", "--project", projectDir];
    assert.equal((await sous(paths, refusedArgv, { env, launch: inProcess({ inner: runner }).launch })).code, 66);
    assert.equal((await sous(paths, ["status", "--json"], { env })).code, 0);
    const calls = traced(paths);
    assert.equal(calls.length, 2, JSON.stringify(calls));
    const [refused, status] = calls;
    assert.deepEqual(refused!.argv, refusedArgv);
    assert.equal(refused!.exit, 66);
    assert.equal(refused!.code, "started_by_people");
    assert.deepEqual(refused!.through, { kind: "agent", program: "claude", session: "s1" });
    assert.equal(typeof refused!.at, "string");
    assert.deepEqual(status!.argv, ["status", "--json"]);
    assert.equal(status!.exit, 0);
    assert.equal(status!.code, undefined);
  });

  it("without SOUS_TRACE_CALLS sous writes no calls.jsonl", async () => {
    const { paths } = testHome();
    assert.equal((await sous(paths, ["status", "--json"], { env: CLAUDE })).code, 0);
    assert.equal(existsSync(join(paths.home, "calls.jsonl")), false);
    // The test above fails until the trace exists, so this one checks that its file is the one the
    // trace writes: it fails with the trace on.
    assert.equal((await sous(paths, ["status", "--json"], { env: { ...CLAUDE, SOUS_TRACE_CALLS: "1" } })).code, 0);
    assert.equal(traced(paths).length, 1);
  });
});

describe("piece 7: the wait of an agent", () => {
  /** A run whose worker is this process, so it runs until the test ends it. */
  function liveRun(): { paths: HomePaths; runId: string; end: () => void } {
    const { paths, projectDir } = testHome();
    const runId = "run-live";
    const at = new Date().toISOString();
    writeFileSync(
      join(paths.records, `${runId}.json`),
      JSON.stringify({ runId, workflow: "build", file: join(projectDir, ".sous", "workflows", "build.js"), args: {}, place: "folder", cwd: projectDir, projectDir, priority: "user", origin: "cli", createdAt: at, pid: process.pid }),
    );
    plantState(paths, { runId, workflowName: "build", script: "return 1", phases: [], agents: [], logs: [], status: "running", startedAt: at, updatedAt: at }, "");
    return { paths, runId, end: () => updateRecord(paths, runId, { pid: deadPid() }) };
  }

  /** Whether the promise settled within `ms` of real time. */
  async function settles(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let done = false;
    void promise.then(() => (done = true), () => (done = true));
    for (let waited = 0; waited < ms && !done; waited += 50) await new Promise((r) => setTimeout(r, 50));
    return done;
  }

  // Claude Code stops a tool call after two minutes, so an agent's wait without --timeout ends at
  // 110 seconds, exits 5 and says so in a note. A person waits as long as it takes. The clock is
  // mocked, and the wait's polls run on real timers.
  it("without --timeout, an agent's wait ends after 110 seconds with exit 5 and a note, and a person's does not", async () => {
    const agent = liveRun();
    const person = liveRun();
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      const agentWait = sous(agent.paths, ["wait", agent.runId, "--json"], { env: CLAUDE });
      await new Promise((r) => setTimeout(r, 100));
      mock.timers.tick(109_000);
      assert.equal(await settles(agentWait, 600), false, "the agent's wait goes on before 110 seconds");
      mock.timers.tick(2_000);
      assert.equal(await settles(agentWait, 2_000), true, "the agent's wait ends after 110 seconds");
      const waited = await agentWait;
      assert.equal(waited.code, 5, waited.out);
      const reply = json(waited);
      assert.equal(reply.status, "running");
      assert.ok((reply.notes as string[]).some((note) => note.includes("110")), `a note gives the 110 seconds: ${waited.out}`);

      const personWait = sous(person.paths, ["wait", person.runId, "--json"], { env: PERSON });
      await new Promise((r) => setTimeout(r, 100));
      mock.timers.tick(600_000);
      assert.equal(await settles(personWait, 900), false, "a person's wait has no default timeout");
      person.end();
      assert.equal(await settles(personWait, 2_000), true);
    } finally {
      // A wait still going ends once its run's worker is dead, so no wait outlives the test.
      for (const run of [agent, person]) if (loadRecord(run.paths, run.runId)?.pid === process.pid) run.end();
      mock.timers.reset();
    }
  });
});

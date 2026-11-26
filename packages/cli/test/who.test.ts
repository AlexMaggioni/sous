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
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { addAccount, listRecords, loadRecord, logFile, readRun, rememberProject, runQuestions, type HomePaths } from "@sous-run/engine";
import { createRun, fakeRunner, inProcess, plantState, testHome, tick, updateRecord, PERSON as PERSON_WHO, type InnerRunner } from "@sous-run/engine/testing";
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
const ACTION_KEYS = new Set(["at", "act", "by", "through", "runId", "workflow", "question", "prompt", "schedule", "step", "value", "text", "hash"]);

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
    // sous has run in this project before, so its workflows are approved as they are.
    rememberProject(paths, projectDir);
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

// Review fixes. A run an agent or a step started may not reach a people workflow through a nested
// workflow() or choose(), and its resume and rerun by an agent stay refused. A person's start and
// rerun reach it. The record keeps who started the run, so the worker knows it.
describe("piece 7: people workflows inside a run", () => {
  const wrapper = `export const meta = { name: "wrapper", description: "Runs deploy inside", place: "none" }\nreturn await workflow("deploy")`;

  /** Start the wrapper as `env`, and give its run and how it ended. */
  async function wrapped(paths: HomePaths, projectDir: string, env: NodeJS.ProcessEnv, workers = inProcess({ inner: runner })) {
    const run = await sous(paths, ["run", "wrapper", "--json", "--project", projectDir], { env, launch: workers.launch });
    assert.equal(run.code, 0, run.out);
    const runId = json(run).runId as string;
    return { runId, ended: await workers.ended(runId).catch((error: unknown) => ({ status: "threw", error })), workers };
  }

  it("an open workflow that calls workflow(\"deploy\") does not deploy for an agent or a step of a run", async () => {
    for (const env of [CLAUDE, CODEX, RUN_STEP]) {
      const { paths, projectDir } = testHome({ deploy: fixture("deploy"), wrapper });
      rememberProject(paths, projectDir);
      const { runId, ended } = await wrapped(paths, projectDir, env);
      assert.notEqual(ended?.status, "completed", `${JSON.stringify(env)}: the wrapper ran deploy to the end`);
      assert.match(JSON.stringify(readRun(paths, runId)), /started_by_people|started by people/, `${JSON.stringify(env)}: the run says why`);
      assert.doesNotMatch(readFileSync(logFile(paths, runId), "utf8"), /deployed to/, "deploy's step never ran");
    }
  });

  it("a resume or a rerun of that run stays refused, and a person's start and rerun deploy", async () => {
    const { paths, projectDir } = testHome({ deploy: fixture("deploy"), wrapper });
    rememberProject(paths, projectDir);
    const workers = inProcess({ inner: runner });
    const { runId } = await wrapped(paths, projectDir, CLAUDE, workers);
    for (const [env, argv] of [[PERSON, ["resume", runId]], [CLAUDE, ["rerun", runId]]] as const) {
      const again = await sous(paths, [...argv, "--json"], { env, launch: workers.launch });
      const id = (json(again).runId as string | undefined) ?? runId;
      const ended = await workers.ended(id).catch(() => undefined);
      assert.notEqual(ended?.status, "completed", `${argv.join(" ")}: ${again.out}`);
    }
    const person = await wrapped(paths, projectDir, PERSON, workers);
    assert.equal(person.ended?.status, "completed", JSON.stringify(person.ended));
    const rerun = await sous(paths, ["rerun", runId, "--json"], { env: PERSON, launch: workers.launch });
    assert.equal(rerun.code, 0, rerun.out);
    assert.equal((await workers.ended(json(rerun).runId as string))?.status, "completed", "a person's rerun deploys");
  });

  it("choose() in a run an agent started does not pick a people workflow", async () => {
    const picker = `export const meta = { name: "picker", description: "lets an agent pick", place: "none" }\nreturn await choose("Pick one", { workflows: ["deploy"] })`;
    const { paths, projectDir } = testHome({ deploy: fixture("deploy"), picker });
    rememberProject(paths, projectDir);
    const { runner: picks } = fakeRunner(() => ({ choice: "deploy", reason: "it ships" }));
    const workers = inProcess({ inner: picks });
    const run = await sous(paths, ["run", "picker", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
    assert.equal(run.code, 0, run.out);
    const runId = json(run).runId as string;
    const ended = await workers.ended(runId).catch(() => undefined);
    assert.notEqual(ended?.status, "completed", "the agent's run picked deploy and ran it");
    assert.doesNotMatch(readFileSync(logFile(paths, runId), "utf8"), /deployed to/);
  });
});

describe("piece 7: every write once", () => {
  const STEP = `export const meta = { name: "one", description: "one step", place: "none" }\nreturn await agent("build it", { label: "build" })`;
  const commitAll = (dir: string) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: dir });

  /** A home whose project is a git repository, with one finished run in a worktree of its own. */
  function finishedInWorktree() {
    const made = testHome({ hello: fixture("hello").replace('place: "none"', 'place: "worktree"') }, { defaultPlace: "worktree" });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: made.projectDir });
    commitAll(made.projectDir);
    const record = createRun(made.paths, { who: PERSON_WHO, workflow: "hello", projectDir: made.projectDir, inputs: { name: "Ada" } });
    const at = new Date().toISOString();
    plantState(made.paths, { runId: record.runId, status: "completed", startedAt: at, updatedAt: at, agents: [], logs: [], phases: [] });
    return { ...made, record };
  }

  /** A home with one schedule of hello, enabled or not. */
  function scheduled(enabled: boolean, workflow = "hello") {
    const made = testHome({ hello: fixture("hello"), deploy: fixture("deploy") });
    const file = join(made.projectDir, ".sous", "workflows", `${workflow}.js`);
    writeFileSync(made.paths.schedules, JSON.stringify([{ name: "morning", workflow: file, projectDir: made.projectDir, cron: "0 9 * * *", inputs: { name: "Ada" }, enabled, createdAt: new Date().toISOString() }]));
    return made;
  }

  /** A home of its own for skill and hook, under the temporary folder: HOME and CLAUDE_CONFIG_DIR
   *  point there, in process.env and in the env main reads. */
  function ownHome() {
    const home = mkdtempSync(join(tmpdir(), "sous-who-home-"));
    return { ...testHome(), moved: { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude-config") } };
  }
  async function inHome(made: ReturnType<typeof ownHome>, argv: string[], env: NodeJS.ProcessEnv) {
    const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    Object.assign(process.env, made.moved);
    try {
      return await sous(made.paths, argv, { env: { ...env, ...made.moved } });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  interface Write {
    act: string;
    env: NodeJS.ProcessEnv;
    /** Makes the home, and gives the call, how to make it and what else the line holds. */
    prepare(): Promise<{ paths: HomePaths; argv: string[]; call?: (argv: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; out: string }>; expect?: Record<string, unknown>; done?: () => Promise<unknown> }>;
  }

  const WRITES: Write[] = [
    {
      act: "send-back",
      env: CLAUDE,
      async prepare() {
        const { paths, projectDir } = testHome({ review: fixture("review") });
        const workers = inProcess({ inner: runner, handleSignals: true });
        const runId = json(await sous(paths, ["run", "review", "--json", "--project", projectDir], { env: PERSON, launch: workers.launch })).runId as string;
        const id = await asked(paths, runId);
        const done = async () => (await sous(paths, ["stop", runId, "--json"], { env: PERSON }), await workers.ended(runId).catch(() => undefined));
        return { paths, argv: ["send-back", id, "shorter", "--by", "person"], expect: { runId, question: id, text: "shorter", by: "person" }, done };
      },
    },
    {
      act: "stop-step",
      env: CODEX,
      async prepare() {
        const { paths, projectDir } = testHome({ one: STEP });
        const { runner: hangs, calls } = fakeRunner((call) => new Promise((_, reject) => (call.options.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted")))));
        const workers = inProcess({ inner: hangs, handleSignals: true });
        const runId = json(await sous(paths, ["run", "one", "--json", "--project", projectDir], { env: PERSON, launch: workers.launch })).runId as string;
        await waitFor(() => calls.some((call) => call.label === "build"), "the step to start");
        return { paths, argv: ["stop", runId, "--step", "build"], expect: { runId, step: "build" }, done: () => workers.ended(runId).catch(() => undefined) };
      },
    },
    {
      act: "discard",
      env: CLAUDE,
      async prepare() {
        const { paths, record } = finishedInWorktree();
        return { paths, argv: ["discard", record.runId, "--yes"], expect: { runId: record.runId, workflow: "hello" } };
      },
    },
    {
      act: "gc",
      env: PERSON,
      async prepare() {
        const { paths, record } = finishedInWorktree();
        return { paths, argv: ["gc"], expect: { value: [record.branch] } };
      },
    },
    {
      act: "prune",
      env: CODEX,
      async prepare() {
        const { paths, projectDir } = testHome({ hello: fixture("hello") });
        const record = createRun(paths, { who: PERSON_WHO, workflow: "hello", projectDir, inputs: { name: "Ada" } });
        updateRecord(paths, record.runId, { createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString() });
        const at = new Date().toISOString();
        plantState(paths, { runId: record.runId, status: "completed", startedAt: at, updatedAt: at, agents: [], logs: [], phases: [] });
        return { paths, argv: ["prune", "--days", "5"], expect: { value: [record.runId] } };
      },
    },
    {
      act: "schedule-add",
      env: CLAUDE,
      async prepare() {
        const { paths, projectDir } = testHome({ hello: fixture("hello") });
        return { paths, argv: ["schedule", "add", "morning", "hello", "--cron", "0 9 * * *", "--name", "Ada", "--project", projectDir], expect: { schedule: "morning", workflow: "hello" } };
      },
    },
    { act: "schedule-remove", env: CLAUDE, prepare: async () => ({ paths: scheduled(true).paths, argv: ["schedule", "remove", "morning"], expect: { schedule: "morning" } }) },
    { act: "schedule-enable", env: CODEX, prepare: async () => ({ paths: scheduled(false).paths, argv: ["schedule", "enable", "morning"], expect: { schedule: "morning" } }) },
    { act: "schedule-disable", env: PERSON, prepare: async () => ({ paths: scheduled(true).paths, argv: ["schedule", "disable", "morning"], expect: { schedule: "morning" } }) },
    {
      act: "account-use",
      env: CLAUDE,
      async prepare() {
        const { paths } = testHome();
        addAccount(paths, "spare", "sk-ant-oat01-made-up-spare-token");
        return { paths, argv: ["account", "use", "spare"], expect: { value: "claude/spare" } };
      },
    },
    {
      act: "skill-install",
      env: CLAUDE,
      async prepare() {
        const made = ownHome();
        return { paths: made.paths, argv: ["skill", "install"], call: (argv, env) => inHome(made, argv, env) };
      },
    },
    {
      act: "hook-install",
      env: CLAUDE,
      async prepare() {
        const made = ownHome();
        return { paths: made.paths, argv: ["hook", "install"], call: (argv, env) => inHome(made, argv, env) };
      },
    },
    {
      act: "hook-remove",
      env: PERSON,
      async prepare() {
        const made = ownHome();
        assert.equal((await inHome(made, ["hook", "install", "--json"], PERSON)).code, 0);
        return { paths: made.paths, argv: ["hook", "remove"], call: (argv, env) => inHome(made, argv, env) };
      },
    },
  ];

  const whoOf = (env: NodeJS.ProcessEnv): Through =>
    env === CLAUDE ? { kind: "agent", program: "claude", session: "s1" } : env === CODEX ? { kind: "agent", program: "codex", session: "t1" } : { kind: "person" };

  for (const write of WRITES) {
    it(`sous ${write.act} adds exactly one ${write.act} line`, async () => {
      const { paths, argv, call, expect = {}, done } = await write.prepare();
      try {
        const before = actions(paths).length;
        const printed = await (call ?? ((args, env) => sous(paths, args, { env })))([...argv, "--json"], write.env);
        assert.equal(printed.code, 0, `${argv.join(" ")}:\n${printed.out}`);
        const line = oneNew(paths, before, `sous ${argv.join(" ")}`);
        assert.equal(line.act, write.act, JSON.stringify(line));
        assert.equal(line.by, expect.by ?? (write.env === PERSON ? "person" : "agent"), JSON.stringify(line));
        assert.deepEqual(line.through, whoOf(write.env), JSON.stringify(line));
        for (const [key, value] of Object.entries(expect)) if (key !== "by") assert.deepEqual(line[key], value, `${key}: ${JSON.stringify(line)}`);
        if (write.act === "send-back") assert.match(String(line.prompt), /Approve the release notes/, "the line keeps the question's text");
      } finally {
        await done?.();
      }
    });
  }

  it("a read adds no line: schedule list and test, account list, skill path and check, discard without --yes, gc --dry-run", async () => {
    const { paths, record } = finishedInWorktree();
    writeFileSync(paths.schedules, JSON.stringify([{ name: "morning", workflow: record.file, projectDir: record.projectDir, cron: "0 9 * * *", inputs: { name: "Ada" }, enabled: true, createdAt: new Date().toISOString() }]));
    const made = { ...ownHome(), paths };
    const before = actions(paths).length;
    for (const argv of [["schedule", "list"], ["schedule", "test", "morning"], ["account", "list"], ["skill", "path"], ["skill", "check"], ["discard", record.runId], ["gc", "--dry-run"], ["guide", "start"]]) {
      const printed = await inHome(made, [...argv, "--json"], CLAUDE);
      assert.equal(printed.code, 0, `${argv.join(" ")}:\n${printed.out}`);
      assert.equal(actions(paths).length, before, `sous ${argv.join(" ")} is a read and adds no line`);
    }
  });

  it("a write that changes nothing adds no line", async () => {
    const made = ownHome();
    assert.equal((await inHome(made, ["skill", "install", "--json"], CLAUDE)).code, 0);
    const before = actions(made.paths).length;
    assert.equal(before, 1, "the first install adds its line");
    for (const argv of [["skill", "install"], ["hook", "remove"], ["gc"], ["prune", "--days", "5"]]) {
      const printed = await inHome(made, [...argv, "--json"], CLAUDE);
      assert.equal(printed.code, 0, `${argv.join(" ")}:\n${printed.out}`);
      assert.equal(actions(made.paths).length, before, `sous ${argv.join(" ")} changed nothing and adds no line`);
    }
    const { paths } = scheduled(true);
    for (const argv of [["schedule", "enable", "morning"], ["schedule", "disable", "morning"], ["schedule", "disable", "morning"]]) await sous(paths, [...argv, "--json"], { env: CLAUDE });
    assert.deepEqual(actions(paths).map((line) => line.act), ["schedule-disable"], "enabling an enabled schedule and disabling a disabled one add no line");

    // A run with no worktree has nothing to discard.
    const none = testHome({ hello: fixture("hello") });
    const record = createRun(none.paths, { who: PERSON_WHO, workflow: "hello", projectDir: none.projectDir, inputs: { name: "Ada" } });
    const at = new Date().toISOString();
    plantState(none.paths, { runId: record.runId, status: "completed", startedAt: at, updatedAt: at, agents: [], logs: [], phases: [] });
    const started = actions(none.paths).length;
    const discarded = await sous(none.paths, ["discard", record.runId, "--yes", "--json"], { env: CLAUDE });
    assert.equal(discarded.code, 0, discarded.out);
    assert.equal(actions(none.paths).length, started, "a discard that removed nothing adds no line");
  });

  it("an agent may not enable a people schedule the person disabled, and the refusal adds no line", async () => {
    const { paths } = scheduled(false, "deploy");
    const refused = await sous(paths, ["schedule", "enable", "morning", "--json"], { env: CLAUDE });
    assert.equal(refused.code, 66, refused.out);
    const { error } = json(refused);
    assert.equal(error?.code, "started_by_people", refused.out);
    assert.match(error.forPerson, /^sous schedule enable morning/, refused.out);
    assert.equal(JSON.parse(readFileSync(paths.schedules, "utf8"))[0].enabled, false, "the schedule stays disabled");
    assert.deepEqual(actions(paths), []);
    const person = await sous(paths, ["schedule", "enable", "morning", "--json"], { env: PERSON });
    assert.equal(person.code, 0, person.out);
  });

  it("the text form of started_by_people prints the command for the person on its own line", async () => {
    const { paths, projectDir } = testHome({ deploy: fixture("deploy") });
    const refused = await sous(paths, ["run", "deploy", "--project", projectDir], { env: CLAUDE, launch: inProcess({ inner: runner }).launch });
    assert.equal(refused.code, 66, refused.out);
    assert.match(refused.out, /\n  for the person: sous run deploy( |\n)/, refused.out);
  });

  it("sous help lists --by person on answer, approve and send-back", async () => {
    const { paths } = testHome();
    const help = (await sous(paths, ["help"])).out.split("\n");
    for (const command of ["answer", "approve", "send-back"]) {
      const at = help.findIndex((line) => line.trimStart().startsWith(`sous ${command} `));
      assert.ok(at >= 0, `sous help lists ${command}`);
      let end = at + 1;
      while (/^ {8}-/.test(help[end] ?? "")) end++;
      assert.match(help.slice(at + 1, end).join("\n"), /--by person/, `the flags of sous ${command} give --by person:\n${help.slice(at, end).join("\n")}`);
    }
  });
});

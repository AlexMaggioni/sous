// sous join on the fake programs. An agent step of a run holds its turn open, or asks through its
// program's own question tool, and the person steps into the step's session from a terminal. The
// terminal is a machine of the test's own: its openProgram runs the fake program the way the real
// one runs Claude Code or Codex, and the fake types the person's line into the session and leaves.
// The step then goes on in the same session, and the recall rule shows that the session kept the
// person's line. The run itself goes on in a worker process of its own, as it does for a person.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { logFile, readRun } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import type { Machine } from "../src/commands/index.js";
import { fakeWorld, type FakeLine, type FakeRule, type FakeWorld } from "./helpers/fake-world.js";
import { sous } from "./sous.js";

const CANARY = "PELICAN-4417";
/** The fakes' line for the person, when FAKE_PERSON is not set. */
const PERSON_WORD = "KESTREL-5150";
const PROMPT = `Build it. Keep this word in mind: ${CANARY}.`;
const CONTINUE = "Continue the task.";
const QUESTION = "Which API should I call?";

/** The turn runs a tool call, then holds until the file "release" exists or the turn stops. The
 *  tool call's message is what tells the engine the program has the prompt. */
const HELD: FakeRule[] = [
  { match: "^Build it", tool: "echo working", hold: "release", answer: "Done." },
  { match: CONTINUE, recall: true },
];

/** The turn asks the person through the program's own question tool. */
const ASKS: FakeRule[] = [
  { match: "^Build it", ask: QUESTION, answer: "Never." },
  { match: CONTINUE, recall: true },
];

const script = (model: string) => `export const meta = { name: 'joined', description: 'One agent step the person steps into' }
await sh('echo ready', { label: 'setup' })
return await agent(${JSON.stringify(PROMPT)}, { label: 'impl', model: '${model}', until: 'turn' })`;

/** The fakes' turns: the log lines that carry a prompt. */
const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

interface Terminal {
  machine: Machine;
  /** The programs openProgram ran. */
  opened: Array<{ path: string; args: string[]; cwd: string }>;
  /** What sous asked in the terminal. */
  asked: string[];
  out: string[];
  err: string[];
  /** The private folders sous made, and whether each is gone. */
  folders: string[];
  /** Press Ctrl-C. */
  stop(): void;
}

/** A terminal for the world: ask gives the `answers` in turn, then "". `onErr` sees each line
 *  sous prints to stderr. */
function terminal(world: FakeWorld, answers: string[] = [], onErr?: (line: string, stop: () => void) => void): Terminal {
  const no = () => {
    throw new Error("the terminal machine does not do this");
  };
  const opened: Terminal["opened"] = [];
  const asked: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const folders: string[] = [];
  const stops: Array<() => void> = [];
  const machine: Machine = {
    readText: (file) => readFileSync(file, "utf8"),
    exists: (file) => existsSync(file),
    guideDir: "",
    skillDir: "",
    spawnDaemon: no,
    kill: no,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    version: "0.0.0",
    cliPath: "",
    latestVersion: no,
    run: no,
    isTerminal: true,
    ask: async (prompt) => {
      asked.push(prompt);
      return answers.shift() ?? "";
    },
    open: no,
    untilStopped: no,
    onStop(stop) {
      stops.push(stop);
      return () => void stops.splice(stops.indexOf(stop), 1);
    },
    openProgram: (program) =>
      new Promise((done) => {
        opened.push({ path: program.path, args: program.args, cwd: program.cwd });
        // The fakes find their sessions next to the log, which only the world's commands are told.
        const env = { ...program.env, FAKE_LOG: world.logFile, FAKE_RULES: join(world.dir, "rules.json") };
        const child = spawn(program.path, program.args, { cwd: program.cwd, env, stdio: ["ignore", "ignore", "pipe"] });
        child.on("error", () => done(127));
        child.on("exit", (code) => done(code ?? 1));
      }),
    privateFolder() {
      const dir = mkdtempSync(join(tmpdir(), "sous-join-test-"));
      folders.push(dir);
      return {
        write(name, text) {
          const file = join(dir, name);
          writeFileSync(file, text, { mode: 0o600 });
          return file;
        },
        remove: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
    out: (line) => out.push(line),
    write: (text) => out.push(text),
    err: (line) => {
      err.push(line);
      onErr?.(line, stop);
    },
  };
  const stop = () => [...stops].forEach((one) => one());
  return { machine, opened, asked, out, err, folders, stop };
}

/** The JSON a --json command printed. */
const json = <T = Record<string, unknown>>(lines: string[]): T => JSON.parse(lines.join("\n")) as T;

/** Start the run, and give its id once the step's turn runs with its prompt delivered. */
async function started(world: FakeWorld, ready: (runId: string) => boolean): Promise<string> {
  const run = await world.sous("run", "joined", "--json");
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const runId = (JSON.parse(run.stdout) as { runId: string }).runId;
  for (let i = 0; i < 400; i++) {
    if (ready(runId)) return runId;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`the step never got there:\n${JSON.stringify(readState(world.paths, runId), null, 2)}`);
}

/** The step's turn runs, and its program has the prompt. */
const heldTurn = (world: FakeWorld) => (runId: string) => {
  const row = readState(world.paths, runId)?.agents?.find((agent) => agent.status === "running" && agent.session !== undefined);
  return Boolean(row?.session && row.session.delivered !== false && turns(world.log()).some((line) => line.prompt === PROMPT));
};

/** The step asked the person. */
const asking = (world: FakeWorld) => (runId: string) => readRun(world.paths, runId).status === "asks";

/** Wait for the run in JSON, and give its exit code and reply. */
async function waited(world: FakeWorld, runId: string) {
  const end = await world.sous("wait", runId, "--timeout", "30", "--json");
  return { code: end.code, reply: JSON.parse(end.stdout) as { status: string; result?: unknown; notes: string[]; next: Array<{ call: string }> }, stderr: end.stderr };
}

for (const [program, model, name] of [
  ["claude", "claude/haiku", "Claude Code"],
  ["codex", "codex/gpt-fake", "Codex"],
] as const) {
  describe(`sous join on the fake ${program}`, () => {
    it("takes the session from a running turn, opens the program in it, and the step goes on in the session when the person leaves", async (t) => {
      const world = fakeWorld(t, { rules: HELD });
      world.workflow("joined", script(model));
      const runId = await started(world, heldTurn(world));
      const held = turns(world.log()).find((line) => line.prompt === PROMPT)!;

      const here = terminal(world);
      const joined = await sous(world.paths, ["join", runId, "impl", "--json"], { machine: here.machine });

      assert.equal(joined.code, 0, `${here.out.join("\n")}\n${here.err.join("\n")}`);
      const reply = json<{ runId: string; step: string; call: number; sessionId: string; program: string; cwd: string; exit: number; answered: string | null }>(here.out);
      assert.deepEqual(
        [reply.runId, reply.step, reply.call, reply.sessionId, reply.program, reply.cwd, reply.exit, reply.answered],
        [runId, "impl", 1, held.sessionId, name, held.cwd, 0, null],
      );
      assert.equal(here.opened.length, 1, "one program opened");
      assert.equal(here.opened[0]!.cwd, held.cwd, "in the session's folder");
      assert.ok(
        here.err.some((line) => line.startsWith(`opening ${name} in ${held.cwd}, in the session of "impl".`)),
        here.err.join("\n"),
      );
      assert.ok(here.folders.every((dir) => !existsSync(dir)), "the private folder is gone");

      const byHand = world.log().filter((line) => line.byHand);
      assert.deepEqual(
        byHand.map((line) => [line.program, line.sessionId, line.cwd]),
        [[program, held.sessionId, held.cwd]],
        "the person's program opened the step's session in its folder",
      );

      const end = await waited(world, runId);
      assert.equal(end.code, 0, `${JSON.stringify(end.reply)}\n${end.stderr}`);
      assert.equal(end.reply.result, `${CANARY} ${PERSON_WORD}`, "the session kept the prompt and the person's line");
      const after = turns(world.log()).filter((line) => line.prompt === CONTINUE);
      assert.deepEqual(
        after.map((line) => line.sessionId),
        [held.sessionId],
        "the step went on once, in its session",
      );
      assert.equal(after[0]!.cwd, held.cwd);
      assert.equal(turns(world.log()).filter((line) => line.prompt === PROMPT).length, 1, "the held turn was not asked again");
    });

    it("answers the question the agent asked through its program once the person leaves, and the run goes on", async (t) => {
      const world = fakeWorld(t, { rules: ASKS });
      world.workflow("joined", script(model));
      const runId = await started(world, asking(world));

      const asks = await waited(world, runId);
      assert.equal(asks.code, 4, JSON.stringify(asks.reply));
      assert.equal(asks.reply.status, "asks");
      assert.ok(
        asks.reply.notes.includes(`"impl" needs the person, in its session. Ask them to run sous join ${runId} impl in a terminal of their own. The step goes on once they leave it.`),
        asks.reply.notes.join("\n"),
      );
      assert.ok(!asks.reply.next.some((next) => next.call.startsWith("sous answer")), "no one answers it with sous answer");
      // The agent's question stays in its session. Every place sous shows it names the step.
      const log = readFileSync(logFile(world.paths, runId), "utf8");
      assert.match(log, new RegExp(`question .*: "impl" needs you in its session\\.\n +step in with: sous join ${runId} impl\n`));
      assert.ok(!log.includes(QUESTION), log);
      assert.ok(!JSON.stringify(asks.reply).includes(QUESTION), JSON.stringify(asks.reply));
      const inbox = await sous(world.paths, ["inbox"]);
      assert.ok(inbox.out.includes(`  "impl" needs you in its session.\n  sous join ${runId} impl`), inbox.out);
      assert.ok(!inbox.out.includes(QUESTION), inbox.out);

      const here = terminal(world);
      const joined = await sous(world.paths, ["join", runId, "impl"], { machine: here.machine });
      assert.equal(joined.code, 0, `${here.out.join("\n")}\n${here.err.join("\n")}`);
      assert.ok(here.err.includes(`"impl" asked you a question in its session.`), here.err.join("\n"));
      assert.ok(![...here.out, ...here.err].some((line) => line.includes(QUESTION)), here.err.join("\n"));
      assert.equal(here.out[0], `left the session of "impl" in ${runId}.`);
      assert.equal(here.out[1], `"impl" has its answer and goes on in its session.`);

      const end = await waited(world, runId);
      assert.equal(end.code, 0, `${JSON.stringify(end.reply)}\n${end.stderr}`);
      assert.equal(end.reply.result, `${CANARY} ${PERSON_WORD}`);
      const asked = turns(world.log());
      assert.deepEqual(
        asked.map((line) => line.prompt),
        [PROMPT, CONTINUE],
      );
      assert.equal(asked[1]!.sessionId, asked[0]!.sessionId);
    });
  });
}

describe("sous join in a terminal on the fake claude", () => {
  it("stops waiting on Ctrl-C, opens nothing, and the step goes on in its session", async (t) => {
    const world = fakeWorld(t, { rules: HELD });
    world.workflow("joined", script("claude/haiku"));
    const runId = await started(world, heldTurn(world));
    const held = turns(world.log()).find((line) => line.prompt === PROMPT)!;

    // The person presses Ctrl-C while sous waits for the turn to hand its session over.
    const here = terminal(world, [], (line, stop) => {
      if (line.startsWith("waiting for")) stop();
    });
    const joined = await sous(world.paths, ["join", runId, "impl", "--json"], { machine: here.machine });

    assert.equal(joined.code, 130, `${here.out.join("\n")}\n${here.err.join("\n")}`);
    assert.deepEqual(json(here.out), { runId, step: "impl", joined: false, notes: [], next: [] });
    assert.ok(here.err.includes(`waiting for "impl" to hand its session over. Its turn stops once its program has the prompt.`), here.err.join("\n"));
    assert.equal(here.opened.length, 0);
    assert.ok(here.folders.every((dir) => !existsSync(dir)), "the private folder is gone");

    const end = await waited(world, runId);
    assert.equal(end.code, 0, `${JSON.stringify(end.reply)}\n${end.stderr}`);
    assert.equal(end.reply.result, CANARY, "the session has no line of the person's");
    const after = turns(world.log()).filter((line) => line.prompt === CONTINUE);
    assert.deepEqual(after.map((line) => line.sessionId), [held.sessionId], "the step went on in its session");
    assert.deepEqual(world.log().filter((line) => line.byHand), []);
  });

  it("sous wait offers to step in when the agent asks, and Enter steps in", async (t) => {
    const world = fakeWorld(t, { rules: ASKS });
    world.workflow("joined", script("claude/haiku"));
    const runId = await started(world, asking(world));

    const here = terminal(world, [""]);
    const end = await sous(world.paths, ["wait", runId], { machine: here.machine });

    assert.equal(end.code, 0, `${here.out.join("")}\n${here.err.join("\n")}`);
    assert.deepEqual(here.asked, [`\n"impl" needs you in its session. Step into it now? (Y/n) > `]);
    assert.equal(here.opened.length, 1);
    assert.ok(here.err.includes(`left the session of "impl" in ${runId}.`), here.err.join("\n"));
    assert.equal(readState(world.paths, runId)?.status, "completed");
    assert.ok(here.out.join("\n").includes(`${CANARY} ${PERSON_WORD}`), here.out.join(""));
  });

  it("sous wait leaves the step waiting when the person says no, and names the command", async (t) => {
    const world = fakeWorld(t, { rules: ASKS });
    world.workflow("joined", script("claude/haiku"));
    const runId = await started(world, asking(world));

    const here = terminal(world, ["n"]);
    const end = await sous(world.paths, ["wait", runId], { machine: here.machine });

    assert.equal(end.code, 4, `${here.out.join("")}\n${here.err.join("\n")}`);
    assert.equal(here.opened.length, 0);
    assert.ok(here.err.includes(`sous join ${runId} impl steps into it later. The step waits until then.`), here.err.join("\n"));
    assert.equal(readRun(world.paths, runId).status, "asks");
    assert.ok(here.out.join("").includes(`sous join ${runId} impl`), here.out.join(""));
  });

  it("sous step shows the step's session and the command that steps into it", async (t) => {
    const world = fakeWorld(t, { rules: HELD });
    world.workflow("joined", script("claude/haiku"));
    const runId = await started(world, heldTurn(world));
    const held = turns(world.log()).find((line) => line.prompt === PROMPT)!;

    const here = terminal(world);
    assert.equal((await sous(world.paths, ["step", runId, "impl", "--json"], { machine: here.machine })).code, 0);
    const shown = json<{ session?: { id: string; program: string; folder: string; join: string } }>(here.out);
    assert.deepEqual(shown.session, { id: held.sessionId, program: "Claude Code", folder: held.cwd, join: `sous join ${runId} impl` });

    const text = terminal(world);
    assert.equal((await sous(world.paths, ["step", runId, "impl"], { machine: text.machine })).code, 0);
    assert.ok(text.out.includes(`session: ${held.sessionId} (Claude Code) in ${held.cwd}`), text.out.join("\n"));
    assert.ok(text.out.includes(`step in: sous join ${runId} impl`), text.out.join("\n"));
    writeFileSync(join(world.dir, "release"), "");
  });
});

describe("sous join refuses", () => {
  it("a shell with no terminal, a step of a run, a step with no session, a missing step and a program sous can't find", async (t) => {
    const world = fakeWorld(t, { rules: HELD });
    world.workflow("joined", script("claude/haiku"));
    const runId = await started(world, heldTurn(world));
    const refused = (lines: string[]) => json<{ error: { code: string; message: string; change: string } }>(lines).error;

    // The world's sous runs with stdin ignored, as an agent's shell does.
    const shell = await world.sous("join", runId, "impl", "--json");
    assert.equal(shell.code, 66, shell.stdout);
    const noTerminal = (JSON.parse(shell.stdout) as { error: { code: string; change: string } }).error;
    assert.equal(noTerminal.code, "no_person_here");
    assert.equal(noTerminal.change, `Ask the person to run sous join ${runId} impl in a terminal of their own.`);

    const step = terminal(world);
    const fromStep = await sous(world.paths, ["join", runId, "impl", "--json"], { machine: step.machine, env: { ...process.env, SOUS_RUN_ID: "other-run" } });
    assert.equal(fromStep.code, 66);
    assert.equal(refused(step.out).code, "no_person_here");

    const code = terminal(world);
    assert.equal((await sous(world.paths, ["join", runId, "setup", "--json"], { machine: code.machine })).code, 66);
    assert.equal(refused(code.out).code, "step_has_no_session");

    const missing = terminal(world);
    assert.equal((await sous(world.paths, ["join", runId, "--json"], { machine: missing.machine })).code, 64);
    assert.equal(refused(missing.out).code, "bad_argument");

    // sous finds no claude now. The turn keeps its session, and runs to its end.
    const config = JSON.parse(readFileSync(world.paths.config, "utf8")) as Record<string, unknown>;
    writeFileSync(world.paths.config, JSON.stringify({ ...config, claudePath: join(world.dir, "no-claude") }));
    const lost = terminal(world);
    assert.equal((await sous(world.paths, ["join", runId, "impl", "--json"], { machine: lost.machine })).code, 66);
    assert.equal(refused(lost.out).code, "no_program");
    assert.equal(lost.opened.length, 0);

    writeFileSync(join(world.dir, "release"), "");
    const end = await waited(world, runId);
    assert.equal(end.code, 0, JSON.stringify(end.reply));
    assert.equal(end.reply.result, "Done.", "the held turn ran to its end");
    assert.deepEqual(turns(world.log()).map((line) => line.prompt), [PROMPT], "no turn stopped, and none went on");
    assert.deepEqual(world.log().filter((line) => line.byHand), []);
  });
});

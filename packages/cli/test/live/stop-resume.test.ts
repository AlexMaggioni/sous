// Live test of phase 4 of the workflow shape: a stop does not lose the session. On each program an
// implementer handle gets a code word, then a turn that runs a slow shell command. While the
// command runs, the run pauses, once through `sous stop <run> --step implementer` and once through
// a kill of its worker. `sous resume` then goes on in the same session with "Continue the task.",
// and the agent answers with the word, so the session kept its memory. The program's own session
// file shows that neither earlier prompt was sent again.
//
// A last test stops a /goal step on Claude Code in the middle of its loop, over the fixture of
// scenario 2. The resumed step sends its slash prompt again in the same session, the run
// completes, and the fixture's tests pass.
//
// It is off by default. It needs Claude Code and Codex and your own logins, so run it from
// packages/cli without test/with-temp-home.mjs, after pnpm build:
//
//   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID SOUS_LIVE_STOP=1 ../../node_modules/.bin/tsx --test test/live/stop-resume.test.ts
//
// Claude Code runs on haiku at low effort, and Codex on gpt-6-luna at low effort. The test prints
// each turn's status, cost, tokens and time, and each run's cost.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { liveWorld, programPrompts, turnLine, turnsOf, type LiveWorld, type RunState } from "../helpers/live-run.js";
import { TEST_COMMAND, plantStubs } from "../helpers/stub-repo.js";

const ON = process.env.SOUS_LIVE_STOP === "1";
const EFFORT = "low";
const WORD = "PELICAN-4417";
const REMEMBER = `Remember the code word ${WORD}. Reply with only OK.`;
/** The file the slow command makes first, so the test knows the command runs. */
const STARTED = "started.txt";
const SLOW = `Run this shell command and wait for it to end: \`touch ${STARTED} && sleep 20\`. Then reply with only the code word this conversation gave you.`;
const CONTINUE = "Continue the task.";
const OBJECTIVE = "every test in test/ passes";

const PROGRAMS = [
  { program: "claude", model: "claude/haiku" },
  { program: "codex", model: "codex/gpt-6-luna" },
] as const;

/** An implementer handle in the project folder: the word, then the slow turn. */
const held = (model: string) => `export const meta = { name: 'held', description: 'An implementer stopped on its slow turn', place: 'folder' }
const impl = session({ label: 'implementer', model: '${model}', effort: '${EFFORT}' })
await impl.send(${JSON.stringify(REMEMBER)})
return await impl.send(${JSON.stringify(SLOW)})`;

/** A /goal step on the fixture, then the fixture's tests. */
const GOAL_SCRIPT = `export const meta = { name: 'goal', description: 'Make the stubs pass', place: 'folder' }
const result = await agent(${JSON.stringify(`/goal ${OBJECTIVE}`)}, { label: 'impl', model: 'claude/haiku', effort: '${EFFORT}' })
const tests = await sh(${JSON.stringify(TEST_COMMAND)}, { label: 'tests', allowFail: true })
return { result, tests: tests.code }`;

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starts the workflow and gives its run id. */
async function start(world: LiveWorld, name: string): Promise<string> {
  const started = await world.sous("run", name, "--json");
  assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
  return (JSON.parse(started.stdout) as { runId: string }).runId;
}

/** Waits until the step with the label runs a turn the program has, and `ready` holds. */
async function heldTurn(world: LiveWorld, runId: string, label: string, ready: () => boolean): Promise<string> {
  for (let i = 0; i < 1200; i++) {
    const state = readState(world.paths, runId);
    const row = state?.agents.find((agent) => agent.label === label && agent.status === "running" && agent.session !== undefined);
    if (row?.session && row.session.delivered !== false && ready()) return row.session.sessionId;
    if (state && state.status !== "running") assert.fail(`the run ended before the turn was held: ${state.status}`);
    await pause(250);
  }
  assert.fail("the turn never ran");
}

/** Kills the run's worker and the programs in its process group, as a crash would, and waits
 *  until the worker has ended. */
async function killWorker(world: LiveWorld, runId: string): Promise<void> {
  const pid = listRecords(world.paths).find((record) => record.runId === runId)?.pid;
  assert.ok(pid, "the run has a worker");
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // The group or the process has ended already.
    }
  }
  for (let i = 0; i < 200 && alive(pid); i++) await pause(50);
  assert.equal(alive(pid), false, "the worker ended");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops the step and checks that the run paused for it. */
async function stopStep(world: LiveWorld, runId: string, label: string): Promise<void> {
  const stopped = await world.sous("stop", runId, "--step", label, "--json");
  assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
  const waited = await world.sous("wait", runId, "--timeout", "60", "--json");
  assert.equal(waited.code, 2, waited.stdout);
  assert.equal(readState(world.paths, runId)?.pauseReason, "step_stopped");
}

/** Resumes the run to its end, prints each turn of the label, and gives the result and the state. */
async function resume(t: TestContext, world: LiveWorld, runId: string, label: string): Promise<{ result: unknown; state: RunState }> {
  const began = Date.now();
  const resumed = await world.sous("resume", runId, "--wait", "--json");
  const state = world.state();
  for (const turn of turnsOf(state, label)) t.diagnostic(turnLine(turn));
  t.diagnostic(`run ${state.status}: $${state.tokenUsage?.cost ?? "?"}, ${state.tokenUsage?.total ?? "?"} tokens, resume ${Date.now() - began} ms`);
  assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.equal(state.status, "completed");
  return { result: (JSON.parse(resumed.stdout) as { result?: unknown }).result, state };
}

/** Checks that the resumed implementer answered with the word in the held session, and that the
 *  program got each prompt once, then the continuation. */
function wentOnInSession(t: TestContext, program: "claude" | "codex", result: unknown, state: RunState, sessionId: string): void {
  assert.equal(typeof result, "string");
  assert.ok((result as string).includes(WORD), `the implementer answered ${JSON.stringify(result)}`);
  const sessions = new Set(turnsOf(state, "implementer").map((turn) => turn.sessionId));
  assert.deepEqual([...sessions], [sessionId], "every turn ran in the held session");
  const prompts = programPrompts(program, sessionId);
  t.diagnostic(`the session's user messages: ${JSON.stringify(prompts.map((text) => text.slice(0, 120)))}`);
  assert.equal(prompts.filter((text) => text.includes(REMEMBER)).length, 1, "the first prompt was sent once");
  assert.equal(prompts.filter((text) => text.includes(SLOW)).length, 1, "the held prompt was not sent again");
  assert.ok(prompts.some((text) => text.includes(CONTINUE)), "the resume went on with the continuation");
}

describe("a stop does not lose the session", { skip: ON ? false : "set SOUS_LIVE_STOP=1 to run it, on your own logins" }, () => {
  for (const { program, model } of PROGRAMS) {
    test(`on ${program}, sous stop --step pauses the run, and sous resume goes on in the same session`, { timeout: 600_000 }, async (t) => {
      const world = liveWorld(t, `stop-${program}`);
      world.write(".sous/workflows/held.js", held(model));
      t.diagnostic(`home ${world.home}, project ${world.project}`);
      const runId = await start(world, "held");
      const sessionId = await heldTurn(world, runId, "implementer", () => existsSync(join(world.project, STARTED)));
      await stopStep(world, runId, "implementer");
      const { result, state } = await resume(t, world, runId, "implementer");
      wentOnInSession(t, program, result, state, sessionId);
    });

    test(`on ${program}, a killed worker leaves the run interrupted, and sous resume goes on in the same session`, { timeout: 600_000 }, async (t) => {
      const world = liveWorld(t, `kill-${program}`);
      world.write(".sous/workflows/held.js", held(model));
      t.diagnostic(`home ${world.home}, project ${world.project}`);
      const runId = await start(world, "held");
      const sessionId = await heldTurn(world, runId, "implementer", () => existsSync(join(world.project, STARTED)));
      await killWorker(world, runId);
      const shown = await world.sous("show", runId, "--json");
      assert.equal((JSON.parse(shown.stdout) as { status?: string }).status, "interrupted", shown.stdout);
      const { result, state } = await resume(t, world, runId, "implementer");
      wentOnInSession(t, program, result, state, sessionId);
    });
  }

  test("on claude, a /goal step stopped in the middle of its loop sends its slash prompt again and the tests pass", { timeout: 900_000 }, async (t) => {
    const world = liveWorld(t, "stop-goal");
    plantStubs(world);
    world.write(".sous/workflows/goal.js", GOAL_SCRIPT);
    t.diagnostic(`home ${world.home}, project ${world.project}`);
    const stub = readFileSync(join(world.project, "src/text.js"), "utf8");
    const runId = await start(world, "goal");
    // The middle of the loop: the goal is set and the agent has changed the source once.
    const sessionId = await heldTurn(world, runId, "impl", () => readFileSync(join(world.project, "src/text.js"), "utf8") !== stub);
    await stopStep(world, runId, "impl");
    t.diagnostic(`changed when the step stopped: ${world.git("status", "--porcelain").replaceAll("\n", ", ")}`);

    const { result, state } = await resume(t, world, runId, "impl");
    assert.equal((result as { tests: number }).tests, 0, "the fixture's tests fail after the step");
    const sessions = new Set(turnsOf(state, "impl").map((turn) => turn.sessionId));
    assert.deepEqual([...sessions], [sessionId], "every turn ran in the stopped session");
    const prompts = programPrompts("claude", sessionId);
    t.diagnostic(`the session's user messages: ${JSON.stringify(prompts.map((text) => text.slice(0, 120)))}`);
    const goals = prompts.filter((text) => /<command-name>\/goal<\/command-name>/.test(text) && text.includes(OBJECTIVE));
    assert.equal(goals.length, 2, "the resumed step sent its slash prompt again, as written");
  });
});

// Live scenarios 2 and 3 of the workflow shape, through `sous run` on Claude Code. A fixture
// repository has three stubbed functions and a test for each, which `node --test` runs with no
// install. Scenario 2 sends `/goal every test in test/ passes`: the goal's turn runs with no
// schema, then the report turn asks for the status in the same session. Scenario 3 sends a plain
// prompt that runs until the agent says done. Each workflow then runs `node --test`, and the test
// passes when it exits 0, the step's turns are those the design says, and every turn ran in one
// session. It never reads the model's words.
//
// It is off by default. It needs Claude Code and your own login, so run it from packages/cli
// without test/with-temp-home.mjs, after pnpm build:
//
//   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID SOUS_LIVE_GOAL=1 ../../node_modules/.bin/tsx --test test/live/goal.test.ts
//
// Every turn runs on haiku at low effort. The test prints each turn's status, cost, tokens and
// time, and each run's time.

import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { readStatus } from "@sous-run/engine/testing";
import { liveWorld, programPrompts, turnLine, turnsOf, type StepTurn, type LiveWorld } from "../helpers/live-run.js";
import { TEST_COMMAND, plantStubs } from "../helpers/stub-repo.js";

const ON = process.env.SOUS_LIVE_GOAL === "1";
const MODEL = "claude/haiku";
const EFFORT = "low";
const OBJECTIVE = "every test in test/ passes";
const GOAL = `/goal ${OBJECTIVE}`;
const PLAIN = "Write the functions in src/text.js so that every test in test/ passes. Run the tests with `node --test`.";
const REPORT = "Report on the task you were given.";
const CONTINUE = "Continue the task.";

/** A workflow in the project folder: the step, then the fixture's tests. */
const script = (name: string, prompt: string) => `export const meta = { name: '${name}', description: 'Make the stubs pass', place: 'folder' }
const result = await agent(${JSON.stringify(prompt)}, { label: 'impl', model: '${MODEL}', effort: '${EFFORT}' })
const tests = await sh(${JSON.stringify(TEST_COMMAND)}, { label: 'tests', allowFail: true })
return { result, tests: tests.code }`;

/** The program turns the rows took past their first: report and repair turns, which both send
 *  the report prompt. A row that took more than one turn says how many. */
const extraTurns = (turns: StepTurn[]) => turns.reduce((sum, turn) => sum + (((turn.result as { turns?: number }).turns ?? 1) - 1), 0);

/** Runs the workflow to its end, prints each turn, and gives the step's turns and the tests' exit
 *  code. It checks what both scenarios share: the run completed, the tests pass, every turn's row
 *  holds a status, the last says done, and every turn ran in one session. */
async function runStubs(t: TestContext, world: LiveWorld, name: string) {
  const start = Date.now();
  const run = await world.sous("run", name, "--wait", "--json");
  const state = world.state();
  const turns = turnsOf(state, "impl");
  for (const turn of turns) t.diagnostic(turnLine(turn));
  t.diagnostic(`run ${state.status}: $${state.tokenUsage?.cost ?? "?"}, ${state.tokenUsage?.total ?? "?"} tokens, ${Date.now() - start} ms`);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(state.status, "completed");
  assert.equal((JSON.parse(run.stdout) as { result: { tests: number } }).result.tests, 0, "the fixture's tests fail after the step");

  const statuses = turns.map((turn) => readStatus(turn.result)?.status);
  assert.ok(turns.length >= 1);
  assert.ok(
    statuses.every((status) => status === "done" || status === "working"),
    `a turn's row holds no status: ${JSON.stringify(turns.map((turn) => turn.result))}`,
  );
  assert.equal(statuses.at(-1), "done");
  const session = turns[0]!.sessionId;
  assert.ok(session, "the step recorded no session");
  assert.deepEqual(
    turns.map((turn) => turn.sessionId),
    turns.map(() => session),
  );
  const prompts = programPrompts("claude", session);
  t.diagnostic(`the session's user messages: ${JSON.stringify(prompts.map((text) => text.slice(0, 120)))}`);
  return { turns, prompts };
}

describe("scenarios 2 and 3 live on Claude Code", { skip: ON ? false : "set SOUS_LIVE_GOAL=1 to run it, on your own login" }, () => {
  test("scenario 2: /goal runs as written with no schema, the report turn follows in its session, and the tests pass", { timeout: 900_000 }, async (t) => {
    const world = liveWorld(t, "goal");
    plantStubs(world);
    world.write(".sous/workflows/goal.js", script("goal", GOAL));
    t.diagnostic(`home ${world.home}, project ${world.project}`);

    const { turns, prompts } = await runStubs(t, world, "goal");

    // Each row of a slash step is its goal's turn and the report turn after it, so it says it took
    // two program turns, or more when an answer needed a repair.
    for (const turn of turns) assert.ok(((turn.result as { turns?: number }).turns ?? 1) >= 2, `a row of the slash step took one turn: ${JSON.stringify(turn.result)}`);
    // The program got the slash command as written, with nothing in front of it, then the report
    // prompt in the same session.
    assert.match(prompts[0] ?? "", /<command-name>\/goal<\/command-name>/);
    assert.ok(prompts[0]!.includes(OBJECTIVE), prompts[0]);
    assert.ok(!prompts.some((text) => text.includes("Task label")), JSON.stringify(prompts));
    assert.equal(prompts.filter((text) => text === REPORT).length, extraTurns(turns));
    assert.equal(prompts.filter((text) => text === CONTINUE).length, turns.length - 1);
  });

  test("scenario 3: a plain prompt runs until the agent says done, in one session, and the tests pass", { timeout: 900_000 }, async (t) => {
    const world = liveWorld(t, "done");
    plantStubs(world);
    world.write(".sous/workflows/done.js", script("done", PLAIN));
    t.diagnostic(`home ${world.home}, project ${world.project}`);

    const { turns, prompts } = await runStubs(t, world, "done");

    // A plain prompt's turn carries the status itself: the program got the prompt as written,
    // then one "Continue the task." for each row that said working, and no report turn. The
    // report's words come only as a repair, which the row counts.
    assert.equal(prompts[0], PLAIN);
    assert.equal(prompts.filter((text) => text === CONTINUE).length, turns.length - 1);
    assert.equal(prompts.filter((text) => text === REPORT).length, extraTurns(turns));
  });
});

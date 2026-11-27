// Scenario 2, /goal holds a long task. A fixture repository has three stubbed functions and a test
// for each. One step sends `/goal every test in test/ passes`. The prompt reaches the program as
// written, so the program runs its goal loop: several model turns with the Stop hook's feedback
// between them, then one result. The work turn carries no schema, since a schema cuts the goal
// short. Then the report turn asks for the status in the same session, and the step returns with
// its "done". The script's test command afterward exits 0. The fakes stand in for the programs: a
// goal rule plays the model turns and writes the functions in its last one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { askedSchema, fakeWorld, promptOf, wentOn, type FakeLine, type FakeRule } from "../helpers/fake-world.js";
import { SOLVED, TEST_COMMAND, plantStubs } from "../helpers/stub-repo.js";

const OBJECTIVE = "every test in test/ passes";
const GOAL = `/goal ${OBJECTIVE}`;
const REPORT = "Report on the task you were given.";
const MET = "The goal is met: every test in test/ passes.";
const RESULT = "I wrote slug, clamp and total, and every test passes.";
/** The model turns the goal plays. */
const GOAL_TURNS = 3;
/** The fields of the status schema the report turn carries. */
const STATUS = ["status", "result", "message"];

const RULES: FakeRule[] = [
  { match: "^/goal ", slash: true, goal: GOAL_TURNS, files: SOLVED, answer: MET },
  { match: `^${REPORT}$`, answer: RESULT },
];

/** The workflow: the tests before, the goal step, and the tests after. */
const script = (model: string) => `export const meta = { name: 'goal', description: 'A goal that holds a long task' }
const before = await sh(${JSON.stringify(TEST_COMMAND)}, { label: 'tests before', allowFail: true })
const result = await agent(${JSON.stringify(GOAL)}, { label: 'goal', model: '${model}' })
const after = await sh(${JSON.stringify(TEST_COMMAND)}, { label: 'tests after', allowFail: true })
return { result, before: before.code, after: after.code }`;

/** The schema's property names a turn got, or null when it got none. */
const fields = (line: FakeLine) => {
  const schema = askedSchema(line);
  return schema === null ? null : Object.keys((schema as { properties: object }).properties);
};

interface StepJson {
  calls: number;
  activity: Array<{ kind: string; text: string }>;
}

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`a /goal step on the fake ${program}`, () => {
    it("runs the goal's model turns as written with no schema, then the report turn in the same session, and the tests pass after", async (t) => {
      const world = fakeWorld(t, { rules: RULES });
      plantStubs(world);
      world.workflow("goal", script(model));

      const run = await world.sous("run", "goal", "--wait", "--json");

      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
      const records = listRecords(world.paths);
      assert.equal(records.length, 1);
      const runId = records[0]!.runId;
      const state = readState(world.paths, runId);
      assert.equal(state?.status, "completed");
      const value = (JSON.parse(run.stdout) as { result: { result: unknown; before: number; after: number } }).result;
      assert.notEqual(value.before, 0, "the tests passed before the goal ran");
      assert.deepEqual([value.result, value.after], [RESULT, 0]);

      // The prompt reaches the program as written, with no schema, then the report turn asks for
      // the status in the same session.
      const lines = world.log();
      const turns = lines.filter((line) => line.prompt !== undefined);
      assert.deepEqual(
        turns.map((line) => [line.program, promptOf(line), line.texts ?? null, fields(line), line.rule]),
        [
          [program, GOAL, null, null, 0],
          [program, REPORT, null, STATUS, 1],
        ],
      );
      const [work, report] = turns;
      if (program === "codex") assert.equal(work!.objective, OBJECTIVE, "the goal went through thread/goal/set");
      assert.match(work!.system ?? "", /Task label: goal/);
      assert.equal(typeof work!.sessionId, "string");
      assert.equal(report!.sessionId, work!.sessionId);
      // The report turn goes on in the program the goal kept, so a process the goal started still
      // runs. Claude Code takes a schema once per program, so there it asks for JSON in its text.
      assert.equal(wentOn(work, report), "held");

      // The goal's model turns come after the prompt and before the report turn, in its session.
      const goals = lines.filter((line) => line.goal !== undefined);
      assert.deepEqual(
        goals.map((line) => [line.goal!.turn, line.sessionId]),
        Array.from({ length: GOAL_TURNS }, (_, at) => [at + 1, work!.sessionId]),
      );
      const order = [work!, ...goals, report!].map((line) => lines.indexOf(line));
      assert.deepEqual(order, [...order].sort((a, b) => a - b));

      // The step is one journal row: the goal's turn and the report turn, which said done.
      const rows = (state?.journal ?? []).filter((entry) => entry.call?.kind === "agent" && entry.call.label === "goal");
      assert.equal(rows.length, 1, JSON.stringify(state?.journal));
      assert.deepEqual(rows[0]!.result, { status: "done", result: RESULT, message: null, turns: 2 });
      assert.equal(rows[0]!.session?.sessionId, work!.sessionId);

      // The step view shows the goal's model turns inside the one step.
      const step = await world.sous("step", runId, "goal", "--json", "--full");
      assert.equal(step.code, 0, `${step.stdout}\n${step.stderr}`);
      const view = JSON.parse(step.stdout) as StepJson;
      assert.equal(view.calls, 1);
      const said = view.activity.filter((entry) => entry.kind === "text").map((entry) => entry.text);
      const modelTurns = [...Array.from({ length: GOAL_TURNS - 1 }, (_, at) => `Working on the goal, model turn ${at + 1}.`), MET];
      assert.deepEqual(
        said.filter((text) => modelTurns.includes(text)),
        modelTurns,
        JSON.stringify(view.activity),
      );
    });
  });
}

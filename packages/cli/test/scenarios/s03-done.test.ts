// Scenario 3, the agent says when it is done. A step runs until its agent answers "done". When the
// agent asks "Should I continue?", the turn's status is "working", and sous sends it back to work
// with "Continue the task." in the same session. The fakes stand in for the programs: a status
// rule answers "working" with that question, then "done" with the result. On the fixture
// repository of stubbed functions, the done turn writes them, and the script's test command
// afterward exits 0.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, wentOn, type FakeLine, type FakeRule } from "../helpers/fake-world.js";
import { SOLVED, TEST_COMMAND, plantStubs } from "../helpers/stub-repo.js";

const PROMPT = "Make every test in test/ pass.";
const CONTINUE = "Continue the task.";
const RESULT = "Every test passes.";

/** The first turn asks whether to go on. The next one says done. */
const RULES: FakeRule[] = [
  {
    status: [
      { status: "working", message: "Should I continue?" },
      { status: "done", result: RESULT },
    ],
  },
];

/** On the fixture: the first turn stops early and asks whether to go on, with the tests still
 *  failing. The next one writes the functions and says done. */
const FIXING: FakeRule[] = [
  { times: 1, status: [{ status: "working", message: "I looked at the stubs. Should I continue?" }] },
  { status: [{ status: "done", result: RESULT }], files: SOLVED },
];

/** The workflow on the fixture: the tests before, the step, and the tests after. */
const fixScript = (model: string) => `export const meta = { name: 'done', description: 'A step that runs until its agent says done' }
const before = await sh(${JSON.stringify(TEST_COMMAND)}, { label: 'tests before', allowFail: true })
const result = await agent(${JSON.stringify(PROMPT)}, { label: 'impl', model: '${model}' })
const after = await sh(${JSON.stringify(TEST_COMMAND)}, { label: 'tests after', allowFail: true })
return { result, before: before.code, after: after.code }`;

const script = (model: string) => `export const meta = { name: 'done', description: 'A step that runs until its agent says done' }
const result = await agent(${JSON.stringify(PROMPT)}, { label: 'impl', model: '${model}' })
return { result }`;

/** The fakes' turns: the log lines that carry a prompt. */
const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

/** The fields of the schema a turn got, or null when it got none. */
const fields = (line: FakeLine) => (line.schema ? Object.keys((line.schema as { properties: object }).properties).sort() : null);

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`a step that runs until done on the fake ${program}`, () => {
    it("sends Continue the task. in the same session when the agent asks whether to go on, and returns the done result", async (t) => {
      const world = fakeWorld(t, { rules: RULES });
      world.workflow("done", script(model));

      const run = await world.sous("run", "done", "--wait", "--json");

      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
      const records = listRecords(world.paths);
      assert.equal(records.length, 1);
      assert.equal(readState(world.paths, records[0]!.runId)?.status, "completed");
      assert.deepEqual((JSON.parse(run.stdout) as { result?: unknown }).result, { result: RESULT });

      const lines = turns(world.log());
      assert.deepEqual(
        lines.map((line, i) => [line.program, line.prompt, i === 0 ? line.resume === true : wentOn(lines[0], line), fields(line)]),
        [
          [program, PROMPT, false, ["message", "result", "status"]],
          // The step's next turn goes on in the first turn's open program.
          [program, CONTINUE, "held", ["message", "result", "status"]],
        ],
      );
      assert.equal(typeof lines[0]!.sessionId, "string");
      assert.equal(lines[1]!.sessionId, lines[0]!.sessionId);
    });

    it("on the fixture, returns only with done after the early stop, and the tests the step fixed pass after it", async (t) => {
      const world = fakeWorld(t, { rules: FIXING });
      plantStubs(world);
      world.workflow("done", fixScript(model));

      const run = await world.sous("run", "done", "--wait", "--json");

      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
      const records = listRecords(world.paths);
      assert.equal(records.length, 1);
      const state = readState(world.paths, records[0]!.runId);
      assert.equal(state?.status, "completed");
      const value = (JSON.parse(run.stdout) as { result: { result: unknown; before: number; after: number } }).result;
      assert.notEqual(value.before, 0, "the tests passed before the step ran");
      assert.deepEqual([value.result, value.after], [RESULT, 0]);

      const lines = turns(world.log());
      assert.deepEqual(
        lines.map((line, i) => [line.program, line.prompt, i === 0 ? line.resume === true : wentOn(lines[0], line), line.rule]),
        [
          [program, PROMPT, false, 0],
          // The step's next turn goes on in the first turn's open program.
          [program, CONTINUE, "held", 1],
        ],
      );
      assert.equal(lines[1]!.sessionId, lines[0]!.sessionId);

      // Each turn is a journal row of the step: "working", then "done".
      const rows = (state?.journal ?? []).filter((entry) => entry.call?.kind === "agent" && entry.call.label === "impl");
      assert.deepEqual(
        rows.map((row) => [(row.result as { status?: unknown }).status, row.session?.sessionId]),
        [
          ["working", lines[0]!.sessionId],
          ["done", lines[0]!.sessionId],
        ],
      );
    });
  });
}

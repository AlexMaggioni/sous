// Scenario 3, the agent says when it is done. A step runs until its agent answers "done". When the
// agent asks "Should I continue?", the turn's status is "working", and sous sends it back to work
// with "Continue the task." in the same session. The fakes stand in for the programs: a status
// rule answers "working" with that question, then "done" with the result.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, type FakeLine, type FakeRule } from "../helpers/fake-world.js";

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
        lines.map((line) => [line.program, line.prompt, line.resume === true, fields(line)]),
        [
          [program, PROMPT, false, ["message", "result", "status"]],
          [program, CONTINUE, true, ["message", "result", "status"]],
        ],
      );
      assert.equal(typeof lines[0]!.sessionId, "string");
      assert.equal(lines[1]!.sessionId, lines[0]!.sessionId);
    });
  });
}

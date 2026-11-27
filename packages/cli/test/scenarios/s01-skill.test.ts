// Scenario 1, a skill runs from the prompt. A step's prompt reaches the program as written, so a
// leading slash command runs as it does in a session opened by hand. The step's label goes in the
// session's system text. A slash step runs its command with no schema. A step that runs until done,
// the default, then asks for the status in a report turn of the same session, and a step with
// until "turn" and a schema asks for the value there. The fakes stand in for the programs: a rule
// answers the canary word only to a prompt that starts with "/canary".

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, wentOn, type FakeLine, type FakeRule, type FakeWorld } from "../helpers/fake-world.js";

const CANARY = "PELICAN-4417";
const REPORT = "Report on the task you were given.";
/** The setting sources that load user, project and plugin skills, as the Claude Agent SDK writes
 *  them on the program's command line. */
const SETTING_SOURCES = "--setting-sources=user,project,local";

/** The canary rule matches only a slash prompt. Any other prompt gets another word. */
const RULES: FakeRule[] = [
  { match: "^/canary", slash: true, answer: CANARY },
  { match: "", answer: "OTHER-WORD" },
];
/** The fields of the status schema a report turn of a step that runs until done carries. */
const STATUS = ["status", "result", "message"];
/** The schema's property names a turn got, or null when it got none. */
const fields = (line: FakeLine) => (line.schema === null || line.schema === undefined ? null : Object.keys((line.schema as { properties: object }).properties));

/** A workflow whose one step sends `/canary` on `model`, with `options` added to the call. */
const slashStep = (model: string, options = "") => `export const meta = { name: 'skill', description: 'A skill from the prompt' }
return await agent('/canary', { label: 'canary step', model: '${model}'${options} })`;

/** The fakes' turns: the log lines that carry a prompt. */
const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

/** Run the workflow "skill" to its end, and give the step's value that `sous run --wait --json`
 *  prints. The home holds the one run, completed. */
async function runSkill(world: FakeWorld): Promise<unknown> {
  const run = await world.sous("run", "skill", "--wait", "--json");
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const records = listRecords(world.paths);
  assert.equal(records.length, 1);
  assert.equal(readState(world.paths, records[0]!.runId)?.status, "completed");
  return (JSON.parse(run.stdout) as { result?: unknown }).result;
}

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`a slash prompt on the fake ${program}`, () => {
    it("reaches the program as written, with the label in the system text, and the step returns the canary", async (t) => {
      const world = fakeWorld(t, { rules: [RULES[0]!, { match: `^${REPORT}$`, answer: CANARY }, RULES[1]!] });
      world.workflow("skill", slashStep(model));

      const value = await runSkill(world);

      const [turn, report, ...more] = turns(world.log());
      assert.equal(more.length, 0, JSON.stringify(world.log()));
      assert.equal(turn!.program, program);
      assert.equal(turn!.prompt, "/canary");
      assert.equal(turn!.rule, 0);
      assert.equal(fields(turn!), null);
      assert.match(turn!.system ?? "", /Task label: canary step/);
      // The step runs until done, so the report turn asks for the status in the same session. Claude
      // Code takes a schema once per program, so there the report turn resumes the session in a new one.
      assert.deepEqual([report!.prompt, fields(report!), report!.rule, wentOn(turn, report)], [REPORT, STATUS, 1, program === "claude" ? "resumed" : "held"]);
      assert.equal(report!.sessionId, turn!.sessionId);
      assert.equal(value, CANARY);
    });

    it("with until turn runs the one turn as written and returns the canary", async (t) => {
      const world = fakeWorld(t, { rules: RULES });
      world.workflow("skill", slashStep(model, ", until: 'turn'"));

      const value = await runSkill(world);

      const [turn, ...more] = turns(world.log());
      assert.equal(more.length, 0, JSON.stringify(world.log()));
      assert.equal(turn!.program, program);
      assert.equal(turn!.prompt, "/canary");
      assert.equal(turn!.rule, 0);
      assert.match(turn!.system ?? "", /Task label: canary step/);
      assert.equal(value, CANARY);
    });

    for (const [until, reportFields] of [
      ["done", STATUS],
      ["turn", ["word"]],
    ] as const) {
      it(`with a schema and until ${until} runs /canary with no schema, then a report turn in the same session, and returns the schema's value`, async (t) => {
        const world = fakeWorld(t, { rules: [{ match: "^/canary", slash: true, answer: CANARY }, { match: `^${REPORT}$`, answer: { word: CANARY } }] });
        world.workflow("skill", slashStep(model, `, until: '${until}', schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false }`));

        const value = await runSkill(world);

        const lines = turns(world.log());
        assert.deepEqual(
          lines.map((line) => [line.prompt, fields(line)]),
          [
            ["/canary", null],
            [REPORT, [...reportFields]],
          ],
        );
        const [work, report] = lines;
        assert.deepEqual([work!.rule, report!.rule], [0, 1]);
        assert.equal(report!.sessionId, work!.sessionId);
        assert.equal(wentOn(work, report), program === "claude" ? "resumed" : "held");
        assert.deepEqual(value, { word: CANARY });
      });
    }
  });
}

describe("the skills of a step on the fake claude", () => {
  it("load as in a session opened by hand, from the setting sources for user and plugin skills", async (t) => {
    const world = fakeWorld(t, { rules: RULES });
    world.workflow("skill", slashStep("claude/haiku"));

    await runSkill(world);

    const [turn] = turns(world.log());
    assert.ok(turn!.argv?.includes(SETTING_SOURCES), JSON.stringify(turn!.argv));
  });
});

// Scenario 11, an agent kept alone hears nothing. In the run of scenario 10, a third agent works
// outside the room, before and after it, on each program. It cannot name either canary, though
// the room passed both between its members. The fakes stand in for the programs: a recall rule
// answers with the canary words of the session's own earlier messages.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, type FakeLine, type FakeRule } from "../helpers/fake-world.js";

const CLAUDE_WORD = "PELICAN-4417";
const GPT_WORD = "HERON-2210";
const NOTHING = "Nothing to recall.";
const RECALL = "Say the words you were given.";

const RULES: FakeRule[] = [
  { match: "words you were given", recall: true },
  { match: "^Round ", recall: true },
];

/** The workflow: two members with a word each, a mediator, and an outsider on `model`. */
const script = (model: string) => `export const meta = { name: 'apart', description: 'A room, and an agent outside it' }
const claude = session({ label: 'claude', model: 'claude/haiku' })
const gpt = session({ label: 'gpt', model: 'codex/gpt-fake' })
const mediator = session({ label: 'mediator', model: 'claude/haiku' })
const outsider = session({ label: 'outsider', model: '${model}' })
await parallel([
  () => claude.send(${JSON.stringify(`Keep this word in mind: ${CLAUDE_WORD}.`)}),
  () => gpt.send(${JSON.stringify(`Keep this word in mind: ${GPT_WORD}.`)}),
  () => outsider.send('Read the parser.'),
])
const talk = await room({ name: 'plan', goal: 'Share the words you were given. The mediator writes them all down.', members: [mediator, claude, gpt], decider: mediator })
const heard = await outsider.send(${JSON.stringify(RECALL)}, { label: 'outsider recall' })
return { decision: talk.decision, heard }`;

const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`an outsider on the fake ${program}, in a run with a room`, () => {
    it("names neither word, while the room's mediator names both", async (t) => {
      const world = fakeWorld(t, { rules: RULES });
      world.workflow("apart", script(model));

      const run = await world.sous("run", "apart", "--wait", "--json");

      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
      const { result } = JSON.parse(run.stdout) as { result: { decision: unknown; heard: string } };
      assert.equal(result.decision, `${CLAUDE_WORD} ${GPT_WORD}`, "the room carried both words");
      assert.equal(result.heard, NOTHING);
      const records = listRecords(world.paths);
      assert.equal(records.length, 1);
      assert.deepEqual(
        readState(world.paths, records[0]!.runId)?.rooms?.map((room) => [room.name, room.ended]),
        [["plan", "decided"]],
        "the run saved one room, which decided",
      );

      const lines = turns(world.log());
      const outsider = lines.filter((line) => line.prompt === "Read the parser." || line.prompt === RECALL);
      assert.equal(outsider.length, 2);
      assert.equal(outsider[0]!.sessionId, outsider[1]!.sessionId, "the outsider goes on in its own session");
      assert.ok(outsider.every((line) => line.program === program));
      const room = lines.filter((line) => line.prompt!.startsWith("Round "));
      assert.ok(room.length > 0);
      assert.ok(!room.some((line) => line.sessionId === outsider[0]!.sessionId), "no turn of the room ran in the outsider's session");
    });
  });
}

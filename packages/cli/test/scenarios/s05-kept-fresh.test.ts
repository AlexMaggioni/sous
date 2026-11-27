// Scenario 5, the implementer remembers and the reviewer starts fresh. A session handle keeps one
// session across its sends, with a reviewer's steps between them. Each agent() step starts a
// session of its own. The fakes stand in for the programs: a recall rule answers with the canary
// words of the session's earlier messages, so the answer shows which conversation a session
// remembers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, type FakeLine, type FakeRule } from "../helpers/fake-world.js";

const CANARY = "PELICAN-4417";
const NOTHING = "Nothing to recall.";
const FIRST = `Implement the parser. Keep this word in mind: ${CANARY}.`;
const REVIEW = "Review the parser and ask for one change.";
const FIX = "Make the change the reviewer asked for.";
const IMPL_RECALL = "Put the word you were given in a comment, and say the word you were given.";
const REVIEW_RECALL = "Say the word you were given.";

/** The recall rule answers both recall prompts. The other prompts get the fakes' made-up answer. */
const RULES: FakeRule[] = [{ match: "word you were given", recall: true }];

/** The workflow: an implementer handle with three sends, and a reviewer step after its first and
 *  after its last. */
const script = (model: string) => `export const meta = { name: 'kept', description: 'An implementer kept, a reviewer fresh' }
const impl = session({ label: 'implementer', model: '${model}' })
await impl.send(${JSON.stringify(FIRST)})
await agent(${JSON.stringify(REVIEW)}, { label: 'review', model: '${model}' })
await impl.send(${JSON.stringify(FIX)}, { label: 'fix' })
const implementer = await impl.send(${JSON.stringify(IMPL_RECALL)})
const reviewer = await agent(${JSON.stringify(REVIEW_RECALL)}, { label: 'recall', model: '${model}' })
return { implementer, reviewer }`;

/** The fakes' turns: the log lines that carry a prompt. */
const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`a kept implementer and a fresh reviewer on the fake ${program}`, () => {
    it("the implementer recalls the canary in one session, and each reviewer step starts its own and recalls nothing", async (t) => {
      const world = fakeWorld(t, { rules: RULES });
      world.workflow("kept", script(model));

      const run = await world.sous("run", "kept", "--wait", "--json");

      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
      const records = listRecords(world.paths);
      assert.equal(records.length, 1);
      assert.equal(readState(world.paths, records[0]!.runId)?.status, "completed");
      assert.deepEqual((JSON.parse(run.stdout) as { result?: unknown }).result, { implementer: CANARY, reviewer: NOTHING });

      const lines = turns(world.log());
      assert.deepEqual(
        lines.map((line) => [line.program, line.prompt]),
        [FIRST, REVIEW, FIX, IMPL_RECALL, REVIEW_RECALL].map((prompt) => [program, prompt]),
      );
      const [first, review, fix, implRecall, reviewRecall] = lines;
      const implementer = [first!, fix!, implRecall!];
      const reviewers = [review!, reviewRecall!];

      assert.equal(typeof first!.sessionId, "string");
      assert.deepEqual(
        implementer.map((line) => line.sessionId),
        implementer.map(() => first!.sessionId),
      );
      assert.deepEqual(
        implementer.map((line) => line.resume === true),
        [false, true, true],
      );

      for (const line of reviewers) assert.equal(typeof line.sessionId, "string");
      assert.equal(new Set([first!.sessionId, review!.sessionId, reviewRecall!.sessionId]).size, 3);
      assert.deepEqual(
        reviewers.map((line) => line.resume === true),
        [false, false],
      );
    });
  });
}

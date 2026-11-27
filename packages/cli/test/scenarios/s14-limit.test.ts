// Scenario 14, an overnight run survives limits. A nested workflow keeps an implementer handle,
// and the account's usage limit hits its second turn once. The run pauses with usage_limit and
// the time the sous service resumes it. The test resumes it by hand. The first turn is not asked
// again, and the second goes on in its session and folder with "Continue the task.". The recall
// rule answers with the word the first turn gave, so the session kept its memory.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, type FakeLine, type FakeRule } from "../helpers/fake-world.js";

const CANARY = "PELICAN-4417";
const FIRST = `Implement the parser. Keep this word in mind: ${CANARY}.`;
const SECOND = "Make the change the reviewer asked for, then say the word you were given.";
const CONTINUE = "Continue the task.";
// 2100-01-01T12:00:00Z, so the limit is always in the future.
const RESETS_AT = 4102488000;

const RULES: FakeRule[] = [
  { match: "Make the change", limit: { resetsAt: RESETS_AT }, times: 1 },
  { match: CONTINUE, recall: true },
];

const ticket = (model: string) => `export const meta = { name: 'ticket', description: 'An implementer kept for two turns' }
const impl = session({ label: 'implementer', model: '${model}' })
await impl.send(${JSON.stringify(FIRST)})
return await impl.send(${JSON.stringify(SECOND)})`;

const OVERNIGHT = `export const meta = { name: 'overnight', description: 'A ticket in a nested run' }
return await workflow('ticket', {})`;

/** The fakes' turns: the log lines that carry a prompt. */
const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`a usage limit in a nested run on the fake ${program}`, () => {
    it("pauses the run with the time it resumes, and a resume goes on in the same session and folder", async (t) => {
      const world = fakeWorld(t, { rules: RULES });
      world.workflow("ticket", ticket(model));
      world.workflow("overnight", OVERNIGHT);

      const started = await world.sous("run", "overnight", "--json");
      assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
      const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
      const waited = await world.sous("wait", runId, "--timeout", "20", "--json");
      assert.equal(waited.code, 2, waited.stdout);
      const paused = JSON.parse(waited.stdout) as { pauseReason?: string; resumesAt?: string };
      assert.equal(paused.pauseReason, "usage_limit");
      assert.equal(typeof paused.resumesAt, "string", "the run says when the service resumes it");
      assert.equal(readState(world.paths, runId)?.pauseReason, "usage_limit");

      const before = turns(world.log());
      assert.deepEqual(
        before.map((line) => [line.program, line.prompt]),
        [FIRST, SECOND].map((prompt) => [program, prompt]),
      );
      const limited = before[1]!;
      assert.equal(limited.outcome, "limit");

      const resumed = await world.sous("resume", runId, "--wait", "--json");
      assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
      assert.equal(readState(world.paths, runId)?.status, "completed");
      assert.equal((JSON.parse(resumed.stdout) as { result?: unknown }).result, CANARY, "recall gives the word the first turn got");

      const after = turns(world.log()).slice(before.length);
      assert.deepEqual(
        after.map((line) => line.prompt),
        [CONTINUE],
        "the finished turn is not asked again, and the limited turn goes on with the continuation",
      );
      const [next] = after;
      assert.equal(typeof limited.sessionId, "string");
      assert.equal(next!.sessionId, limited.sessionId, "the same session");
      assert.equal(next!.resume, true, "a new program resumed the session");
      assert.equal(next!.cwd, limited.cwd, "in the same folder");
      assert.notEqual(next!.cwd, world.projectDir, "the nested run's own folder, not the project");
    });
  });
}

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld } from "./helpers/fake-world.js";

// The world the scenario tests share: a git project, a sous home on the fake programs, and the
// real sous command. One agent step runs to its end on each fake program.

/** A workflow with one agent step on `model`, in the default place. */
const oneStep = (model: string) => `export const meta = { name: 'demo', description: 'One agent step' }
return await agent('Say PLUM', { label: 'say', model: '${model}' })`;

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`a fake world on the fake ${program}`, () => {
    it("runs a one-step workflow to its end, and the fake logs the step's turn in the run's worktree", async (t) => {
      const world = fakeWorld(t, { rules: [{ match: "Say PLUM", answer: "PLUM" }] });
      world.workflow("demo", oneStep(model));

      const run = await world.sous("run", "demo", "--wait", "--json");
      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);

      const turns = world.log().filter((line) => line.prompt !== undefined);
      assert.equal(turns.length, 1, JSON.stringify(turns));
      const [turn] = turns;
      assert.equal(turn!.program, program);
      assert.match(turn!.prompt!, /Say PLUM/);
      assert.equal(turn!.rule, 0);
      assert.equal(turn!.outcome, "answer");
      assert.equal(typeof turn!.sessionId, "string");
      // sous's default place is a worktree of its own, in the home, named by the run.
      const [record, ...more] = listRecords(world.paths);
      assert.ok(record, "the home has the run's record");
      assert.equal(more.length, 0);
      assert.equal(readState(world.paths, record.runId)?.status, "completed");
      assert.equal(turn!.cwd, join(world.paths.worktrees, record.runId));
    });
  });
}

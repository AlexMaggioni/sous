// Scenario 6, fresh and fork behave as by hand. An implementer handle gets a canary. A fresh
// agent() step does not know it. A fork of the implementer does, and a second canary given to the
// fork never reaches the implementer. Two forks with place "worktree" each work on a branch of
// their own, made from the planner's folder. The fakes stand in for the programs: a recall rule
// answers with the canary words of the session's earlier messages, and a fork's messages start
// with its parent's.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, type FakeLine, type FakeRule } from "../helpers/fake-world.js";

const CANARY = "PELICAN-4417";
const SECOND = "HERON-2210";
const NOTHING = "Nothing to recall.";
const FIRST = `Implement the parser. Keep this word in mind: ${CANARY}.`;
const OTHER = `Try another way. Keep this second word in mind: ${SECOND}.`;
const RECALL = "Say the words you were given.";

const RULES: FakeRule[] = [{ match: "words you were given", recall: true }];

/** The workflow: an implementer, a fresh step, a fork of the implementer with a second word, then
 *  a recall in each. */
const script = (model: string) => `export const meta = { name: 'fork', description: 'A fresh session and a fork' }
const impl = session({ label: 'implementer', model: '${model}' })
await impl.send(${JSON.stringify(FIRST)})
const fresh = await agent(${JSON.stringify(RECALL)}, { label: 'fresh', model: '${model}' })
const fork = impl.fork({ label: 'fork' })
await fork.send(${JSON.stringify(OTHER)})
const forked = await fork.send(${JSON.stringify(RECALL)}, { label: 'fork recall' })
const original = await impl.send(${JSON.stringify(RECALL)}, { label: 'recall' })
return { fresh, forked, original }`;

/** The fakes' turns: the log lines that carry a prompt. */
const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`a fresh session and a fork on the fake ${program}`, () => {
    it("the fresh step recalls nothing, the fork recalls both words, and the implementer only its own", async (t) => {
      const world = fakeWorld(t, { rules: RULES });
      world.workflow("fork", script(model));

      const run = await world.sous("run", "fork", "--wait", "--json");

      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
      const records = listRecords(world.paths);
      assert.equal(records.length, 1);
      assert.equal(readState(world.paths, records[0]!.runId)?.status, "completed");
      assert.deepEqual((JSON.parse(run.stdout) as { result?: unknown }).result, {
        fresh: NOTHING,
        forked: `${CANARY} ${SECOND}`,
        original: CANARY,
      });

      const lines = turns(world.log());
      assert.deepEqual(
        lines.map((line) => [line.program, line.prompt]),
        [FIRST, RECALL, OTHER, RECALL, RECALL].map((prompt) => [program, prompt]),
      );
      const [first, fresh, other, forkRecall, recall] = lines;
      assert.equal(typeof first!.sessionId, "string");
      assert.equal(new Set([first!.sessionId, fresh!.sessionId, other!.sessionId]).size, 3, "the fresh step and the fork each have a session of their own");
      assert.equal(other!.fork, true, "the fork's first turn forks the implementer's session");
      assert.equal(forkRecall!.sessionId, other!.sessionId, "the fork's turns share its session");
      assert.equal(recall!.sessionId, first!.sessionId, "the implementer goes on in its own session");
      assert.notEqual(recall!.fork, true);
      assert.equal(new Set([first!.cwd, other!.cwd, recall!.cwd]).size, 1, "a fork without place works in its parent's folder");

      const dry = await world.sous("check", "fork", "--dry-run", "--json");
      assert.equal(dry.code, 0, `${dry.stdout}\n${dry.stderr}`);
      const dryRun = (JSON.parse(dry.stdout) as { dryRun: { status: string; agents: string[] } }).dryRun;
      assert.equal(dryRun.status, "completed");
      assert.deepEqual(dryRun.agents, ["implementer", "fresh", "fork", "fork recall", "recall"]);
    });
  });
}

describe("two forks in worktrees of their own", () => {
  it("each fork works at once on its own branch from the planner's folder, and the person's checkout does not change", async (t) => {
    const world = fakeWorld(t, {
      rules: [
        // The table fork waits until the column fork has answered, so the two run at once.
        { match: "new table", hold: "column-done", files: { "store.txt": "a new table\n" }, recall: true },
        { match: "new column", mark: "column-done", files: { "store.txt": "a new column\n" }, recall: true },
      ],
    });
    world.workflow(
      "plans",
      `export const meta = { name: 'plans', description: 'Two forks of one planner, each in a worktree' }
const plan = session({ label: 'planner', model: 'claude/haiku' })
await plan.send(${JSON.stringify(`Read the code and plan the change. Keep this word in mind: ${CANARY}.`)})
const a = plan.fork({ label: 'plan a', place: 'worktree' })
const b = plan.fork({ label: 'plan b', place: 'worktree' })
const [table, column] = await parallel([() => a.send('Build it with a new table. Say the words you were given.'), () => b.send('Build it with a new column. Say the words you were given.')])
return { table, column, branches: [a.branch, b.branch] }`,
    );

    const run = await world.sous("run", "plans", "--wait", "--json");

    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const { result } = JSON.parse(run.stdout) as { result: { table: string; column: string; branches: string[] } };
    assert.deepEqual([result.table, result.column], [CANARY, CANARY], "each fork recalls the planner's word");
    const [aBranch, bBranch] = result.branches;
    assert.match(aBranch!, /^sous\/.+-plan-a-[0-9a-f]{6}$/);
    assert.match(bBranch!, /^sous\/.+-plan-b-[0-9a-f]{6}$/);

    const [planner, a, b] = turns(world.log());
    assert.ok(planner && a && b);
    const [table, column] = a.prompt!.includes("table") ? [a, b] : [b, a];
    assert.equal(new Set([planner.cwd, table.cwd, column.cwd]).size, 3, "each fork works in a folder of its own");
    assert.equal(table.fork, true);
    assert.equal(column.fork, true);

    for (const [branch, text] of [
      [aBranch!, "a new table\n"],
      [bBranch!, "a new column\n"],
    ] as const) {
      assert.equal(world.git("show", `${branch}:store.txt`), text.trim());
      assert.equal(world.git("diff", "--name-only", `main...${branch}`), "store.txt", `${branch} holds only its fork's change`);
      assert.equal(world.git("log", "-1", "--format=%s", branch), `sous: uncommitted work of ${branch === aBranch ? "plan a" : "plan b"}`);
    }
    assert.equal(world.git("status", "--porcelain"), "", "the person's checkout did not change");
    assert.equal(world.git("rev-parse", "HEAD"), world.git("rev-parse", "main"));
  });
});

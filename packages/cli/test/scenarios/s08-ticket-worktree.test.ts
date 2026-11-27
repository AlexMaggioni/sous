// Scenario 8, the ticket loop works in one worktree. An implementer handle and a reviewer step run
// in the run's worktree, the default place. The implementer commits the parser, the reviewer reads
// it there and asks for a change, and the implementer commits the fix. The fakes' run rules stand
// in for the agents' edits: each runs a shell command in the program's folder. The reviewer's copies
// the file it read next to the fakes' log, so the test sees what the reviewer saw.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, type FakeLine, type FakeRule } from "../helpers/fake-world.js";

const IMPLEMENT = "Implement the parser in src/parser.js, and commit it.";
const REVIEW = "Review src/parser.js and ask for one change.";
const ASKED = "Trim the input.";

const RULES: FakeRule[] = [
  { match: "Implement the parser", run: "mkdir -p src && printf 'parse v1\\n' > src/parser.js && git add -A && git commit -qm 'Add the parser'" },
  { match: "Review src/parser.js", run: 'cp src/parser.js "$FAKE_LOG.reviewed"', answer: ASKED },
  { match: "Address this review", run: "printf 'parse v2\\n' > src/parser.js && git add -A && git commit -qm 'Trim the input'" },
];

const script = (model: string) => `export const meta = { name: 'ticket', description: 'An implementer and a reviewer on one ticket' }
const impl = session({ label: 'implementer', model: '${model}' })
await impl.send(${JSON.stringify(IMPLEMENT)})
const review = await agent(${JSON.stringify(REVIEW)}, { label: 'reviewer', model: '${model}' })
await impl.send(\`Address this review, and commit it:\\n\${review}\`, { label: 'fix' })
return { review }`;

/** The fakes' turns: the log lines that carry a prompt. */
const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`a ticket loop in the run's worktree on the fake ${program}`, () => {
    it("the implementer and the reviewer work in one folder apart from the person's checkout, and the branch keeps the ticket's commits", async (t) => {
      const world = fakeWorld(t, { rules: RULES });
      world.workflow("ticket", script(model));

      const run = await world.sous("run", "ticket", "--wait", "--json");

      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
      const records = listRecords(world.paths);
      assert.equal(records.length, 1);
      const { runId } = records[0]!;
      assert.equal(readState(world.paths, runId)?.status, "completed");
      assert.deepEqual((JSON.parse(run.stdout) as { result?: unknown }).result, { review: ASKED });

      const [implement, review, fix] = turns(world.log());
      assert.deepEqual(
        [implement?.prompt, review?.prompt, fix?.prompt],
        [IMPLEMENT, REVIEW, `Address this review, and commit it:\n${ASKED}`],
      );
      assert.equal(new Set([implement!.cwd, review!.cwd, fix!.cwd]).size, 1, "the three steps work in one folder");
      assert.ok(implement!.cwd!.startsWith(world.paths.worktrees), `${implement!.cwd} is a worktree of the run`);
      assert.equal(readFileSync(`${world.logFile}.reviewed`, "utf8"), "parse v1\n", "the reviewer read the implementer's file");
      assert.equal(existsSync(implement!.cwd!), false, "the run's worktree is gone once the run completes");

      const branches = world.git("branch", "--list", "sous/*", "--format=%(refname:short)").split("\n").filter(Boolean);
      const branch = `sous/${runId}`;
      assert.deepEqual(branches, [branch], "the run's branch keeps the ticket's commits");
      assert.deepEqual(world.git("log", "--format=%s", `main..${branch}`).split("\n"), ["Trim the input", "Add the parser"]);
      assert.equal(world.git("show", `${branch}:src/parser.js`), "parse v2");

      assert.equal(world.git("status", "--porcelain"), "", "the person's checkout did not change");
      assert.equal(world.git("rev-parse", "HEAD"), world.git("rev-parse", "main"));
      assert.equal(existsSync(join(world.projectDir, "src")), false);
    });
  });
}

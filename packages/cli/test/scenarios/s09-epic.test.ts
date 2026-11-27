// Scenario 9, an epic runs its tickets apart. The epic runs three ticket workflows at once, each
// with place "worktree". Every ticket's implementer changes the same line of store.txt and commits
// it, so each branch holds only its own ticket's change. The implementer then writes the tests in
// the same session. The fakes hold ticket 2's second turn open after a tool call, and the test
// kills the run's worker there. `sous resume` replays tickets 1 and 3 and ticket 2's first turn
// from the journal without a prompt, and ticket 2 goes on in its own session and worktree with
// "Continue the task.".

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, type FakeLine, type FakeRule, type FakeWorld } from "../helpers/fake-world.js";

const CONTINUE = "Continue the task.";
const implement = (n: number) => `Implement ticket ${n}: set the value in store.txt to ${n}, and commit it.`;
const tests = (n: number) => `Write the tests for ticket ${n}.`;

/** Each implementer sets the one line of store.txt and commits it. Ticket 2's tests turn runs a
 *  tool call, then holds until the file "release" exists or its program ends. The tool call's
 *  message tells the engine the program has the prompt. */
const RULES: FakeRule[] = [
  ...[1, 2, 3].map((n) => ({ match: `^Implement ticket ${n}:`, run: `printf 'value = ${n}\\n' > store.txt && git commit -qam 'Ticket ${n}'`, answer: "Implemented." })),
  { match: "^Write the tests for ticket 2", tool: "echo working", hold: "release", answer: "Held." },
  { match: "^Write the tests", answer: "Tested." },
  { match: CONTINUE, answer: "Tested." },
];

const ticket = (model: string) => `export const meta = { name: 'ticket', description: 'One ticket', inputs: { n: 'The ticket number' } }
const impl = session({ label: 'implementer', model: '${model}' })
await impl.send(\`Implement ticket \${args.n}: set the value in store.txt to \${args.n}, and commit it.\`)
return { n: args.n, said: await impl.send(\`Write the tests for ticket \${args.n}.\`, { label: 'tests' }) }`;

const EPIC = `export const meta = { name: 'epic', description: 'Three tickets at once, each in a worktree' }
return await parallel([1, 2, 3].map((n) => () => workflow('ticket', { n: String(n) }, { place: 'worktree', label: 'ticket ' + n })))`;

/** The fakes' turns: the log lines that carry a prompt. */
const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

const turnOf = (lines: FakeLine[], prompt: string) => turns(lines).find((line) => line.prompt === prompt);

/** Start the epic and wait until tickets 1 and 3 have returned, their worktrees gone, and the
 *  program of ticket 2's tests turn has its prompt. */
async function heldEpic(world: FakeWorld): Promise<string> {
  const started = await world.sous("run", "epic", "--json");
  assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
  const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
  for (let i = 0; i < 400; i++) {
    const lines = world.log();
    const [one, three] = [1, 3].map((n) => turnOf(lines, tests(n)));
    const held = readState(world.paths, runId)?.agents?.find((row) => row.status === "running" && row.session !== undefined);
    const closed = [one, three].every((line) => line?.cwd !== undefined && !existsSync(line.cwd));
    if (turnOf(lines, tests(2)) && closed && held?.session && held.session.delivered !== false) return runId;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`ticket 2's tests turn never ran with its prompt delivered while 1 and 3 returned:\n${JSON.stringify(readState(world.paths, runId), null, 2)}`);
}

/** Kill the run's worker and the fake programs in its process group, as a crash would, and wait
 *  until the worker has ended. */
async function killWorker(world: FakeWorld, runId: string): Promise<void> {
  const pid = listRecords(world.paths).find((record) => record.runId === runId)?.pid;
  assert.ok(pid, "the run has a worker");
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // The group or the process has ended already.
    }
  }
  for (let i = 0; i < 200 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false, "the worker ended");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`an epic of three tickets on the fake ${program}`, () => {
    it("each ticket keeps a branch with only its change, and a resume after a kill goes on in ticket 2's session alone", async (t) => {
      const world = fakeWorld(t, { rules: RULES });
      world.write("store.txt", "value = 0\n");
      world.git("add", "store.txt");
      world.git("commit", "-qm", "Add the store");
      world.workflow("ticket", ticket(model));
      world.workflow("epic", EPIC);

      const runId = await heldEpic(world);
      await killWorker(world, runId);
      const shown = await world.sous("show", runId, "--json");
      assert.equal((JSON.parse(shown.stdout) as { status?: string }).status, "interrupted", shown.stdout);

      const before = turns(world.log());
      assert.deepEqual(before.map((line) => line.prompt).sort(), [1, 2, 3].flatMap((n) => [implement(n), tests(n)]).sort());
      const [built, held] = [turnOf(before, implement(2))!, turnOf(before, tests(2))!];
      assert.equal(held.sessionId, built.sessionId, "ticket 2's implementer keeps its session for the tests");

      const resumed = await world.sous("resume", runId, "--wait", "--json").catch((error: Error) => {
        // A resume that hangs shows what the fakes were asked and what the run saved.
        const asked = turns(world.log()).map((line) => `${line.prompt} (session ${line.sessionId}, resume ${line.resume})`);
        throw new Error(`${error.message}\nasked:\n${asked.join("\n")}\nsaved:\n${JSON.stringify(readState(world.paths, runId), null, 2)}`);
      });
      assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
      assert.equal(readState(world.paths, runId)?.status, "completed");
      assert.deepEqual(
        (JSON.parse(resumed.stdout) as { result?: unknown }).result,
        ["1", "2", "3"].map((n) => ({ n, said: "Tested." })),
      );

      const after = turns(world.log()).slice(before.length);
      assert.deepEqual(
        after.map((line) => line.prompt),
        [CONTINUE],
        "tickets 1 and 3 and ticket 2's first turn replay from the journal, and ticket 2 goes on with the continuation",
      );
      const [next] = after;
      assert.equal(typeof held.sessionId, "string");
      assert.equal(next!.sessionId, held.sessionId, "ticket 2's session");
      assert.equal(next!.resume, true, "a new program resumed the session");
      assert.equal(next!.cwd, held.cwd, "in ticket 2's worktree");
      assert.equal(existsSync(held.cwd!), false, "ticket 2's worktree is gone once its workflow returns");

      const branches = world.git("branch", "--list", "sous/*", "--format=%(refname:short)").split("\n").filter(Boolean);
      assert.equal(branches.length, 3, `branches: ${branches.join(", ")}`);
      const byTicket = new Map(branches.map((branch) => [world.git("log", "-1", "--format=%s", branch), branch]));
      for (const n of [1, 2, 3]) {
        const branch = byTicket.get(`Ticket ${n}`);
        assert.ok(branch, `a branch ends with ticket ${n}'s commit: ${[...byTicket.keys()].join(", ")}`);
        assert.deepEqual(world.git("log", "--format=%s", `main..${branch}`).split("\n"), [`Ticket ${n}`], `${branch} holds only ticket ${n}'s commit`);
        assert.equal(world.git("diff", "--name-only", `main...${branch}`), "store.txt");
        assert.equal(world.git("show", `${branch}:store.txt`), `value = ${n}`);
      }

      assert.equal(world.git("status", "--porcelain"), "", "the person's checkout did not change");
      assert.equal(world.git("rev-parse", "HEAD"), world.git("rev-parse", "main"));
    });
  });
}

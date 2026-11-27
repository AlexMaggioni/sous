// Live tests of phase 5 of the workflow shape: places and forks through `sous run`.
//
// A fork on each program: a planner gets a code word, and a fork with place "worktree" gets a
// second word and writes it to a file. The fork recalls both words, the planner only its own, and
// the fork's branch holds the file through the commit sous makes when the fork's scope ends.
//
// An epic on each program, as in scenario 9: two ticket workflows at once, each with place
// "worktree". Each ticket's implementer writes the same file with its own number, so each ticket's
// branch holds only its own change, and the person's checkout does not change. On Claude Code the
// implementer commits. Codex's sandbox keeps .git read-only, in a worktree as in a checkout, and a
// commit needs a rights request the smallest model does not make, so there sous commits the file
// when the ticket's scope ends.
//
// Test 7 of the design, on Claude Code: `/goal` in a session with place "worktree", in a folder
// Claude Code never saw. A goal's Stop hook clears the goal once it is met. So the test asks
// `/goal` again in the same session, which reports the goal without a model call, and passes only
// when no goal is left set and the fixture's tests pass in the worktree.
//
// It is off by default. It needs Claude Code and Codex and your own logins, so run it from
// packages/cli without test/with-temp-home.mjs, after pnpm build:
//
//   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID SOUS_LIVE_PLACES=1 ../../node_modules/.bin/tsx --test test/live/places.test.ts
//
// Claude Code runs on haiku at low effort, and Codex on gpt-6-luna at low effort. Each test prints
// each turn's status, cost, tokens and session, and the run's cost.

import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { listRecords } from "@sous-run/engine";
import { claudeCommandOutputs, liveWorld, programPrompts, turnLine, turnsOf, type RunState } from "../helpers/live-run.js";
import { TEST_COMMAND, plantStubs } from "../helpers/stub-repo.js";

const ON = process.env.SOUS_LIVE_PLACES === "1";
const EFFORT = "low";
const WORD = "PELICAN-4417";
const SECOND = "HERON-2210";
const REMEMBER = `Remember the code word ${WORD}. Reply with only OK.`;
const WRITE = `Remember a second code word, ${SECOND}. Create a file named word.txt in the current folder that holds only ${SECOND}. Then reply with only OK.`;
const RECALL = "Reply with only the code words this conversation gave you, separated by a space, or NONE.";
const OBJECTIVE = "every test in test/ passes";
const TICKET = (commit: boolean) =>
  `Create a file named ticket.txt in the current folder that holds only the number \${args.n}. ${commit ? "Commit it with git, with the message 'Ticket \${args.n}'." : "Do not commit it."} Then reply with only OK.`;

const PROGRAMS = [
  { program: "claude", model: "claude/haiku" },
  { program: "codex", model: "codex/gpt-6-luna" },
] as const;

const forkScript = (model: string) => `export const meta = { name: 'fork', description: 'A planner and a fork in a worktree' }
const plan = session({ label: 'planner', model: '${model}', effort: '${EFFORT}' })
await plan.send(${JSON.stringify(REMEMBER)})
const fork = plan.fork({ label: 'fork', place: 'worktree' })
await fork.send(${JSON.stringify(WRITE)})
const forked = await fork.send(${JSON.stringify(RECALL)}, { label: 'fork recall' })
const original = await plan.send(${JSON.stringify(RECALL)}, { label: 'recall' })
return { forked, original, branch: fork.branch, cwd: fork.cwd }`;

const ticketScript = (model: string) => `export const meta = { name: 'ticket', description: 'One ticket', inputs: { n: 'The ticket number' } }
const impl = session({ label: 'implementer', model: '${model}', effort: '${EFFORT}' })
return { n: args.n, said: await impl.send(\`${TICKET(model.startsWith("claude/"))}\`) }`;

const EPIC = `export const meta = { name: 'epic', description: 'Two tickets at once, each in a worktree' }
return await parallel([1, 2].map((n) => () => workflow('ticket', { n: String(n) }, { place: 'worktree', label: 'ticket ' + n })))`;

const goalScript = `export const meta = { name: 'goal', description: 'A goal in a worktree of its own', place: 'folder' }
const impl = session({ label: 'impl', place: 'worktree', model: 'claude/haiku', effort: '${EFFORT}' })
await impl.send(${JSON.stringify(`/goal ${OBJECTIVE}`)})
await impl.send('/goal', { label: 'goal state' })
const tests = await sh(${JSON.stringify(TEST_COMMAND)}, { label: 'tests', cwd: impl.cwd, allowFail: true })
return { tests: tests.code, branch: impl.branch, cwd: impl.cwd }`;

/** Prints each turn of the labels, and the run's cost. */
function report(t: TestContext, state: RunState, labels: string[]): void {
  for (const label of labels) for (const turn of turnsOf(state, label)) t.diagnostic(turnLine(turn));
  t.diagnostic(`run ${state.status}: $${state.tokenUsage?.cost ?? "?"}, ${state.tokenUsage?.total ?? "?"} tokens`);
}

/** The one session id the turns of a label ran in. */
function sessionOf(state: RunState, label: string): string {
  const ids = [...new Set(turnsOf(state, label).map((turn) => turn.sessionId))];
  assert.equal(ids.length, 1, `the turns of ${label} ran in sessions ${JSON.stringify(ids)}`);
  assert.ok(ids[0], `the ${label} step recorded no session`);
  return ids[0];
}

describe("places and forks live", { skip: ON ? false : "set SOUS_LIVE_PLACES=1 to run it, on your own logins" }, () => {
  for (const { program, model } of PROGRAMS) {
    test(`on ${program}, a fork in a worktree knows both words, the planner only its own, and the fork's branch keeps its file`, { timeout: 600_000 }, async (t) => {
      const world = liveWorld(t, `fork-${program}`);
      world.write(".sous/workflows/fork.js", forkScript(model));
      t.diagnostic(`home ${world.home}, project ${world.project}`);

      const run = await world.sous("run", "fork", "--wait", "--json");

      const state = world.state();
      report(t, state, ["planner", "fork", "fork recall", "recall"]);
      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
      assert.equal(state.status, "completed");
      const { forked, original, branch, cwd } = (JSON.parse(run.stdout) as { result: { forked: unknown; original: unknown; branch: string; cwd: string } }).result;
      const [forkSaid, planSaid] = [JSON.stringify(forked), JSON.stringify(original)];
      assert.ok(forkSaid.includes(WORD) && forkSaid.includes(SECOND), `the fork's recall is ${forkSaid}`);
      assert.ok(planSaid.includes(WORD) && !planSaid.includes(SECOND), `the planner's recall is ${planSaid}`);

      const [planner, fork, forkRecall, recall] = ["planner", "fork", "fork recall", "recall"].map((label) => sessionOf(state, label));
      assert.notEqual(fork, planner, "the fork has a session of its own");
      assert.equal(forkRecall, fork);
      assert.equal(recall, planner, "the planner goes on in its own session");

      assert.match(branch, /^sous\/.+-fork-[0-9a-f]{6}$/);
      assert.ok(cwd.startsWith(world.paths.worktrees), `the fork worked in ${cwd}`);
      assert.equal(world.git("show", `${branch}:word.txt`), SECOND, "the fork's branch holds the file it wrote");
      assert.equal(world.git("status", "--porcelain"), "", "the person's checkout did not change");
    });
  }

  for (const { program, model } of PROGRAMS) {
    test(`on ${program}, an epic of two tickets in worktrees of their own keeps one branch per ticket`, { timeout: 600_000 }, async (t) => {
      const world = liveWorld(t, `epic-${program}`);
      world.write(".sous/workflows/ticket.js", ticketScript(model));
      world.write(".sous/workflows/epic.js", EPIC);
      t.diagnostic(`home ${world.home}, project ${world.project}`);

      const run = await world.sous("run", "epic", "--wait", "--json");

      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
      const { result, status } = JSON.parse(run.stdout) as { status: string; result: { n: string }[] };
      assert.equal(status, "completed");
      assert.deepEqual(result.map((ticket) => ticket.n), ["1", "2"]);
      const branches = world.git("branch", "--list", "sous/*", "--format=%(refname:short)").split("\n").filter(Boolean);
      t.diagnostic(`branches: ${branches.join(", ")}`);
      assert.equal(branches.length, 2, `branches: ${branches.join(", ")}`);
      const records = listRecords(world.paths);
      assert.equal(records.length, 1, "the tickets run inside the epic's run");
      const tickets = Object.values(records[0]!.nested ?? {}).map(({ label, branch }) => ({ label, branch }));
      assert.deepEqual(tickets.map((ticket) => ticket.label).sort(), ["ticket 1", "ticket 2"]);
      assert.deepEqual(tickets.map((ticket) => ticket.branch).sort(), [...branches].sort(), "each ticket's run records its branch");
      for (const { label, branch } of tickets) {
        assert.equal(world.git("diff", "--name-only", `main...${branch}`), "ticket.txt", `${branch} holds only its ticket's file`);
        t.diagnostic(`${label}, ${branch}: ${world.git("log", "--format=%s", `main..${branch}`).replace(/\n/g, " | ")}`);
        assert.equal(world.git("show", `${branch}:ticket.txt`), label!.slice("ticket ".length), `${label}'s branch holds its own number`);
      }
      assert.equal(world.git("status", "--porcelain"), "", "the person's checkout did not change");
      assert.equal(world.git("rev-parse", "HEAD"), world.git("rev-parse", "main"));
    });
  }

  test("test 7: /goal runs in a session's new worktree on Claude Code, and its Stop hook clears the met goal", { timeout: 900_000 }, async (t) => {
    const world = liveWorld(t, "goal-worktree");
    plantStubs(world);
    world.write(".sous/workflows/goal.js", goalScript);
    t.diagnostic(`home ${world.home}, project ${world.project}`);

    const run = await world.sous("run", "goal", "--wait", "--json");

    const state = world.state();
    report(t, state, ["impl", "goal state"]);
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(state.status, "completed");
    const { tests, branch, cwd } = (JSON.parse(run.stdout) as { result: { tests: number; branch: string; cwd: string } }).result;
    assert.ok(cwd.startsWith(world.paths.worktrees), `the session worked in ${cwd}`);
    assert.equal(tests, 0, "the fixture's tests fail in the session's worktree");

    const session = sessionOf(state, "impl");
    assert.equal(sessionOf(state, "goal state"), session);
    const prompts = programPrompts("claude", session);
    t.diagnostic(`the session's user messages: ${JSON.stringify(prompts.map((text) => text.slice(0, 120)))}`);
    assert.match(prompts[0] ?? "", /<command-name>\/goal<\/command-name>/, "Claude Code ran /goal as a command in the worktree");
    const goals = claudeCommandOutputs(session, "goal");
    t.diagnostic(`/goal printed: ${JSON.stringify(goals)}`);
    assert.match(goals.at(-1) ?? "", /No goal set/, "the goal's Stop hook ran in the worktree and cleared the met goal");
    assert.notEqual(world.git("rev-parse", branch), world.git("rev-parse", "main"), "the session's branch keeps the work");
  });
});

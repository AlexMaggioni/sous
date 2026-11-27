// fork() makes a handle whose session starts as a copy of its parent's, as the parent's last
// finished turn left it. Nothing the fork hears reaches the parent. The fork's first turn hashes
// apart from the same turn in the parent, and a resume replays the fork's rows without forking
// again. A fork works in its parent's folder, or with place "worktree" in a worktree of its own,
// made from the last commit of its parent's folder.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../../src/errors.js";
import { createSteps } from "../../src/steps/steps.js";
import type { StepRequest } from "../../src/steps/agent-run.js";
import { PERSON, testHome } from "../../src/testing.js";
import { runWorkflow, type JournalEntry, type WorkflowRunOptions } from "../../src/workflow.js";
import { dryRun } from "../../src/workflows/dry-run.js";
import { fakePlace, onFakes, type FakeLine, type FakePlace } from "../helpers/fake-steps.js";
import { git, initGitRepo } from "../helpers/git.js";
import { journalResume } from "../helpers/journal-resume.js";
import { tempPlaces } from "../helpers/places.js";
import { runnerFrom } from "../helpers/runners.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const meta = "export const meta = { name: 'forks', description: 'forked sessions' }";
const RECALL = [{ match: "^Recall", recall: true }];
const PROGRAMS = [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-6.1-sol"],
] as const;
/** A value made in the script's realm, as plain data. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
const forked = (line: FakeLine | undefined) => (line as { fork?: boolean } | undefined)?.fork === true;

async function run(place: FakePlace, body: string, extra: Partial<WorkflowRunOptions> = {}) {
  const agent = createSteps(onFakes(place));
  const journal: JournalEntry[] = [];
  try {
    const result = await runWorkflow(`${meta}\n${body}`, {
      agent,
      persistLogs: false,
      cwd: place.cwd,
      onAgentJournal: (entry) => journal.push(entry),
      ...extra,
    });
    return { result, journal };
  } finally {
    await agent.dispose();
  }
}

/** Runs a script that the engine must refuse, and gives the refusal's message. */
async function refused(place: FakePlace, body: string): Promise<string> {
  let message = "";
  await assert.rejects(run(place, body), (error: unknown) => {
    assert.ok(error instanceof WorkflowError, String(error));
    assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, error.message);
    message = error.message;
    return true;
  });
  return message;
}

describe("fork()", () => {
  for (const [program, model] of PROGRAMS) {
    it(`on ${program}, starts with its parent's words, and what it hears never reaches the parent`, async () => {
      const place = fakePlace(RECALL);
      const { result } = await run(
        place,
        `const s = session({ label: 'impl', model: '${model}' })
await s.send('Remember the word PLUM.')
const f = s.fork({ label: 'trial' })
await f.send('Remember the word KIWI.')
const fresh = session({ label: 'fresh', model: '${model}' })
return {
  fork: await f.send('Recall your words.'),
  parent: await s.send('Recall your words.'),
  fresh: await fresh.send('Recall your words.'),
  cwd: f.cwd === s.cwd,
}`,
      );
      assert.deepEqual(plain(result.result), { fork: "PLUM KIWI", parent: "PLUM", fresh: "Nothing to recall.", cwd: true });
      const [plum, kiwi, forkRecall, parentRecall] = place.lines();
      assert.ok(forked(kiwi), "the fork's first turn forks the parent's session");
      assert.notEqual(kiwi!.sessionId, plum!.sessionId, "the fork has a session of its own");
      assert.equal(forkRecall!.sessionId, kiwi!.sessionId, "the fork's next turn goes on in the fork");
      assert.equal(parentRecall!.sessionId, plum!.sessionId, "the parent goes on in its own session");
    });
  }

  it("fails before its parent's first finished turn, while a turn runs, with a label in use and on another program, and a failed fork() changes nothing", async () => {
    const place = fakePlace(RECALL);
    const model = "claude/haiku";
    const tried = (call: string) => `(() => { try { ${call}; return 'made' } catch (error) { return error.message } })()`;
    const { result } = await run(
      place,
      `const s = session({ label: 's', model: '${model}' })
const early = ${tried("s.fork({ label: 'f' })")}
const sending = s.send('Remember the word PLUM.')
const during = ${tried("s.fork({ label: 'f' })")}
await sending
const taken = ${tried("s.fork({ label: 's' })")}
const program = ${tried("s.fork({ label: 'f', model: 'codex/gpt-6.1-sol' })")}
const f = s.fork({ label: 'f' })
return { early, during, taken, program, recalled: await f.send('Recall your words.') }`,
    );
    const got = plain(result.result) as Record<string, string>;
    assert.match(got.early!, /session "s": fork\(\).*no finished turn/);
    assert.match(got.during!, /runs a turn/);
    assert.match(got.taken!, /"s" is in use/);
    assert.match(got.program!, /another program/);
    assert.equal(got.recalled, "PLUM", "the label f was still free, and the fork starts from the finished turn");
    assert.match(await refused(place, "session({ label: 's' }).fork({ label: 'f', schema: {} })\nreturn 1"), /schema is not a session option/);
  });

  it("hashes its first turn apart from its parent's, and a resume replays its rows without forking again, after the parent's later turns changed", async () => {
    const place = fakePlace(RECALL);
    const model = "claude/haiku";
    const first = await run(
      place,
      `const s = session({ label: 's', model: '${model}' })
await s.send('Remember the word PLUM.')
const f = s.fork({ label: 'f' })
await f.send('Remember the word KIWI.')
await s.send('Remember the word KIWI.')
await s.send('Remember the word MANGO.')
return 1`,
    );
    const rows = [...first.journal].sort((left, right) => left.index - right.index);
    assert.notEqual(rows[1]!.hash, rows[2]!.hash, "the same turn on the fork and on its parent hashes apart");
    const forkId = place.lines()[1]!.sessionId;
    const lines = place.lines().length;

    const again = await run(
      place,
      `const s = session({ label: 's', model: '${model}' })
await s.send('Remember the word PLUM.')
const f = s.fork({ label: 'f' })
await f.send('Remember the word KIWI.')
return await f.send('Recall your words.')`,
      journalResume(first.journal),
    );
    assert.equal(again.result.result, "PLUM KIWI");
    const live = place.lines().slice(lines);
    assert.equal(live.length, 1, "the parent's and the fork's first turns replayed");
    assert.equal(live[0]!.sessionId, forkId, "the fork's next turn goes on in the fork its row names");
    assert.equal(live[0]!.resume, true);
    assert.equal(forked(live[0]), false, "a replayed fork never forks again");
  });

  it("forks its parent's session again on a resume after its first turn failed, and the parent stays as it was", async () => {
    const place = fakePlace([{ match: "KIWI", fail: "boom", times: 1 }, ...RECALL]);
    const body = `const s = session({ label: 's', model: 'claude/haiku' })
await s.send('Remember the word PLUM.')
const f = s.fork({ label: 'f' })
await f.send('Remember the word KIWI.', { retries: 0 })
return { fork: await f.send('Recall your words.'), parent: await s.send('Recall your words.') }`;
    const journal: JournalEntry[] = [];
    await assert.rejects(run(place, body, { onAgentJournal: (entry) => journal.push(entry) }), /step "f" failed/);
    const again = await run(place, body, journalResume(journal));
    assert.deepEqual(plain(again.result.result), { fork: "PLUM KIWI", parent: "PLUM" });
    const [plum, failed, kiwi] = place.lines();
    assert.ok(forked(failed) && forked(kiwi), "each first turn forks the parent's session");
    assert.notEqual(kiwi!.sessionId, plum!.sessionId);
    assert.notEqual(kiwi!.sessionId, failed!.sessionId, "the resume forks anew");
  });

  it("counts its turns from its own total, which starts at nothing, and the parent's from the parent's", async () => {
    const place = fakePlace();
    const ends: Array<{ label: string; cost?: number }> = [];
    const { result } = await run(
      place,
      `const s = session({ label: 's', model: 'claude/haiku' })
await s.send('One.')
const f = s.fork({ label: 'f' })
await f.send('Two.')
await f.send('Three.')
return await s.send('Four.')`,
      { onAgentEnd: (event) => ends.push({ label: event.label, cost: event.usage?.cost }) },
    );
    const turn = 0.0012;
    for (const end of ends) assert.ok(end.cost !== undefined && Math.abs(end.cost - turn) < 1e-9, `${end.label} counts one turn: ${end.cost}`);
    assert.ok(Math.abs((result.tokenUsage?.cost ?? 0) - turn * 4) < 1e-9, `the run's cost: ${result.tokenUsage?.cost}`);
  });

  it("runs in its parent's folder, or in a worktree of its own from the last commit of its parent's folder", async (t: TestContext) => {
    const temp = tempPlaces();
    const repo = initGitRepo(mkdtempSync(join(tmpdir(), "sous-fork-repo-")));
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
      temp.cleanup();
    });
    const turns: Array<{ prompt: string; cwd?: string; fork?: boolean; from?: string; sawCommitted?: boolean; sawLoose?: boolean }> = [];
    let sessions = 0;
    const agent = runnerFrom((prompt: string, options: StepRequest) => {
      const cwd = options.cwd!;
      const from = options.continueFromSession?.sessionId;
      const sessionId = from && !options.fork ? from : `session-${++sessions}`;
      options.onSessionOpen?.({ sessionId, backendId: "claude", cwd, reopen: { load: true, resume: true, list: true } });
      turns.push({ prompt, cwd, ...(options.fork ? { fork: true } : {}), ...(from ? { from } : {}), sawCommitted: existsSync(join(cwd, "committed.txt")), sawLoose: existsSync(join(cwd, "loose.txt")) });
      if (prompt === "commit") {
        writeFileSync(join(cwd, "committed.txt"), "committed\n");
        git(cwd, "add", ".");
        git(cwd, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "the parent's commit");
        writeFileSync(join(cwd, "loose.txt"), "loose\n");
      }
      if (prompt === "write") writeFileSync(join(cwd, "trial.txt"), "trial\n");
      return { status: "done", result: "ok", message: null };
    });
    const runId = "fork-run";
    const ran = await runWorkflow(
      `${meta}
const s = session({ label: 'impl', place: 'worktree' })
await s.send('commit')
const critic = s.fork({ label: 'critic' })
const trial = s.fork({ label: 'trial', place: 'worktree' })
await critic.send('look')
await trial.send('write')
return { s: [s.cwd, s.branch], critic: [critic.cwd, critic.branch], trial: [trial.cwd, trial.branch] }`,
      { runId, cwd: repo, persistLogs: false, places: temp.places(runId), agent },
    );
    const name = (label: string) => `${runId}-${label}-${createHash("sha256").update(`${runId}\n${label}`).digest("hex").slice(0, 6)}`;
    const own = { dir: join(temp.home.worktrees, name("impl")), branch: `sous/${name("impl")}` };
    const trial = { dir: join(temp.home.worktrees, name("trial")), branch: `sous/${name("trial")}` };
    assert.deepEqual(plain(ran.result), { s: [own.dir, own.branch], critic: [own.dir, own.branch], trial: [trial.dir, trial.branch] });
    assert.deepEqual(turns, [
      { prompt: "commit", cwd: own.dir, sawCommitted: false, sawLoose: false },
      { prompt: "look", cwd: own.dir, fork: true, from: "session-1", sawCommitted: true, sawLoose: true },
      { prompt: "write", cwd: trial.dir, fork: true, from: "session-1", sawCommitted: true, sawLoose: false },
    ]);
    assert.equal(git(repo, "show", `${trial.branch}:trial.txt`), "trial");
    assert.equal(git(repo, "log", "-1", "--format=%s", trial.branch), "sous: uncommitted work of trial");
    assert.equal(existsSync(trial.dir), false, "the fork's worktree ends when the workflow returns");
  });

  it("runs in a dry run, on the stand-ins", async () => {
    const { paths, projectDir } = testHome({
      forks: `${meta}
const s = session({ label: 's' })
await s.send('Plan it.')
const f = s.fork({ label: 'f' })
return [await f.send('Try it.'), await s.send('Do it.')]`,
    });
    const dry = await dryRun(paths, { who: PERSON, workflow: "forks", projectDir, inputs: {} });
    assert.equal(dry.status, "completed", dry.reason);
    assert.deepEqual(dry.agents, ["s", "f", "s"]);
  });
});

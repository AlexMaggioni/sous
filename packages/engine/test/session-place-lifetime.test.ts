// A worktree through the script. session({ place: "worktree" }) makes the worktree when it is
// called, every turn of the handle runs in it, and the workflow that made it closes it when it
// returns: sous commits the work left in it, removes the folder and keeps the branch.
// agent(prompt, { place: "worktree" }) gets a worktree for its one step, which closes when the
// step ends. A pause or a failure keeps the folder, so a resume goes on in it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { runWorkflow, type JournalEntry, type WorkflowRunOptions } from "../src/workflow.js";
import type { StepRequest } from "../src/steps/agent-run.js";
import type { HomePaths } from "../src/runs/home.js";
import type { RunPlaces } from "../src/places/places.js";
import { git, initGitRepo } from "./helpers/git.js";
import { journalResume } from "./helpers/journal-resume.js";
import { stepTree, tempPlaces } from "./helpers/places.js";
import { runnerFrom } from "./helpers/runners.js";

const meta = "export const meta = { name: 'placed', description: 'steps in worktrees' }";
/** A turn's status that says the agent is still working. */
const WORKING = { status: "working", result: null, message: null };
/** A value made in the script's realm, as plain data. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
const CONTINUE = "Continue the task.";
const leftover = (label: string) => `sous: uncommitted work of ${label}`;
const hash6 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 6);

interface World {
  home: HomePaths;
  repo: string;
  places: (rootRunId: string) => RunPlaces;
}

/** A home and a repository with a folder "sub". */
function world(t: TestContext): World {
  const temp = tempPlaces();
  const repo = initGitRepo(mkdtempSync(join(tmpdir(), "sous-place-life-repo-")));
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "keep.txt"), "sub\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "sub");
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    temp.cleanup();
  });
  return { home: temp.home, repo, places: temp.places };
}

interface Turn {
  prompt: string;
  cwd: string | undefined;
}

/** Runs `body` as run `runId` in the repository. `answer` answers each turn, and every turn is kept. */
function start(w: World, runId: string, body: string, answer: (prompt: string, options: StepRequest) => unknown, extra: Partial<WorkflowRunOptions> = {}) {
  const logs: string[] = [];
  const turns: Turn[] = [];
  const settled = runWorkflow(`${meta}\n${body}`, {
    runId,
    cwd: w.repo,
    persistLogs: false,
    places: w.places(runId),
    agent: runnerFrom((prompt, options) => {
      turns.push({ prompt, cwd: options.cwd });
      return answer(prompt, options);
    }),
    onLog: (message) => logs.push(message),
    ...extra,
  }).then(
    (ran) => ({ ran, error: undefined }),
    (error: unknown) => ({ ran: undefined, error }),
  );
  return { settled, logs, turns };
}

/** A turn that writes the file its prompt names, "write <file>", in its folder. */
function writes(prompt: string, options: StepRequest): string {
  const file = /^write (\S+)/.exec(prompt)?.[1];
  if (file) writeFileSync(join(options.cwd!, file), `${file}\n`);
  return "Done.";
}

const sessionName = (runId: string, label: string) => `${runId}-${label.toLowerCase()}-${hash6(`${runId}\n${label}`)}`;
const branchExists = (repo: string, branch: string) => git(repo, "branch", "--list", branch) !== "";
const lastMessage = (repo: string, branch: string) => git(repo, "log", "-1", "--format=%s", branch);
const fileOn = (repo: string, branch: string, path: string) => git(repo, "show", `${branch}:${path}`);

describe("session() with place worktree", () => {
  it("makes the worktree at once, and the handle names its folder and branch", async (t) => {
    const w = world(t);
    const name = sessionName("run-a", "Implementer");
    const { settled } = start(
      w,
      "run-a",
      `const s = session({ label: 'Implementer', place: 'worktree' })
const shown = await sh('git branch --show-current', { cwd: s.cwd })
return { cwd: s.cwd, branch: s.branch, shown: shown.stdout.trim() }`,
      writes,
    );
    const { ran, error } = await settled;
    assert.equal(error, undefined);
    assert.deepEqual(plain(ran!.result), { cwd: join(w.home.worktrees, name), branch: `sous/${name}`, shown: `sous/${name}` });
    assert.equal(existsSync(join(w.home.worktrees, name)), false, "the workflow's return removes the folder");
    assert.equal(branchExists(w.repo, `sous/${name}`), false, "a branch that never moved goes with it");
  });

  it("runs every turn there, and the workflow's return commits the work left and keeps the branch", async (t) => {
    const w = world(t);
    const name = sessionName("run-b", "Implementer");
    const dir = join(w.home.worktrees, name);
    const { settled, turns } = start(
      w,
      "run-b",
      `const s = session({ label: 'Implementer', place: 'worktree', cwd: 'sub' })
await s.send('write a.txt')
await s.send('write b.txt', { until: 'turn' })
return s.cwd`,
      writes,
    );
    const { ran, error } = await settled;
    assert.equal(error, undefined);
    assert.equal(ran!.result, join(dir, "sub"), "the handle's cwd is its cwd inside the worktree");
    assert.deepEqual(turns, [
      { prompt: "write a.txt", cwd: join(dir, "sub") },
      { prompt: "write b.txt", cwd: join(dir, "sub") },
    ]);
    assert.equal(existsSync(dir), false, "the folder goes");
    assert.equal(lastMessage(w.repo, `sous/${name}`), leftover("Implementer"));
    assert.equal(fileOn(w.repo, `sous/${name}`, "sub/a.txt"), "a.txt");
    assert.equal(fileOn(w.repo, `sous/${name}`, "sub/b.txt"), "b.txt");
    assert.equal(existsSync(join(w.repo, "sub", "a.txt")), false, "the project folder is untouched");
  });

  it("keeps the folder when the run pauses, and a resume goes on in it", async (t) => {
    const w = world(t);
    const name = sessionName("run-c", "Implementer");
    const dir = join(w.home.worktrees, name);
    const body = `const s = session({ label: 'Implementer', place: 'worktree' })
await s.send('write a.txt')
await s.send('write b.txt')
return 'built'`;
    const pause = new AbortController();
    const journal: JournalEntry[] = [];
    const first = start(
      w,
      "run-c",
      body,
      (prompt, options) => {
        pause.abort();
        return writes(prompt, options);
      },
      { pauseSignal: pause.signal, onAgentJournal: (entry) => journal.push(entry) },
    );
    const paused = await first.settled;
    assert.ok(paused.error, "the run paused before the second turn");
    assert.deepEqual(first.turns.map((turn) => turn.prompt), ["write a.txt"]);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a.txt\n", "the folder and its work stay");

    const second = start(w, "run-c", body, writes, journalResume(journal, "run-c"));
    const resumed = await second.settled;
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.ran!.result, "built");
    assert.deepEqual(second.turns, [{ prompt: "write b.txt", cwd: dir }], "the first turn replays, and the second runs in the same folder");
    assert.equal(existsSync(dir), false);
    assert.equal(fileOn(w.repo, `sous/${name}`, "a.txt"), "a.txt");
    assert.equal(fileOn(w.repo, `sous/${name}`, "b.txt"), "b.txt");
  });

  it("keeps the folder when the run fails", async (t) => {
    const w = world(t);
    const dir = join(w.home.worktrees, sessionName("run-d", "Implementer"));
    const { settled } = start(
      w,
      "run-d",
      `const s = session({ label: 'Implementer', place: 'worktree' })
await s.send('write a.txt')
return await s.send('fail now')`,
      (prompt, options) => {
        if (prompt === "fail now") throw new Error("the program crashed");
        return writes(prompt, options);
      },
      { agentRetries: 0 },
    );
    const { error } = await settled;
    assert.ok(error, "the run failed");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a.txt\n");
  });

  it("gets one at once when its agent's file names place worktree", async (t) => {
    const w = world(t);
    const name = sessionName("run-i", "Apart");
    const cwds: Array<string | undefined> = [];
    const apart = runnerFrom((_prompt, options) => {
      cwds.push(options.cwd);
      return "Done.";
    });
    const { settled } = start(
      w,
      "run-i",
      `const s = session({ label: 'Apart', agentType: 'apart' })
await s.send('work')
return s.branch`,
      writes,
      { agent: { ...apart, placeOf: (agentType: string) => (agentType === "apart" ? "worktree" : undefined) } },
    );
    const { ran, error } = await settled;
    assert.equal(error, undefined);
    assert.equal(ran!.result, `sous/${name}`);
    assert.deepEqual(cwds, [join(w.home.worktrees, name)]);
  });

  it("works in the project folder outside git, and the log says why", async (t) => {
    const w = world(t);
    const outside = mkdtempSync(join(tmpdir(), "sous-place-life-plain-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const { settled, turns, logs } = start(
      w,
      "run-e",
      `const s = session({ label: 'Implementer', place: 'worktree' })
await s.send('write a.txt')
return { cwd: s.cwd, branch: s.branch ?? null }`,
      writes,
      { cwd: outside },
    );
    const { ran, error } = await settled;
    assert.equal(error, undefined);
    assert.deepEqual(plain(ran!.result), { cwd: outside, branch: null });
    assert.deepEqual(turns, [{ prompt: "write a.txt", cwd: outside }]);
    assert.ok(logs.includes('place ignored for "Implementer" (not a git repository)'), logs.join("\n"));
  });
});

describe("agent() with place worktree", () => {
  it("runs every turn and its check in a worktree of its own, which closes when the step ends", async (t) => {
    const w = world(t);
    const name = stepTree("run-f", "Edit it", "build it");
    const dir = join(w.home.worktrees, name);
    const seen: boolean[] = [];
    const { settled, turns } = start(
      w,
      "run-f",
      `const built = await agent('build it', { label: 'Edit it', place: 'worktree', check: 'test -f made.txt' })
await agent('look', { label: 'look', until: 'turn' })
return built`,
      (prompt, options) => {
        if (prompt === "build it") return WORKING;
        if (prompt === "look") {
          seen.push(existsSync(dir));
          return "Looked.";
        }
        writeFileSync(join(options.cwd!, "made.txt"), "made\n");
        return "Built.";
      },
    );
    const { ran, error } = await settled;
    assert.equal(error, undefined);
    assert.equal(ran!.result, "Built.", "the check passed, so it ran where the agent wrote");
    assert.deepEqual(turns.slice(0, 2), [
      { prompt: "build it", cwd: dir },
      { prompt: CONTINUE, cwd: dir },
    ]);
    assert.equal(turns[2]!.cwd, w.repo, "a step with no place works in the project folder");
    assert.deepEqual(seen, [false], "the step's end removed the folder before the next step");
    assert.equal(lastMessage(w.repo, `sous/${name}`), leftover("Edit it"));
    assert.equal(fileOn(w.repo, `sous/${name}`, "made.txt"), "made");
  });

  it("gives each call with the same label a worktree of its own", async (t) => {
    const w = world(t);
    const { settled, turns } = start(
      w,
      "run-g",
      `await agent('write a.txt', { label: 'Edit it', place: 'worktree' })
await agent('write b.txt', { label: 'Edit it', place: 'worktree' })
return 'ok'`,
      writes,
    );
    assert.equal((await settled).error, undefined);
    assert.deepEqual(
      turns.map((turn) => turn.cwd),
      [join(w.home.worktrees, stepTree("run-g", "Edit it", "write a.txt")), join(w.home.worktrees, stepTree("run-g", "Edit it", "write b.txt"))],
    );
    assert.equal(fileOn(w.repo, `sous/${stepTree("run-g", "Edit it", "write b.txt")}`, "b.txt"), "b.txt");
  });

  it("counts the calls with the same label and prompt, and keeps apart labels whose names match", async (t) => {
    const w = world(t);
    const { settled, turns } = start(
      w,
      "run-k",
      `await agent('write a.txt', { label: 'Fix A', place: 'worktree' })
await agent('write a.txt', { label: 'Fix A', place: 'worktree' })
await agent('write a.txt', { label: 'fix-a', place: 'worktree' })
return 'ok'`,
      writes,
    );
    assert.equal((await settled).error, undefined);
    const dirs = turns.map((turn) => turn.cwd);
    assert.deepEqual(dirs, [
      join(w.home.worktrees, stepTree("run-k", "Fix A", "write a.txt", 1)),
      join(w.home.worktrees, stepTree("run-k", "Fix A", "write a.txt", 2)),
      join(w.home.worktrees, stepTree("run-k", "fix-a", "write a.txt", 1)),
    ]);
    assert.equal(new Set(dirs).size, 3, "each step had a worktree of its own");
  });

  it("keeps the folder when the run pauses during the step", async (t) => {
    const w = world(t);
    const dir = join(w.home.worktrees, stepTree("run-h", "Edit it", "write a.txt"));
    const pause = new AbortController();
    const { settled, turns } = start(
      w,
      "run-h",
      "return await agent('write a.txt', { label: 'Edit it', place: 'worktree' })",
      (prompt, options) => {
        pause.abort();
        writes(prompt, options);
        return WORKING;
      },
      { pauseSignal: pause.signal },
    );
    assert.ok((await settled).error, "the run paused before the step's next turn");
    assert.equal(turns.length, 1);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a.txt\n");
  });
});

describe("workflow() with place worktree", () => {
  it("keeps the nested workflow's folder when it throws, so the run's end or a resume finds it", async (t) => {
    const w = world(t);
    const dir = join(w.home.worktrees, "run-n-nested1");
    const child = "export const meta = { name: 'child', description: 'fails' }\nawait agent('write c.txt', { label: 'writer' })\nthrow new Error('child broke')";
    const { settled } = start(
      w,
      "run-n",
      `try {
  await workflow(${JSON.stringify(child)}, {}, { place: 'worktree', label: 'child' })
} catch (error) {
  return String(error.message)
}`,
      writes,
    );
    const { ran, error } = await settled;
    assert.equal(error, undefined);
    assert.match(String(ran!.result), /child broke/);
    assert.equal(readFileSync(join(dir, "c.txt"), "utf8"), "c.txt\n", "the folder stays with the work in it");
  });
});

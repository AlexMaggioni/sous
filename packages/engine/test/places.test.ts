import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gcWorktrees, runPlaces, type PlaceNotes } from "../src/places/places.js";
import { ensureHome, homePaths, type HomePaths } from "../src/runs/home.js";
import { createRun } from "../src/runs/launch.js";
import { loadRecord, updateRecord, type NestedRun } from "../src/runs/records.js";
import { answerQuestion, busyWorktrees, runQuestions } from "../src/runs/run.js";
import { runWorker } from "../src/runs/worker.js";
import { runWorkflow } from "../src/workflow.js";
import { placesIn, stepTree } from "./helpers/places.js";
import { heldRunner, setup, until } from "./runs/fixture.js";
import { git, initGitRepo } from "./helpers/git.js";
import { PERSON } from "../src/testing.js";

// A step with `place: "worktree"` gets its worktree from the places module, named like every
// other worktree sous makes: a folder under the home's worktrees folder, on branch sous/<name>.
// session-place.test.ts covers how a worktree closes. This file covers a step's in a run.

const gitRepo = () => initGitRepo(mkdtempSync(join(tmpdir(), "sous-places-repo-")));

function tempHome(): HomePaths {
  return ensureHome(homePaths(mkdtempSync(join(tmpdir(), "sous-places-home-"))));
}

const step = { runId: "run-9", label: "Edit it", step: { prompt: "Edit it.", occurrence: 1 } };
const EDIT = stepTree("run-9", "Edit it", "Edit it.");

describe("a step's worktree", () => {
  it("is made under the home's worktrees folder on branch sous/<name>, and an edit there leaves the project alone", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const made = placesIn(home, "run-9").sessionPlace(repo, step);
      assert.ok("tree" in made, "a worktree was made");
      const { tree } = made;
      assert.equal(tree.dir, join(home.worktrees, EDIT));
      assert.equal(tree.branch, `sous/${EDIT}`);
      assert.ok(existsSync(join(tree.dir, "file.txt")), "the worktree has a checkout");
      assert.equal(git(tree.dir, "branch", "--show-current"), tree.branch);

      writeFileSync(join(tree.dir, "file.txt"), "changed in worktree\n");
      assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("checks out its branch when the branch already exists", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      git(repo, "branch", `sous/${EDIT}`);
      const made = placesIn(home, "run-9").sessionPlace(repo, step);
      assert.ok("tree" in made, JSON.stringify(made));
      assert.equal(git(made.tree.dir, "branch", "--show-current"), `sous/${EDIT}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("closing it does not throw when git fails on broken worktree metadata", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const made = placesIn(home, "run-9").sessionPlace(repo, step);
      assert.ok("tree" in made);
      rmSync(made.tree.dir, { recursive: true, force: true });
      const meta = join(repo, ".git", "worktrees", EDIT);
      assert.ok(existsSync(meta), "git keeps the worktree's metadata after its folder is removed");
      writeFileSync(join(meta, "gitdir"), "/nonexistent/path\n");
      assert.doesNotThrow(() => placesIn(home, "run-9").closePlace(repo, made.tree, "Edit it"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("a step with place worktree works in one from places, and it is gone after the step, as the log says", async () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const seen: Array<{ cwd: string; branch: string }> = [];
      const logs: string[] = [];
      const script = `export const meta = { name: 'iso', description: 'isolated step' }
await agent('edit', { label: 'editor', place: 'worktree' })
return {}`;
      await runWorkflow(script, {
        cwd: repo,
        runId: "iso-run",
        places: placesIn(home, "iso-run"),
        persistLogs: false,
        onLog: (message) => logs.push(message),
        agent: {
          async run(_prompt, options) {
            const cwd = String(options?.cwd);
            seen.push({ cwd, branch: git(cwd, "branch", "--show-current") });
            return "ok";
          },
        },
      });
      const name = stepTree("iso-run", "editor", "edit");
      const dir = join(home.worktrees, name);
      assert.deepEqual(seen, [{ cwd: dir, branch: `sous/${name}` }]);
      assert.equal(existsSync(dir), false, "the worktree is gone after the step");
      assert.equal(git(repo, "branch", "--list", `sous/${name}`), "", "and its branch, which never moved");
      assert.ok(logs.includes(`removed    ${dir} and sous/${name}, which changed no file`), logs.join("\n"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("a step with place worktree outside a git repository works in the run's folder, and the log says why", async () => {
    const home = tempHome();
    const dir = mkdtempSync(join(tmpdir(), "sous-places-nogit-"));
    try {
      const seen: string[] = [];
      const logs: string[] = [];
      await runWorkflow(`export const meta = { name: 'iso', description: 'isolated step' }
await agent('edit', { label: 'editor', place: 'worktree' })
return {}`, {
        cwd: dir,
        runId: "iso-run",
        places: placesIn(home, "iso-run"),
        persistLogs: false,
        onLog: (message) => logs.push(message),
        agent: {
          async run(_prompt, options) {
            seen.push(String(options?.cwd));
            return "ok";
          },
        },
      });
      assert.deepEqual(seen, [dir]);
      assert.ok(logs.includes(`place ignored for "editor" (not a git repository)`), logs.join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("a step with place worktree and no places works in the run's folder, and the log says why", async () => {
    const repo = gitRepo();
    try {
      const seen: string[] = [];
      const logs: string[] = [];
      await runWorkflow(`export const meta = { name: 'iso', description: 'isolated step' }
await agent('edit', { label: 'editor', place: 'worktree' })
return {}`, {
        cwd: repo,
        runId: "iso-run",
        persistLogs: false,
        onLog: (message) => logs.push(message),
        agent: {
          async run(_prompt, options) {
            seen.push(String(options?.cwd));
            return "ok";
          },
        },
      });
      assert.deepEqual(seen, [repo]);
      assert.ok(logs.includes(`place ignored for "editor" (no home for worktrees)`), logs.join("\n"));
      assert.equal(git(repo, "branch", "--list", "sous/*"), "", "no branch was made");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the run's record names it while the step runs, and drops it after", async () => {
    const { paths, projectDir } = setup({
      iso: `export const meta = { name: 'iso', description: 'isolated step' }
return await agent('edit', { label: 'editor', place: 'worktree' })`,
    });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const { runner, calls, release } = heldRunner(() => "wait");
    const record = createRun(paths, { who: PERSON, workflow: "iso", projectDir, inputs: {}, place: "folder" });
    const worker = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: () => {} });
    await until(() => calls.length === 1);
    const name = stepTree(record.runId, "editor", "edit");
    const tree = { dir: join(paths.worktrees, name), branch: `sous/${name}` };
    assert.deepEqual(loadRecord(paths, record.runId)?.stepWorktrees, [{ ...tree, label: "editor" }], "with its label, for the commit at the run's end");
    assert.ok(existsSync(tree.dir));
    release("editor");
    assert.equal((await worker)?.status, "completed");
    assert.deepEqual(loadRecord(paths, record.runId)?.stepWorktrees, []);
    assert.equal(existsSync(tree.dir), false);
  });

  it("a resumed run's step gets one too, and the run's record names it", async () => {
    const { paths, projectDir } = setup({
      iso: `export const meta = { name: 'iso', description: 'asks, then edits', timeout: '300ms' }
await ask('Go on?')
return await agent('edit', { label: 'editor', place: 'worktree' })`,
    });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const { runner, calls, release } = heldRunner(() => "wait");
    const record = createRun(paths, { who: PERSON, workflow: "iso", projectDir, inputs: {}, place: "folder" });
    const paused = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: () => {} });
    assert.equal(paused?.status, "paused");
    const [question] = runQuestions(paths, record.runId);
    assert.ok(question);
    answerQuestion(paths, question, { via: "answer", text: "yes" }, PERSON);
    updateRecord(paths, record.runId, { timeout: undefined });

    const worker = runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: () => {} });
    await until(() => calls.length === 1);
    const name = stepTree(record.runId, "editor", "edit");
    const tree = { dir: join(paths.worktrees, name), branch: `sous/${name}` };
    assert.deepEqual(loadRecord(paths, record.runId)?.stepWorktrees, [{ ...tree, label: "editor" }]);
    assert.ok(existsSync(tree.dir));
    release("editor");
    assert.equal((await worker)?.status, "completed");
    assert.deepEqual(loadRecord(paths, record.runId)?.stepWorktrees, []);
    assert.equal(existsSync(tree.dir), false);
  });
});

type Note =
  | { nested: string; change: Partial<NestedRun>; there?: boolean }
  | { step: string; exists: boolean; there: boolean };

/** A record that keeps each note, and whether its folder was there when the note came. */
function fakeNotes(): { notes: Note[]; sink: PlaceNotes } {
  const notes: Note[] = [];
  return {
    notes,
    sink: {
      nested: (childRunId, change) => {
        notes.push({ nested: childRunId, change, ...(change.cwd ? { there: existsSync(change.cwd) } : {}) });
      },
      stepWorktree: (tree, exists) => {
        notes.push({ step: tree.dir, exists, there: existsSync(tree.dir) });
      },
    },
  };
}

describe("a run's places note each place before they make it", () => {
  it("names a step's worktree before making it, and drops the name once its branch is gone", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const { notes, sink } = fakeNotes();
      const places = runPlaces(home, sink);
      const made = places.sessionPlace(repo, step);
      assert.ok("tree" in made);
      const dir = join(home.worktrees, EDIT);
      assert.deepEqual(notes, [{ step: dir, exists: true, there: false }]);
      places.closePlace(repo, made.tree, "Edit it");
      assert.deepEqual(notes, [
        { step: dir, exists: true, there: false },
        { step: dir, exists: false, there: false },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("drops the name when git refuses the worktree and makes no branch", () => {
    const home = tempHome();
    // A repository with no commit yet: there is no HEAD to start a branch from.
    const repo = mkdtempSync(join(tmpdir(), "sous-places-unborn-"));
    git(repo, "init", "-q");
    try {
      const { notes, sink } = fakeNotes();
      const made = runPlaces(home, sink).sessionPlace(repo, step);
      assert.ok("reason" in made);
      const dir = join(home.worktrees, EDIT);
      assert.deepEqual(notes, [
        { step: dir, exists: true, there: false },
        { step: dir, exists: false, there: false },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("keeps the name and the folder a crash left behind, so a resume and gc still find it", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const dir = join(home.worktrees, EDIT);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "left.txt"), "left by a crash\n");
      const { notes, sink } = fakeNotes();
      const made = runPlaces(home, sink).sessionPlace(repo, step);
      assert.ok("tree" in made);
      assert.equal(readFileSync(join(dir, "left.txt"), "utf8"), "left by a crash\n");
      assert.deepEqual(notes, [{ step: dir, exists: true, there: true }]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("keeps the name when git cannot remove the worktree", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      // A folder git does not know as a worktree: the removal fails and the folder stays.
      const tree = { dir: join(home.worktrees, EDIT), branch: `sous/${EDIT}` };
      mkdirSync(tree.dir, { recursive: true });
      const { notes, sink } = fakeNotes();
      const closed = runPlaces(home, sink).closePlace(repo, tree, "Edit it");
      assert.ok("reason" in closed);
      assert.ok(existsSync(tree.dir));
      assert.deepEqual(notes, []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("names a nested run, then its place with the branch, before making the place", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const { notes, sink } = fakeNotes();
      const places = runPlaces(home, sink);
      places.noteNested("run-9-nested1", { parent: "run-9", workflow: "child", label: "ticket" });
      const tree = places.nestedPlace("run-9-nested1", "worktree", repo);
      const scratch = places.nestedPlace("run-9-nested2", "none", repo);
      const folder = places.nestedPlace("run-9-nested3", "folder", repo);
      assert.equal(tree, join(home.worktrees, "run-9-nested1"));
      assert.equal(scratch, join(home.scratch, "run-9-nested2"));
      assert.equal(folder, repo);
      assert.ok(existsSync(tree) && existsSync(scratch));
      assert.deepEqual(notes, [
        { nested: "run-9-nested1", change: { parent: "run-9", workflow: "child", label: "ticket" } },
        { nested: "run-9-nested1", change: { cwd: tree, branch: "sous/run-9-nested1" }, there: false },
        { nested: "run-9-nested2", change: { cwd: scratch }, there: false },
        { nested: "run-9-nested3", change: { cwd: repo }, there: true },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });
});

describe("the end of a run, and gc", () => {
  it("gc keeps a crashed step's worktree while its run is unfinished, the run's end closes it, and gc removes the merged branch", async () => {
    const { paths, projectDir } = setup({
      look: `export const meta = { name: 'look', description: 'reads only' }\nreturn await agent('look', { label: 'reader' })`,
    });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const record = createRun(paths, { who: PERSON, workflow: "look", projectDir, inputs: {}, place: "folder" });
    // A step that made its worktree and committed in it, then its worker died.
    const made = placesIn(paths, record.runId).sessionPlace(projectDir, { runId: record.runId, label: "fixer", step: { prompt: "fix", occurrence: 1 } });
    assert.ok("tree" in made);
    const { tree } = made;
    writeFileSync(join(tree.dir, "fix.txt"), "fixed\n");
    git(tree.dir, "add", "fix.txt");
    git(tree.dir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "fix");
    git(projectDir, "merge", "-q", tree.branch);
    const gc = () => gcWorktrees(paths, [projectDir], { busy: busyWorktrees(paths) });

    const before = gc();
    assert.deepEqual(before.removed, []);
    assert.deepEqual(before.kept.map((k) => [k.branch, k.reason]), [[tree.branch, "its run has not finished"]]);
    assert.ok(existsSync(tree.dir));

    const { runner } = heldRunner(() => "ok");
    assert.equal((await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: () => {} }))?.status, "completed");
    assert.equal(existsSync(tree.dir), false, "the run's end removes the folder");
    assert.equal(git(projectDir, "log", "-1", "--format=%s", tree.branch), "fix", "and keeps the branch, with nothing left to commit");

    // The run ended and the branch is merged, so gc removes it. It has no folder, so its dir is empty.
    const dry = gcWorktrees(paths, [projectDir], { dryRun: true, busy: busyWorktrees(paths) });
    assert.deepEqual(dry, { removed: [{ dir: "", branch: tree.branch, reason: "merged" }], kept: [] });
    assert.notEqual(git(projectDir, "branch", "--list", tree.branch), "", "a dry run removes nothing");
    assert.deepEqual(gc().removed, [{ dir: "", branch: tree.branch, reason: "merged" }]);
    assert.equal(git(projectDir, "branch", "--list", tree.branch), "");
  });

  it("gc keeps a branch with no folder that is not merged, or whose run is unfinished", async () => {
    const { paths, projectDir } = setup({
      look: `export const meta = { name: 'look', description: 'reads only' }\nreturn await agent('look', { label: 'reader' })`,
    });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const record = createRun(paths, { who: PERSON, workflow: "look", projectDir, inputs: {}, place: "folder" });
    const places = placesIn(paths, record.runId);
    const made = places.sessionPlace(projectDir, { runId: record.runId, label: "fixer" });
    assert.ok("tree" in made);
    writeFileSync(join(made.tree.dir, "fix.txt"), "fixed\n");
    assert.deepEqual(places.closePlace(projectDir, made.tree, "fixer"), { committed: true, branchKept: true });
    const gc = () => gcWorktrees(paths, [projectDir], { busy: busyWorktrees(paths) });

    assert.deepEqual(gc().kept, [{ dir: "", branch: made.tree.branch, reason: "its run has not finished" }]);
    const { runner } = heldRunner(() => "ok");
    await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: () => {} });
    assert.deepEqual(gc().kept, [{ dir: "", branch: made.tree.branch, reason: "not merged" }]);
    assert.notEqual(git(projectDir, "branch", "--list", made.tree.branch), "");
  });

  it("the run's end commits the work left in its worktrees, keeps their branches, and logs each", async () => {
    const { paths, projectDir } = setup({
      look: `export const meta = { name: 'look', description: 'reads only' }\nreturn await agent('look', { label: 'reader' })`,
    });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const record = createRun(paths, { who: PERSON, workflow: "look", projectDir, inputs: {}, place: "worktree" });
    // A session whose workflow failed left its worktree, with work in it.
    const made = placesIn(paths, record.runId).sessionPlace(record.cwd, { runId: record.runId, label: "fixer" });
    assert.ok("tree" in made);
    writeFileSync(join(made.tree.dir, "fix.txt"), "fixed\n");
    const lines: string[] = [];
    const { runner } = heldRunner(() => {
      writeFileSync(join(record.cwd, "look.txt"), "looked\n");
      return "ok";
    });
    assert.equal((await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) }))?.status, "completed");

    const run = { dir: record.worktree!, branch: record.branch! };
    for (const [tree, label] of [[made.tree, "fixer"], [run, "look"]] as const) {
      assert.equal(existsSync(tree.dir), false, `the folder of ${label} goes`);
      assert.equal(git(projectDir, "log", "-1", "--format=%s", tree.branch), `sous: uncommitted work of ${label}`);
    }
    assert.equal(git(projectDir, "show", `${record.branch}:look.txt`), "looked");
    // A session's worktree closes before the run's own.
    assert.deepEqual(
      lines.filter((line) => line.startsWith("closed")),
      [made.tree, run].map((tree) => `closed     ${tree.dir}, with its uncommitted work committed. Its work is on ${tree.branch}`),
    );
  });

  it("a failed run keeps its folders for its resume", async () => {
    const { paths, projectDir } = setup({
      broken: `export const meta = { name: 'broken', description: 'fails' }\nawait agent('look', { label: 'reader' })\nthrow new Error('broken on purpose')`,
    });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const record = createRun(paths, { who: PERSON, workflow: "broken", projectDir, inputs: {}, place: "worktree" });
    const { runner } = heldRunner(() => "ok");
    assert.equal((await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: () => {} }))?.status, "failed");
    assert.ok(existsSync(record.worktree!));
  });

  it("the run's end removes a worktree that changed no file, with its branch", async () => {
    const { paths, projectDir } = setup({
      look: `export const meta = { name: 'look', description: 'reads only' }\nreturn await agent('look', { label: 'reader' })`,
    });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const record = createRun(paths, { who: PERSON, workflow: "look", projectDir, inputs: {}, place: "folder" });
    const made = placesIn(paths, record.runId).sessionPlace(projectDir, { runId: record.runId, label: "fixer", step: { prompt: "fix", occurrence: 1 } });
    assert.ok("tree" in made);
    const lines: string[] = [];
    const { runner } = heldRunner(() => "ok");
    await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });
    assert.equal(existsSync(made.tree.dir), false);
    assert.equal(git(projectDir, "branch", "--list", made.tree.branch), "");
    assert.ok(lines.includes(`removed    ${made.tree.dir} and ${made.tree.branch}, which changed no file`), lines.join("\n"));
  });
});

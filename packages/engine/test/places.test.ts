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
import { placesIn } from "./helpers/places.js";
import { heldRunner, setup, until } from "./runs/fixture.js";
import { git, initGitRepo } from "./helpers/git.js";

// A step with `isolation: "worktree"` gets its worktree from the places module, named like every
// other worktree sous makes: a folder under the home's worktrees folder, on branch sous/<name>.

const gitRepo = () => initGitRepo(mkdtempSync(join(tmpdir(), "sous-places-repo-")));

function tempHome(): HomePaths {
  return ensureHome(homePaths(mkdtempSync(join(tmpdir(), "sous-places-home-"))));
}

const step = { runId: "run-9", index: 0, label: "Edit it" };

describe("a step's worktree", () => {
  it("is made under the home's worktrees folder on branch sous/<name>, then removed with its branch", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const made = placesIn(home, "run-9").makeStepWorktree(repo, step);
      assert.ok("tree" in made, "a worktree was made");
      const { tree } = made;
      assert.equal(tree.dir, join(home.worktrees, "run-9-0-edit-it"));
      assert.equal(tree.branch, "sous/run-9-0-edit-it");
      assert.ok(existsSync(join(tree.dir, "file.txt")), "the worktree has a checkout");
      assert.equal(git(tree.dir, "branch", "--show-current"), tree.branch);

      // An edit in the worktree leaves the project alone.
      writeFileSync(join(tree.dir, "file.txt"), "changed in worktree\n");
      assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");

      placesIn(home, "run-9").removeStepWorktree(repo, tree);
      assert.equal(existsSync(tree.dir), false, "worktree folder removed");
      assert.equal(git(repo, "branch", "--list", tree.branch), "", "branch deleted");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("is not made when its branch already exists, and the step gets git's reason", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      git(repo, "branch", "sous/run-9-0-edit-it");
      const made = placesIn(home, "run-9").makeStepWorktree(repo, step);
      assert.ok("reason" in made);
      assert.match(made.reason, /already exists/i);
      assert.equal(existsSync(join(home.worktrees, "run-9-0-edit-it")), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("removing it does not throw when git fails on broken worktree metadata", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const made = placesIn(home, "run-9").makeStepWorktree(repo, step);
      assert.ok("tree" in made);
      rmSync(made.tree.dir, { recursive: true, force: true });
      const meta = join(repo, ".git", "worktrees", "run-9-0-edit-it");
      assert.ok(existsSync(meta), "git keeps the worktree's metadata after its folder is removed");
      writeFileSync(join(meta, "gitdir"), "/nonexistent/path\n");
      assert.doesNotThrow(() => placesIn(home, "run-9").removeStepWorktree(repo, made.tree));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("a step with isolation worktree works in one from places, and it is gone after the step", async () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const seen: Array<{ cwd: string; branch: string }> = [];
      const script = `export const meta = { name: 'iso', description: 'isolated step' }
await agent('edit', { label: 'editor', isolation: 'worktree' })
return {}`;
      await runWorkflow(script, {
        cwd: repo,
        runId: "iso-run",
        places: placesIn(home, "iso-run"),
        persistLogs: false,
        agent: {
          async run(_prompt, options) {
            const cwd = String(options?.cwd);
            seen.push({ cwd, branch: git(cwd, "branch", "--show-current") });
            return "ok";
          },
        },
      });
      const dir = join(home.worktrees, "iso-run-0-editor");
      assert.deepEqual(seen, [{ cwd: dir, branch: "sous/iso-run-0-editor" }]);
      assert.equal(existsSync(dir), false, "the worktree is gone after the step");
      assert.equal(git(repo, "branch", "--list", "sous/iso-run-0-editor"), "", "and its branch");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("a step with isolation worktree outside a git repository works in the run's folder, and the log says why", async () => {
    const home = tempHome();
    const dir = mkdtempSync(join(tmpdir(), "sous-places-nogit-"));
    try {
      const seen: string[] = [];
      const logs: string[] = [];
      await runWorkflow(`export const meta = { name: 'iso', description: 'isolated step' }
await agent('edit', { label: 'editor', isolation: 'worktree' })
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
      assert.ok(logs.includes(`isolation ignored for "editor" (not a git repository)`), logs.join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("a step with isolation worktree and no places works in the run's folder, and the log says why", async () => {
    const repo = gitRepo();
    try {
      const seen: string[] = [];
      const logs: string[] = [];
      await runWorkflow(`export const meta = { name: 'iso', description: 'isolated step' }
await agent('edit', { label: 'editor', isolation: 'worktree' })
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
      assert.ok(logs.includes(`isolation ignored for "editor" (no home for worktrees)`), logs.join("\n"));
      assert.equal(git(repo, "branch", "--list", "sous/*"), "", "no branch was made");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the run's record names it while the step runs, and drops it after", async () => {
    const { paths, projectDir } = setup({
      iso: `export const meta = { name: 'iso', description: 'isolated step' }
return await agent('edit', { label: 'editor', isolation: 'worktree' })`,
    });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const { runner, calls, release } = heldRunner(() => "wait");
    const record = createRun(paths, { workflow: "iso", projectDir, inputs: {}, place: "folder" });
    const worker = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: () => {} });
    await until(() => calls.length === 1);
    const tree = { dir: join(paths.worktrees, `${record.runId}-0-editor`), branch: `sous/${record.runId}-0-editor` };
    assert.deepEqual(loadRecord(paths, record.runId)?.stepWorktrees, [tree]);
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
return await agent('edit', { label: 'editor', isolation: 'worktree' })`,
    });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const { runner, calls, release } = heldRunner(() => "wait");
    const record = createRun(paths, { workflow: "iso", projectDir, inputs: {}, place: "folder" });
    const paused = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: () => {} });
    assert.equal(paused?.status, "paused");
    const [question] = runQuestions(paths, record.runId);
    assert.ok(question);
    answerQuestion(paths, question, { via: "answer", text: "yes" });
    updateRecord(paths, record.runId, { timeout: undefined });

    const worker = runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: () => {} });
    await until(() => calls.length === 1);
    const name = `${record.runId}-${question.callIndex + 1}-editor`;
    const tree = { dir: join(paths.worktrees, name), branch: `sous/${name}` };
    assert.deepEqual(loadRecord(paths, record.runId)?.stepWorktrees, [tree]);
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
  it("names a step's worktree before making it, and drops the name once its folder is gone", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const { notes, sink } = fakeNotes();
      const places = runPlaces(home, sink);
      const made = places.makeStepWorktree(repo, step);
      assert.ok("tree" in made);
      const dir = join(home.worktrees, "run-9-0-edit-it");
      assert.deepEqual(notes, [{ step: dir, exists: true, there: false }]);
      places.removeStepWorktree(repo, made.tree);
      assert.deepEqual(notes, [
        { step: dir, exists: true, there: false },
        { step: dir, exists: false, there: false },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("drops the name when git refuses the worktree", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      git(repo, "branch", "sous/run-9-0-edit-it");
      const { notes, sink } = fakeNotes();
      const made = runPlaces(home, sink).makeStepWorktree(repo, step);
      assert.ok("reason" in made);
      const dir = join(home.worktrees, "run-9-0-edit-it");
      assert.deepEqual(notes, [
        { step: dir, exists: true, there: false },
        { step: dir, exists: false, there: false },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("keeps the name when a crash left the folder behind, so gc still finds it", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const dir = join(home.worktrees, "run-9-0-edit-it");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "left.txt"), "left by a crash\n");
      const { notes, sink } = fakeNotes();
      const made = runPlaces(home, sink).makeStepWorktree(repo, step);
      assert.ok("reason" in made);
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
      const tree = { dir: join(home.worktrees, "run-9-0-edit-it"), branch: "sous/run-9-0-edit-it" };
      mkdirSync(tree.dir, { recursive: true });
      const { notes, sink } = fakeNotes();
      runPlaces(home, sink).removeStepWorktree(repo, tree);
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

describe("gc and a step's worktree a crash left behind", () => {
  it("keeps it while its run is unfinished, and removes it once the run ended and its branch is merged", async () => {
    const { paths, projectDir } = setup({
      look: `export const meta = { name: 'look', description: 'reads only' }\nreturn await agent('look', { label: 'reader' })`,
    });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const record = createRun(paths, { workflow: "look", projectDir, inputs: {}, place: "folder" });
    // A step that made its worktree and committed in it, then its worker died.
    const made = placesIn(paths, record.runId).makeStepWorktree(projectDir, { runId: record.runId, index: 3, label: "fixer" });
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
    assert.ok(existsSync(tree.dir), "the run's own cleanup keeps a worktree with work in it");

    const after = gc();
    assert.deepEqual(after.removed.map((r) => [r.branch, r.reason]), [[tree.branch, "merged"]]);
    assert.equal(existsSync(tree.dir), false);
    assert.equal(git(projectDir, "branch", "--list", tree.branch), "");
  });

  it("the run's own cleanup removes a leftover that changed no file", async () => {
    const { paths, projectDir } = setup({
      look: `export const meta = { name: 'look', description: 'reads only' }\nreturn await agent('look', { label: 'reader' })`,
    });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const record = createRun(paths, { workflow: "look", projectDir, inputs: {}, place: "folder" });
    const made = placesIn(paths, record.runId).makeStepWorktree(projectDir, { runId: record.runId, index: 3, label: "fixer" });
    assert.ok("tree" in made);
    const lines: string[] = [];
    const { runner } = heldRunner(() => "ok");
    await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });
    assert.equal(existsSync(made.tree.dir), false);
    assert.ok(lines.includes(`removed    ${made.tree.dir}, which changed no file`), lines.join("\n"));
  });
});

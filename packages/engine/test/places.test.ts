import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gcWorktrees, makeStepWorktree, removeStepWorktree } from "../src/places/places.js";
import { ensureHome, homePaths, type HomePaths } from "../src/runs/home.js";
import { createRun } from "../src/runs/launch.js";
import { listRecords, loadRecord } from "../src/runs/records.js";
import { busyWorktrees } from "../src/runs/service.js";
import { runWorker } from "../src/runs/worker.js";
import { runWorkflow } from "../src/workflow.js";
import { heldRunner, setup, until } from "./runs/fixture.js";

// A step with `isolation: "worktree"` gets its worktree from the places module, named like every
// other worktree orc makes: a folder under the home's worktrees folder, on branch orc/<name>.

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "orc-places-repo-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return repo;
}

function tempHome(): HomePaths {
  return ensureHome(homePaths(mkdtempSync(join(tmpdir(), "orc-places-home-"))));
}

const step = { runId: "run-9", index: 0, label: "Edit it" };

describe("a step's worktree", () => {
  it("is not made outside a git repository, and the step gets the reason", () => {
    const home = tempHome();
    const dir = mkdtempSync(join(tmpdir(), "orc-places-nogit-"));
    try {
      const made = makeStepWorktree(home, "run-9", dir, step);
      assert.deepEqual(made, { reason: "not a git repository" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("is made under the home's worktrees folder on branch orc/<name>, then removed with its branch", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const made = makeStepWorktree(home, "run-9", repo, step);
      assert.ok("tree" in made, "a worktree was made");
      const { tree } = made;
      assert.equal(tree.dir, join(home.worktrees, "run-9-0-edit-it"));
      assert.equal(tree.branch, "orc/run-9-0-edit-it");
      assert.ok(existsSync(join(tree.dir, "file.txt")), "the worktree has a checkout");
      assert.equal(git(tree.dir, "branch", "--show-current"), tree.branch);

      // An edit in the worktree leaves the project alone.
      writeFileSync(join(tree.dir, "file.txt"), "changed in worktree\n");
      assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");

      removeStepWorktree(home, "run-9", repo, tree);
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
      git(repo, "branch", "orc/run-9-0-edit-it");
      const made = makeStepWorktree(home, "run-9", repo, step);
      assert.ok("reason" in made);
      assert.match(made.reason, /already exists/i);
      assert.equal(existsSync(join(home.worktrees, "run-9-0-edit-it")), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("removing it does not throw when its folder is already gone", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const made = makeStepWorktree(home, "run-9", repo, step);
      assert.ok("tree" in made);
      rmSync(made.tree.dir, { recursive: true, force: true });
      assert.doesNotThrow(() => removeStepWorktree(home, "run-9", repo, made.tree));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("removing it does not throw when git fails on broken worktree metadata", () => {
    const home = tempHome();
    const repo = gitRepo();
    try {
      const made = makeStepWorktree(home, "run-9", repo, step);
      assert.ok("tree" in made);
      rmSync(made.tree.dir, { recursive: true, force: true });
      const meta = join(repo, ".git", "worktrees", "run-9-0-edit-it");
      if (existsSync(meta)) writeFileSync(join(meta, "gitdir"), "/nonexistent/path\n");
      assert.doesNotThrow(() => removeStepWorktree(home, "run-9", repo, made.tree));
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
        home,
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
      assert.deepEqual(seen, [{ cwd: dir, branch: "orc/iso-run-0-editor" }]);
      assert.equal(existsSync(dir), false, "the worktree is gone after the step");
      assert.equal(git(repo, "branch", "--list", "orc/iso-run-0-editor"), "", "and its branch");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("a step with isolation worktree outside a git repository works in the run's folder, and the log says why", async () => {
    const home = tempHome();
    const dir = mkdtempSync(join(tmpdir(), "orc-places-nogit-"));
    try {
      const seen: string[] = [];
      const logs: string[] = [];
      await runWorkflow(`export const meta = { name: 'iso', description: 'isolated step' }
await agent('edit', { label: 'editor', isolation: 'worktree' })
return {}`, {
        cwd: dir,
        runId: "iso-run",
        home,
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
    const tree = { dir: join(paths.worktrees, `${record.runId}-0-editor`), branch: `orc/${record.runId}-0-editor` };
    assert.deepEqual(loadRecord(paths, record.runId)?.stepWorktrees, [tree]);
    assert.ok(existsSync(tree.dir));
    release("editor");
    assert.equal((await worker)?.status, "completed");
    assert.deepEqual(loadRecord(paths, record.runId)?.stepWorktrees, []);
    assert.equal(existsSync(tree.dir), false);
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
    const made = makeStepWorktree(paths, record.runId, projectDir, { runId: record.runId, index: 3, label: "fixer" });
    assert.ok("tree" in made);
    const { tree } = made;
    writeFileSync(join(tree.dir, "fix.txt"), "fixed\n");
    git(tree.dir, "add", "fix.txt");
    git(tree.dir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "fix");
    git(projectDir, "merge", "-q", tree.branch);
    const gc = () => gcWorktrees(paths, [projectDir], { busy: busyWorktrees(paths, listRecords(paths)) });

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
    const made = makeStepWorktree(paths, record.runId, projectDir, { runId: record.runId, index: 3, label: "fixer" });
    assert.ok("tree" in made);
    const lines: string[] = [];
    const { runner } = heldRunner(() => "ok");
    await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });
    assert.equal(existsSync(made.tree.dir), false);
    assert.ok(lines.includes(`removed    ${made.tree.dir}, which changed no file`), lines.join("\n"));
  });
});

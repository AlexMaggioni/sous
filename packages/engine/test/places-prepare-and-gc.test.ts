// The place a run gets, made from nothing, and the worktrees gc leaves for a project it did not look at.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { gcWorktrees, preparePlace } from "../src/places/places.js";
import { ensureHome, homePaths } from "../src/runs/home.js";
import { placesIn } from "./helpers/places.js";
import { git, initGitRepo } from "./helpers/git.js";

const made: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gitRepo = () => initGitRepo(temp("sous-places-gc-repo-"));

describe("preparePlace", () => {
  it("makes the scratch folder of a run, and the scratch folder above it, on a home that has neither", () => {
    const paths = homePaths(temp("sous-places-fresh-home-"));
    assert.equal(existsSync(paths.scratch), false, "the home starts without a scratch folder");
    const placed = preparePlace(paths, "none", "run-1", temp("sous-places-base-"));
    assert.equal(placed.cwd, join(paths.scratch, "run-1"));
    assert.ok(statSync(placed.cwd).isDirectory());
  });

  it("returns the same scratch folder for the same run, and keeps what is in it", () => {
    const paths = homePaths(temp("sous-places-fresh-home-"));
    const baseDir = temp("sous-places-base-");
    const first = preparePlace(paths, "none", "run-1", baseDir);
    writeFileSync(join(first.cwd, "note.txt"), "kept\n");
    const second = preparePlace(paths, "none", "run-1", baseDir);
    assert.equal(second.cwd, first.cwd);
    assert.equal(readFileSync(join(second.cwd, "note.txt"), "utf8"), "kept\n");
  });

  it("makes nothing for a run in the project's own folder", () => {
    const paths = homePaths(temp("sous-places-fresh-home-"));
    const baseDir = temp("sous-places-base-");
    assert.deepEqual(preparePlace(paths, "folder", "run-1", baseDir), { cwd: baseDir });
    assert.equal(existsSync(paths.scratch), false);
    assert.equal(existsSync(paths.worktrees), false);
  });

  it("makes a worktree of the project on branch sous/<run> for a worktree place, and finds it again", () => {
    const paths = homePaths(temp("sous-places-fresh-home-"));
    const repo = gitRepo();
    const first = preparePlace(paths, "worktree", "run-1", repo);
    assert.deepEqual(first, { cwd: join(paths.worktrees, "run-1"), worktree: join(paths.worktrees, "run-1"), branch: "sous/run-1" });
    assert.equal(git(first.cwd, "branch", "--show-current"), "sous/run-1");
    assert.deepEqual(preparePlace(paths, "worktree", "run-1", repo), first);
  });
});

describe("gc of worktrees of a project it was not told to check", () => {
  /** A home with a worktree of each of two projects, both merged into their main branch. */
  function twoProjects() {
    const home = ensureHome(homePaths(temp("sous-places-gc-home-")));
    const checked = gitRepo();
    const unchecked = gitRepo();
    const place = (repo: string, occurrence: number) => {
      const result = placesIn(home, "run-9").sessionPlace(repo, { runId: "run-9", label: "edit", occurrence });
      assert.ok("tree" in result, "a worktree was made");
      return result.tree;
    };
    return { home, checked, unchecked, checkedTree: place(checked, 1), uncheckedTree: place(unchecked, 2) };
  }

  it("keeps the worktree, with no branch and the reason that its project was not checked", () => {
    const { home, checked, uncheckedTree, checkedTree } = twoProjects();
    const result = gcWorktrees(home, [checked], { busy: new Set() });
    assert.deepEqual(result.kept, [{ dir: uncheckedTree.dir, branch: "", reason: "its project was not checked" }]);
    assert.deepEqual(result.removed.map((r) => [r.branch, r.reason]), [[checkedTree.branch, "merged"]]);
    assert.ok(existsSync(uncheckedTree.dir), "the other project's worktree stays");
  });

  it("keeps the worktree when no project is given at all", () => {
    const { home, checkedTree, uncheckedTree } = twoProjects();
    const result = gcWorktrees(home, [], { busy: new Set() });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.kept.map((k) => [k.dir, k.reason]).sort(), [
      [checkedTree.dir, "its project was not checked"],
      [uncheckedTree.dir, "its project was not checked"],
    ].sort());
  });

  it("lists each worktree once, with a dry run too", () => {
    const { home, checked, checkedTree, uncheckedTree } = twoProjects();
    const result = gcWorktrees(home, [checked], { dryRun: true, busy: new Set() });
    const listed = [...result.removed, ...result.kept].map((entry) => entry.dir);
    assert.equal(new Set(listed).size, listed.length, listed.join("\n"));
    assert.deepEqual(result.removed.map((r) => r.branch), [checkedTree.branch]);
    assert.deepEqual(result.kept.map((k) => k.dir), [uncheckedTree.dir]);
    assert.ok(existsSync(checkedTree.dir), "a dry run removes nothing");
  });
});

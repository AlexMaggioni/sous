import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { closeRunWorktrees, NO_PLACES, runPlaces, type PlaceNotes, type Worktree } from "../src/places/places.js";
import { ensureHome, homePaths, type HomePaths } from "../src/runs/home.js";
import type { RunRecord } from "../src/runs/records.js";
import { git, initGitRepo } from "./helpers/git.js";

// The worktree of a session, or of one step, with place "worktree". It is named for its run and
// its label, so a resumed run finds the same one. When its scope ends, sous commits what is left
// uncommitted, removes the folder, keeps the branch, and deletes a branch that never moved.

const LEFTOVER = "sous: uncommitted work of implementer";

interface World {
  home: HomePaths;
  repo: string;
  /** Each note, in order: the worktree's folder and whether sous should keep it named. */
  notes: Array<[string, boolean]>;
  places: ReturnType<typeof runPlaces>;
}

function world(t: TestContext): World {
  const home = ensureHome(homePaths(mkdtempSync(join(tmpdir(), "sous-session-place-home-"))));
  const repo = initGitRepo(mkdtempSync(join(tmpdir(), "sous-session-place-repo-")));
  const notes: Array<[string, boolean]> = [];
  const recorder: PlaceNotes = {
    nested: () => {},
    stepWorktree: (tree, keep) => {
      notes.push([tree.dir, keep]);
    },
  };
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home.home, { recursive: true, force: true });
  });
  return { home, repo, notes, places: runPlaces(home, recorder) };
}

function made(result: { tree: Worktree } | { reason: string }): Worktree {
  assert.ok("tree" in result, `a worktree was made: ${JSON.stringify(result)}`);
  return result.tree;
}

const hash6 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 6);
const branchExists = (repo: string, branch: string) => git(repo, "branch", "--list", branch) !== "";
const lastMessage = (repo: string, branch: string) => git(repo, "log", "-1", "--format=%s", branch);

describe("a session's worktree", () => {
  it("is named for its run and label with a short hash, starts from the folder's HEAD, and is noted before it is made", (t) => {
    const w = world(t);
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "Implementer" }));
    const name = `run-9-implementer-${hash6("run-9\nImplementer")}`;
    assert.equal(tree.dir, join(w.home.worktrees, name));
    assert.equal(tree.branch, `sous/${name}`);
    assert.equal(git(tree.dir, "branch", "--show-current"), tree.branch);
    assert.equal(git(tree.dir, "rev-parse", "HEAD"), git(w.repo, "rev-parse", "HEAD"));
    assert.deepEqual(w.notes, [[tree.dir, true]]);
  });

  it("keeps two labels apart when their slugs match", (t) => {
    const w = world(t);
    const one = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "Fix A!" }));
    const two = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "fix a" }));
    assert.notEqual(one.dir, two.dir);
    assert.ok(one.dir.includes("run-9-fix-a-") && two.dir.includes("run-9-fix-a-"));
  });

  it("of one step ends in the call's occurrence", (t) => {
    const w = world(t);
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "Edit it", occurrence: 2 }));
    assert.equal(tree.dir, join(w.home.worktrees, "run-9-edit-it-2"));
  });

  it("starts from the HEAD of the folder around it, a worktree included", (t) => {
    const w = world(t);
    const outer = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "outer" }));
    writeFileSync(join(outer.dir, "outer.txt"), "outer\n");
    git(outer.dir, "add", ".");
    git(outer.dir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "outer work");
    const inner = made(w.places.sessionPlace(outer.dir, { runId: "run-9", label: "inner" }));
    assert.equal(readFileSync(join(inner.dir, "outer.txt"), "utf8"), "outer\n");
  });

  it("is found again by a resumed run, folder and work included", (t) => {
    const w = world(t);
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));
    writeFileSync(join(tree.dir, "draft.txt"), "half done\n");
    const again = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));
    assert.deepEqual(again, tree);
    assert.equal(readFileSync(join(again.dir, "draft.txt"), "utf8"), "half done\n", "the folder was kept as it was");
  });

  it("is made again from its branch when the folder is gone and the branch stays", (t) => {
    const w = world(t);
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));
    writeFileSync(join(tree.dir, "work.txt"), "work\n");
    const closed = w.places.closePlace(w.repo, tree, "implementer");
    assert.deepEqual(closed, { committed: true, branchKept: true });
    assert.equal(existsSync(tree.dir), false);

    const again = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));
    assert.deepEqual(again, tree);
    assert.equal(readFileSync(join(again.dir, "work.txt"), "utf8"), "work\n");
  });

  it("gives the reason when the folder is not a git repository, or the run has no home", (t) => {
    const w = world(t);
    const plain = mkdtempSync(join(tmpdir(), "sous-session-place-plain-"));
    t.after(() => rmSync(plain, { recursive: true, force: true }));
    assert.deepEqual(w.places.sessionPlace(plain, { runId: "run-9", label: "implementer" }), { reason: "not a git repository" });
    assert.deepEqual(NO_PLACES.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }), { reason: "no home for worktrees" });
    assert.deepEqual(w.notes, []);
  });
});

describe("when a place's scope ends", () => {
  it("sous commits the leftover work, removes the folder and keeps the branch and its note", (t) => {
    const w = world(t);
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));
    writeFileSync(join(tree.dir, "file.txt"), "changed\n");
    writeFileSync(join(tree.dir, "new.txt"), "new\n");

    assert.deepEqual(w.places.closePlace(w.repo, tree, "implementer"), { committed: true, branchKept: true });
    assert.equal(existsSync(tree.dir), false, "the folder goes");
    assert.ok(branchExists(w.repo, tree.branch), "the branch stays");
    assert.equal(lastMessage(w.repo, tree.branch), LEFTOVER);
    assert.equal(git(w.repo, "show", `${tree.branch}:new.txt`), "new");
    assert.equal(git(w.repo, "show", `${tree.branch}:file.txt`), "changed");
    assert.equal(readFileSync(join(w.repo, "file.txt"), "utf8"), "base\n", "the project is untouched");
    assert.deepEqual(w.notes.at(-1), [tree.dir, true], "the note stays while the branch does");
  });

  it("a branch the agent committed on stays, with no commit of sous's", (t) => {
    const w = world(t);
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));
    writeFileSync(join(tree.dir, "file.txt"), "committed\n");
    git(tree.dir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-am", "the agent's commit");

    assert.deepEqual(w.places.closePlace(w.repo, tree, "implementer"), { committed: false, branchKept: true });
    assert.equal(existsSync(tree.dir), false);
    assert.equal(lastMessage(w.repo, tree.branch), "the agent's commit");
  });

  it("a branch that never moved is deleted with its folder, and its note goes", (t) => {
    const w = world(t);
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));

    assert.deepEqual(w.places.closePlace(w.repo, tree, "implementer"), { committed: false, branchKept: false });
    assert.equal(existsSync(tree.dir), false);
    assert.equal(branchExists(w.repo, tree.branch), false);
    assert.deepEqual(w.notes, [
      [tree.dir, true],
      [tree.dir, false],
    ]);
  });

  it("the commit skips the project's hooks", (t) => {
    const w = world(t);
    // Hooks live in the repository and hold for every worktree of it.
    writeFileSync(join(w.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));
    writeFileSync(join(tree.dir, "file.txt"), "changed\n");

    assert.deepEqual(w.places.closePlace(w.repo, tree, "implementer"), { committed: true, branchKept: true });
    assert.equal(lastMessage(w.repo, tree.branch), LEFTOVER);
  });

  it("the commit has an author when git has none", (t) => {
    const w = world(t);
    // Git may guess a name from the machine. This makes it use only its config, which has none.
    git(w.repo, "config", "user.useConfigOnly", "true");
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));
    writeFileSync(join(tree.dir, "file.txt"), "changed\n");

    assert.deepEqual(w.places.closePlace(w.repo, tree, "implementer"), { committed: true, branchKept: true });
    assert.equal(git(w.repo, "log", "-1", "--format=%an <%ae>", tree.branch), "sous <sous@localhost>");
  });

  it("the commit keeps git's own author when it has one", (t) => {
    const w = world(t);
    git(w.repo, "config", "user.name", "Pat");
    git(w.repo, "config", "user.email", "pat@example.invalid");
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));
    writeFileSync(join(tree.dir, "file.txt"), "changed\n");

    w.places.closePlace(w.repo, tree, "implementer");
    assert.equal(git(w.repo, "log", "-1", "--format=%an <%ae>", tree.branch), "Pat <pat@example.invalid>");
  });

  it("a commit that fails keeps the folder, its work and its note, and gives the reason", (t) => {
    const w = world(t);
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));
    writeFileSync(join(tree.dir, "file.txt"), "changed\n");
    // Another git process holds the worktree's index.
    const gitDir = git(tree.dir, "rev-parse", "--absolute-git-dir");
    writeFileSync(join(gitDir, "index.lock"), "");

    const closed = w.places.closePlace(w.repo, tree, "implementer");
    assert.ok("reason" in closed && /index\.lock/.test(closed.reason), JSON.stringify(closed));
    assert.equal(readFileSync(join(tree.dir, "file.txt"), "utf8"), "changed\n", "the work is still there");
    assert.deepEqual(w.notes.at(-1), [tree.dir, true]);
  });

  it("the run's end does the same for a worktree its record names, outside the run's places", (t) => {
    const w = world(t);
    const tree = made(w.places.sessionPlace(w.repo, { runId: "run-9", label: "implementer" }));
    writeFileSync(join(tree.dir, "file.txt"), "changed\n");
    const record = { projectDir: w.repo, workflow: "fix", stepWorktrees: [{ ...tree, label: "implementer" }] } as unknown as RunRecord;
    assert.deepEqual(closeRunWorktrees(record), [{ tree, committed: true, branchKept: true }]);
    assert.equal(existsSync(tree.dir), false);
    assert.equal(lastMessage(w.repo, tree.branch), LEFTOVER);
  });
});

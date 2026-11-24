// Where a run works. A worktree (the default) is a new branch sous/<name> in its own folder under
// the home's worktrees folder, kept after the run so the work can be reviewed and merged. A folder
// run works in the project itself. A run with no place gets an empty scratch folder. A nested run
// and a step with `isolation: "worktree"` get their worktrees here too, named the same way, through
// `runPlaces`. A step's worktree goes when the step ends.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HomePaths, Place } from "../runs/home.js";
import type { NestedRun, RunRecord } from "../runs/records.js";

export interface PreparedPlace {
  cwd: string;
  worktree?: string;
  branch?: string;
}

export interface Worktree {
  dir: string;
  branch: string;
}

const PLACES: readonly Place[] = ["worktree", "folder", "none"];

export function isPlace(value: unknown): value is Place {
  return typeof value === "string" && (PLACES as readonly string[]).includes(value);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function isGitRepo(dir: string): boolean {
  try {
    return git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/** The folder and branch of the worktree with this name. Every worktree sous makes is named so. */
function worktreeAt(paths: HomePaths, name: string): Worktree {
  return { dir: join(paths.worktrees, name), branch: `sous/${name}` };
}

/**
 * Make a worktree on a new branch from HEAD. This is the only code that runs `git worktree add`.
 * With `reuseBranch`, a branch that already exists is checked out instead.
 */
function makeWorktree(repoDir: string, tree: Worktree, reuseBranch: boolean): void {
  mkdirSync(dirname(tree.dir), { recursive: true });
  try {
    git(repoDir, ["worktree", "add", "-b", tree.branch, tree.dir, "HEAD"]);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? (error as Error).message);
    if (!reuseBranch || !stderr.includes("already exists")) throw new Error(`could not make a worktree: ${stderr.trim()}`);
    git(repoDir, ["worktree", "add", tree.dir, tree.branch]);
  }
}

/** Where a place is, without making it. */
function planPlace(paths: HomePaths, place: Place, name: string, baseDir: string): PreparedPlace {
  if (place === "folder") return { cwd: baseDir };
  if (place === "none") return { cwd: join(paths.scratch, name) };
  if (!isGitRepo(baseDir)) {
    throw new Error(`a worktree needs a git repository, and ${baseDir} is not one. Run with --place folder or --place none.`);
  }
  const tree = worktreeAt(paths, name);
  return { cwd: tree.dir, worktree: tree.dir, branch: tree.branch };
}

/** Make a planned place. A place that is already there is kept as it is. */
function makePlace(baseDir: string, planned: PreparedPlace): void {
  if (planned.worktree && planned.branch) {
    if (!existsSync(planned.worktree)) makeWorktree(baseDir, { dir: planned.worktree, branch: planned.branch }, true);
  } else if (planned.cwd !== baseDir) {
    mkdirSync(planned.cwd, { recursive: true });
  }
}

/**
 * Make the place for a run. Calling it again for the same run returns the same place, so a
 * resumed run finds its worktree.
 */
export function preparePlace(paths: HomePaths, place: Place, runId: string, baseDir: string): PreparedPlace {
  const planned = planPlace(paths, place, runId, baseDir);
  makePlace(baseDir, planned);
  return planned;
}

/** Lower case letters, digits and dashes, safe in a folder and a branch name. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Where a run tree's places are written down. In sous, the root run's record. */
export interface PlaceNotes {
  nested(childRunId: string, change: Partial<NestedRun>): void;
  stepWorktree(tree: Worktree, exists: boolean): void;
}

/**
 * The places of one run tree: its nested runs' places and its steps' worktrees. The workflow core
 * gets this and knows nothing of the home or the record. Each place is noted before it is made, so
 * no crash leaves a worktree that no note names, and gc can find it.
 */
export interface RunPlaces {
  /** Note a nested run before it starts. */
  noteNested(childRunId: string, run: { parent: string; workflow: string; label?: string }): void;
  /** Make the place a nested run asked for, and return its cwd. */
  nestedPlace(childRunId: string, place: Place, baseDir: string): string;
  /**
   * Make the worktree of a step with `isolation: "worktree"`, named for its run, its call index and
   * its label. Returns the reason when the step cannot have one.
   */
  makeStepWorktree(baseDir: string, step: { runId: string; index: number; label: string }): { tree: Worktree } | { reason: string };
  /** Remove a step's worktree and its branch when the step ends. */
  removeStepWorktree(baseDir: string, tree: Worktree): void;
}

/** The places of one run tree under this home, noted in `notes`. */
export function runPlaces(paths: HomePaths, notes: PlaceNotes): RunPlaces {
  return {
    noteNested: (childRunId, run) => notes.nested(childRunId, run),

    // Calling it again for the same child returns the same place, so a resumed run finds its worktree.
    nestedPlace(childRunId, place, baseDir) {
      const planned = planPlace(paths, place, childRunId, baseDir);
      notes.nested(childRunId, { cwd: planned.cwd, ...(planned.branch ? { branch: planned.branch } : {}) });
      makePlace(baseDir, planned);
      return planned.cwd;
    },

    makeStepWorktree(baseDir, step) {
      if (!isGitRepo(baseDir)) return { reason: "not a git repository" };
      const tree = worktreeAt(paths, `${slug(step.runId)}-${step.index}-${slug(step.label).slice(0, 32) || "agent"}`);
      const leftover = existsSync(tree.dir);
      notes.stepWorktree(tree, true);
      try {
        makeWorktree(baseDir, tree, false);
        return { tree };
      } catch (error) {
        // A worktree a crash left behind stays named, for gc.
        if (!leftover) notes.stepWorktree(tree, false);
        return { reason: (error as Error).message };
      }
    },

    // One that stays stays named, for gc.
    removeStepWorktree(baseDir, tree) {
      try {
        removeWorktree(baseDir, tree.dir, tree.branch);
      } catch {
        // Left for gc.
      }
      if (!existsSync(tree.dir)) notes.stepWorktree(tree, false);
    },
  };
}

/**
 * A run with no home: `runWorkflow` called without places. A step works in the run's folder, and a
 * nested run can only work in its parent's folder.
 */
export const NO_PLACES: RunPlaces = {
  noteNested: () => {},
  nestedPlace(_childRunId, place, baseDir) {
    if (place === "folder") return baseDir;
    throw new Error(`place "${place}" needs a home for its folder, and this run has none. Use place "folder".`);
  },
  makeStepWorktree: () => ({ reason: "no home for worktrees" }),
  removeStepWorktree: () => {},
};

/**
 * True when the run in this worktree changed no file: nothing uncommitted, and the branch has not
 * moved since it was made. The branch's reflog has one entry until something commits on it.
 */
function worktreeUnchanged(dir: string, branch: string): boolean {
  try {
    if (git(dir, ["status", "--porcelain"]) !== "") return false;
    const moves = git(dir, ["reflog", "show", "--format=%H", `refs/heads/${branch}`]).split("\n").filter(Boolean);
    return moves.length === 1;
  } catch {
    return false;
  }
}

/** Remove a worktree and its branch. */
export function removeWorktree(repoDir: string, dir: string, branch: string): void {
  if (existsSync(dir)) git(repoDir, ["worktree", "remove", "--force", dir]);
  else git(repoDir, ["worktree", "prune"]);
  git(repoDir, ["branch", "-D", branch]);
}

/**
 * The worktrees a run's record names that are still there: the run's own, unless it borrowed it
 * from the run it reuses, its nested runs' and its steps'.
 */
export function runWorktrees(record: RunRecord): Worktree[] {
  const trees: Worktree[] = [];
  if (record.worktree && record.branch && !record.reuseFrom) trees.push({ dir: record.worktree, branch: record.branch });
  for (const child of Object.values(record.nested ?? {})) {
    if (child.cwd && child.branch) trees.push({ dir: child.cwd, branch: child.branch });
  }
  trees.push(...(record.stepWorktrees ?? []));
  const seen = new Set<string>();
  const kept = trees.filter((tree) => existsSync(tree.dir) && !seen.has(tree.dir) && seen.add(tree.dir));
  return kept.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** At the end of a run, remove the given worktrees that changed no file. */
export function dropUnchangedWorktrees(repoDir: string, trees: Worktree[]): string[] {
  const removed: string[] = [];
  for (const { dir, branch } of trees) {
    if (!worktreeUnchanged(dir, branch)) continue;
    try {
      removeWorktree(repoDir, dir, branch);
      removed.push(dir);
    } catch {
      // Left for `sous gc`.
    }
  }
  return removed;
}

export interface GcResult {
  removed: Array<{ dir: string; branch: string; reason: string }>;
  kept: Array<{ dir: string; branch: string; reason: string }>;
}

/**
 * Remove sous's worktrees whose branch is merged into the project's current branch and has no
 * uncommitted changes. Everything else stays, and so does each worktree in `busy`.
 */
export function gcWorktrees(paths: HomePaths, projectDirs: string[], options: { dryRun?: boolean; busy: Set<string> }): GcResult {
  const result: GcResult = { removed: [], kept: [] };
  if (!existsSync(paths.worktrees)) return result;
  // Git reports real paths, so /var/... on macOS shows as /private/var/....
  const root = realpathSync(paths.worktrees);
  const real = (dir: string) => (existsSync(dir) ? realpathSync(dir) : dir);
  const busy = new Set([...options.busy].map(real));
  const seen = new Set<string>();
  for (const projectDir of projectDirs) {
    if (!isGitRepo(projectDir)) continue;
    let listing: string;
    try {
      listing = git(projectDir, ["worktree", "list", "--porcelain"]);
    } catch {
      continue;
    }
    const entries = listing.split("\n\n").map((block) => {
      const lines = block.split("\n");
      return {
        dir: lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "",
        branch: lines.find((l) => l.startsWith("branch "))?.slice(7).replace("refs/heads/", "") ?? "",
      };
    });
    for (const entry of entries) {
      if (!entry.dir.startsWith(`${root}/`) || seen.has(entry.dir)) continue;
      seen.add(entry.dir);
      if (!existsSync(entry.dir)) {
        if (!options.dryRun) git(projectDir, ["worktree", "prune"]);
        result.removed.push({ ...entry, reason: "folder already gone" });
        continue;
      }
      // A run still going, or paused, keeps its worktrees, even before their first commit.
      if (busy.has(entry.dir)) {
        result.kept.push({ ...entry, reason: "its run has not finished" });
        continue;
      }
      const dirty = git(entry.dir, ["status", "--porcelain"]);
      if (dirty) {
        result.kept.push({ ...entry, reason: "uncommitted changes" });
        continue;
      }
      let merged = false;
      try {
        git(projectDir, ["merge-base", "--is-ancestor", entry.branch, "HEAD"]);
        merged = true;
      } catch {
        merged = false;
      }
      if (!merged) {
        result.kept.push({ ...entry, reason: "not merged" });
        continue;
      }
      if (!options.dryRun) {
        git(projectDir, ["worktree", "remove", entry.dir]);
        git(projectDir, ["branch", "-d", entry.branch]);
      }
      result.removed.push({ ...entry, reason: "merged" });
    }
  }
  for (const name of readdirSync(paths.worktrees)) {
    const dir = join(paths.worktrees, name);
    if (!seen.has(real(dir)) && !result.removed.some((r) => r.dir === real(dir))) result.kept.push({ dir, branch: "", reason: "its project was not checked" });
  }
  return result;
}

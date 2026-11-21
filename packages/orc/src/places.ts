// Where a run works. A worktree (the default) is a new branch orc/<run id> in its own folder,
// kept after the run so the work can be reviewed and merged. A folder run works in the project
// itself. A run with no place gets an empty scratch folder.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { HomePaths, Place } from "./home.js";

export interface PreparedPlace {
  cwd: string;
  worktree?: string;
  branch?: string;
}

export const PLACES: readonly Place[] = ["worktree", "folder", "none"];

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

/**
 * Make the place for a run. Calling it again for the same run returns the same place, so a
 * resumed run and a resumed nested run find their worktree.
 */
export function preparePlace(paths: HomePaths, place: Place, runId: string, baseDir: string): PreparedPlace {
  if (place === "folder") return { cwd: baseDir };
  if (place === "none") {
    const dir = join(paths.scratch, runId);
    mkdirSync(dir, { recursive: true });
    return { cwd: dir };
  }
  if (!isGitRepo(baseDir)) {
    throw new Error(`a worktree needs a git repository, and ${baseDir} is not one. Run with --place folder or --place none.`);
  }
  const dir = join(paths.worktrees, runId);
  const branch = `orc/${runId}`;
  if (existsSync(dir)) return { cwd: dir, worktree: dir, branch };
  mkdirSync(paths.worktrees, { recursive: true });
  try {
    git(baseDir, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? (error as Error).message);
    if (!stderr.includes("already exists")) throw new Error(`could not make a worktree: ${stderr.trim()}`);
    git(baseDir, ["worktree", "add", dir, branch]);
  }
  return { cwd: dir, worktree: dir, branch };
}

/**
 * True when the run in this worktree changed no file: nothing uncommitted, and the branch has not
 * moved since it was made. The branch's reflog has one entry until something commits on it.
 */
export function worktreeUnchanged(dir: string, branch: string): boolean {
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

/** The worktrees of a run and of its nested runs, which orc names `<run id>-nested<n>`. */
export function runWorktrees(paths: HomePaths, runId: string): Array<{ dir: string; branch: string }> {
  if (!existsSync(paths.worktrees)) return [];
  return readdirSync(paths.worktrees)
    .filter((name) => name === runId || name.startsWith(`${runId}-nested`))
    .map((name) => ({ dir: join(paths.worktrees, name), branch: `orc/${name}` }));
}

/** At the end of a run, remove the worktrees of the run and its nested runs that changed no file. */
export function dropUnchangedWorktrees(paths: HomePaths, repoDir: string, runId: string): string[] {
  const removed: string[] = [];
  for (const { dir, branch } of runWorktrees(paths, runId)) {
    if (!worktreeUnchanged(dir, branch)) continue;
    try {
      removeWorktree(repoDir, dir, branch);
      removed.push(dir);
    } catch {
      // Left for `orc gc`.
    }
  }
  return removed;
}

export interface GcResult {
  removed: Array<{ dir: string; branch: string; reason: string }>;
  kept: Array<{ dir: string; branch: string; reason: string }>;
}

/**
 * Remove orc's worktrees whose branch is merged into the project's current branch and has no
 * uncommitted changes. Everything else stays.
 */
export function gcWorktrees(paths: HomePaths, projectDirs: string[], options: { dryRun?: boolean; unfinished?: Set<string> } = {}): GcResult {
  const result: GcResult = { removed: [], kept: [] };
  if (!existsSync(paths.worktrees)) return result;
  // Git reports real paths, so /var/... on macOS shows as /private/var/....
  const root = realpathSync(paths.worktrees);
  const real = (dir: string) => (existsSync(dir) ? realpathSync(dir) : dir);
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
      // A run still going, or paused, keeps its worktree, even before its first commit.
      const topRun = basename(entry.dir).split("-nested")[0]!;
      if (options.unfinished?.has(topRun)) {
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

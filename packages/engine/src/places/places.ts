// Where a run works. A worktree (the default) is a new branch sous/<name> in its own folder under
// the home's worktrees folder. A folder run works in the project itself. A run with no place gets
// an empty scratch folder. A nested run, a session and one step with `place: "worktree"` get their
// worktrees here too, named the same way, through `runPlaces`. When a worktree's scope ends,
// `closeWorktree` commits what is left, removes the folder and keeps the branch for review.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
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

/**
 * Make a planned place. A place that is already there is kept as it is. A worktree whose folder
 * went is made again from its branch, as `sous rerun --reuse` needs.
 */
export function makePlace(baseDir: string, planned: PreparedPlace): void {
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
  /** Name a session's or a step's worktree, with its label, or with `keep` false, forget it. */
  stepWorktree(tree: Worktree & { label?: string }, keep: boolean): void;
}

/** Who a session's or one step's worktree belongs to. */
export interface PlaceOwner {
  runId: string;
  label: string;
  /** For one agent() step: its prompt and its count among the calls with the same label and prompt. */
  step?: { prompt: string; occurrence: number };
}

/** What closing a worktree did: whether sous committed leftover work, and whether the branch stays. */
export interface Closed {
  committed: boolean;
  branchKept: boolean;
}

/**
 * The places of one run tree: its nested runs' places and its sessions' and steps' worktrees. The
 * workflow core gets this and knows nothing of the home or the record. Each place is noted before
 * it is made, so no crash leaves a worktree that no note names, and gc can find it.
 */
export interface RunPlaces {
  /** Note a nested run before it starts. */
  noteNested(childRunId: string, run: { parent: string; workflow: string; label?: string }): void;
  /** Make the place a nested run asked for, and return its cwd. */
  nestedPlace(childRunId: string, place: Place, baseDir: string): string;
  /** End a nested run's worktree when the nested workflow returns, as `closeWorktree` does. */
  closeNested(childRunId: string, baseDir: string, label: string): RunClose;
  /**
   * Make the worktree of a session or of one step with `place: "worktree"`, from the HEAD of
   * `baseDir`. A resumed run gets the same one back: the folder as it is, or a new folder on the
   * branch that stayed. Returns the reason when there can be none.
   */
  sessionPlace(baseDir: string, owner: PlaceOwner): { tree: Worktree } | { reason: string };
  /** End a place's scope, as `closeWorktree` does. A place that could not close stays named. */
  closePlace(baseDir: string, tree: Worktree, label: string): Closed | { reason: string };
}

/** The worktree of a session, `<run>-<label>-<hash>`, or of one step, `<run>-<label>-<hash>-<count>`.
 *  The hash of the run, the label and a step's prompt keeps apart labels whose slugs match, and
 *  steps of one label with different prompts, whatever order a resume calls them in. */
function placeName(owner: PlaceOwner): string {
  const named = owner.step ? `${owner.runId}\n${owner.label}\n${owner.step.prompt}` : `${owner.runId}\n${owner.label}`;
  const hash = createHash("sha256").update(named).digest("hex").slice(0, 6);
  return `${slug(owner.runId)}-${slug(owner.label).slice(0, 32) || "agent"}-${hash}${owner.step ? `-${owner.step.occurrence}` : ""}`;
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

    closeNested(childRunId, baseDir, label) {
      const tree = worktreeAt(paths, childRunId);
      try {
        return { tree, ...closeWorktree(baseDir, tree, label) };
      } catch (error) {
        return { tree, reason: (error as Error).message };
      }
    },

    sessionPlace(baseDir, owner) {
      if (!isGitRepo(baseDir)) return { reason: "not a git repository" };
      const tree = worktreeAt(paths, placeName(owner));
      notes.stepWorktree({ ...tree, label: owner.label }, true);
      if (existsSync(tree.dir)) return { tree };
      try {
        makeWorktree(baseDir, tree, true);
        return { tree };
      } catch (error) {
        if (!branchExists(baseDir, tree.branch)) notes.stepWorktree(tree, false);
        return { reason: (error as Error).message };
      }
    },

    closePlace(baseDir, tree, label) {
      try {
        const closed = closeWorktree(baseDir, tree, label);
        if (!closed.branchKept) notes.stepWorktree(tree, false);
        return closed;
      } catch (error) {
        return { reason: (error as Error).message };
      }
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
  closeNested: (childRunId) => ({ tree: { dir: "", branch: `sous/${childRunId}` }, reason: "no home for worktrees" }),
  sessionPlace: () => ({ reason: "no home for worktrees" }),
  closePlace: () => ({ reason: "no home for worktrees" }),
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

function branchExists(repoDir: string, branch: string): boolean {
  try {
    git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Commit everything in `dir`, skipping the project's hooks. When git knows no author, sous is one. */
function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  const commit = ["commit", "--quiet", "--no-verify", "-m", message];
  try {
    git(dir, commit);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (!/tell me who you are|empty ident|auto-detect email|no email was given/i.test(stderr)) throw error;
    git(dir, ["-c", "user.name=sous", "-c", "user.email=sous@localhost", ...commit]);
  }
}

/**
 * End a worktree's scope. sous commits what is uncommitted with the message
 * `sous: uncommitted work of <label>`, then removes the folder. The branch stays, unless it never
 * moved since it was made. It throws, and leaves the folder as it is, when the commit fails.
 */
function closeWorktree(repoDir: string, tree: Worktree, label: string): Closed {
  let committed = false;
  if (existsSync(tree.dir)) {
    if (git(tree.dir, ["status", "--porcelain"]) !== "") {
      try {
        commitAll(tree.dir, `sous: uncommitted work of ${label}`);
      } catch (error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? (error as Error).message);
        throw new Error(`could not commit the work left in ${tree.dir}: ${stderr.trim()}`);
      }
      committed = true;
    }
    const unmoved = !committed && worktreeUnchanged(tree.dir, tree.branch);
    git(repoDir, ["worktree", "remove", "--force", tree.dir]);
    if (unmoved) {
      git(repoDir, ["branch", "-D", tree.branch]);
      return { committed, branchKept: false };
    }
  } else {
    git(repoDir, ["worktree", "prune"]);
  }
  return { committed, branchKept: branchExists(repoDir, tree.branch) };
}

/** Remove a worktree's folder, when it has one, and its branch, when it is still there. */
export function removeWorktree(repoDir: string, dir: string | undefined, branch: string): void {
  if (dir !== undefined && existsSync(dir)) git(repoDir, ["worktree", "remove", "--force", dir]);
  else git(repoDir, ["worktree", "prune"]);
  if (branchExists(repoDir, branch)) git(repoDir, ["branch", "-D", branch]);
}

/**
 * Each worktree a run's record names, with the label its leftover commit names: its sessions' and
 * steps', its nested runs', deepest first, and its own. The run's own is left out when it borrowed
 * it from the run it reuses, unless `borrowed` is set.
 */
function namedWorktrees(record: RunRecord, borrowed: boolean): Array<Worktree & { label: string }> {
  const trees = (record.stepWorktrees ?? []).map(({ dir, branch, label }) => ({ dir, branch, label: label ?? branch.replace(/^sous\//, "") }));
  const nested = Object.entries(record.nested ?? {}).sort(([a], [b]) => b.length - a.length);
  for (const [, child] of nested) {
    if (child.cwd && child.branch) trees.push({ dir: child.cwd, branch: child.branch, label: child.label ?? child.workflow });
  }
  if (record.worktree && record.branch && (borrowed || !record.reuseFrom)) trees.push({ dir: record.worktree, branch: record.branch, label: record.workflow });
  const seen = new Set<string>();
  return trees.filter((tree) => !seen.has(tree.dir) && seen.add(tree.dir));
}

/** A branch a run's record names, and its worktree's folder while the folder is there. */
export interface RunBranch {
  branch: string;
  dir?: string;
}

/** The branches a run's record names that are still there, each with its folder when it has one. */
export function runWorktrees(record: RunRecord): RunBranch[] {
  const kept: RunBranch[] = [];
  for (const { dir, branch } of namedWorktrees(record, false)) {
    if (existsSync(dir)) kept.push({ branch, dir });
    else if (branchExists(record.projectDir, branch)) kept.push({ branch });
  }
  return kept.sort((a, b) => a.branch.localeCompare(b.branch));
}

/** What the end of a run did with one of its worktrees, or why it stays. */
/** The log line of one worktree whose scope ended, or that stayed. */
export function closedLine({ dir, branch }: Worktree, close: Closed | { reason: string }): string {
  if ("reason" in close) return `kept       ${dir}: ${close.reason}`;
  if (!close.branchKept) return `removed    ${dir} and ${branch}, which changed no file`;
  return `closed     ${dir}${close.committed ? ", with its uncommitted work committed" : ""}. Its work is on ${branch}`;
}

export type RunClose = { tree: Worktree } & (Closed | { reason: string });

/**
 * At the end of a run, end the scope of each worktree its record names whose folder is still
 * there, as `closeWorktree` does: its sessions' and steps', its nested runs' and its own.
 */
export function closeRunWorktrees(record: RunRecord): RunClose[] {
  const closed: RunClose[] = [];
  for (const { label, ...tree } of namedWorktrees(record, true)) {
    if (!existsSync(tree.dir)) continue;
    try {
      closed.push({ tree, ...closeWorktree(record.projectDir, tree, label) });
    } catch (error) {
      closed.push({ tree, reason: (error as Error).message });
    }
  }
  return closed;
}

export interface GcResult {
  removed: Array<{ dir: string; branch: string; reason: string }>;
  kept: Array<{ dir: string; branch: string; reason: string }>;
}

/** True when `branch` is merged into the project's current branch. */
function mergedIntoHead(projectDir: string, branch: string): boolean {
  try {
    git(projectDir, ["merge-base", "--is-ancestor", branch, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove sous's worktrees whose branch is merged into the project's current branch and has no
 * uncommitted changes, and sous's merged branches whose worktree's scope ended. Everything else
 * stays, and so does each folder or branch in `busy`. A branch with no folder has an empty `dir`.
 */
export function gcWorktrees(paths: HomePaths, projectDirs: string[], options: { dryRun?: boolean; busy: Set<string> }): GcResult {
  const result: GcResult = { removed: [], kept: [] };
  if (!existsSync(paths.worktrees)) return result;
  // Git reports real paths, so /var/... on macOS shows as /private/var/....
  const root = realpathSync(paths.worktrees);
  const real = (dir: string) => (existsSync(dir) ? realpathSync(dir) : dir);
  const busy = new Set([...options.busy].map((item) => (isAbsolute(item) ? real(item) : item)));
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
      if (busy.has(entry.dir) || busy.has(entry.branch)) {
        result.kept.push({ ...entry, reason: "its run has not finished" });
        continue;
      }
      const dirty = git(entry.dir, ["status", "--porcelain"]);
      if (dirty) {
        result.kept.push({ ...entry, reason: "uncommitted changes" });
        continue;
      }
      if (!mergedIntoHead(projectDir, entry.branch)) {
        result.kept.push({ ...entry, reason: "not merged" });
        continue;
      }
      if (!options.dryRun) {
        git(projectDir, ["worktree", "remove", entry.dir]);
        git(projectDir, ["branch", "-d", entry.branch]);
      }
      result.removed.push({ ...entry, reason: "merged" });
    }
    gcBranches(projectDir, new Set(entries.map((entry) => entry.branch)), busy, options.dryRun, result);
  }
  for (const name of readdirSync(paths.worktrees)) {
    const dir = join(paths.worktrees, name);
    if (!seen.has(real(dir)) && !result.removed.some((r) => r.dir === real(dir))) result.kept.push({ dir, branch: "", reason: "its project was not checked" });
  }
  return result;
}

/**
 * The branches of sous's worktrees whose scope ended, so they have no folder: a merged one goes,
 * and the rest stay. `withFolder` holds the branches gc already saw with a folder.
 */
function gcBranches(projectDir: string, withFolder: Set<string>, busy: Set<string>, dryRun: boolean | undefined, result: GcResult): void {
  let listing: string;
  try {
    listing = git(projectDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/sous/"]);
  } catch {
    return;
  }
  for (const branch of listing.split("\n").filter(Boolean)) {
    if (withFolder.has(branch)) continue;
    if (busy.has(branch)) {
      result.kept.push({ dir: "", branch, reason: "its run has not finished" });
    } else if (!mergedIntoHead(projectDir, branch)) {
      result.kept.push({ dir: "", branch, reason: "not merged" });
    } else {
      if (!dryRun) git(projectDir, ["branch", "-d", branch]);
      result.removed.push({ dir: "", branch, reason: "merged" });
    }
  }
}

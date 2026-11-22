// What orc knows about a run beyond the engine's own state: which workflow, where it works,
// who started it and which process runs it. One JSON file per root run in records/.

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HomePaths, Place } from "./home.js";
import type { Priority } from "./slots.js";

/** The programs whose steps a run records: Claude Code and Codex. */
export type Program = "claude" | "codex";

export interface RunRecord {
  runId: string;
  /** The workflow's name, or the file's stem when run from a path. */
  workflow: string;
  /** The script file the run started from. */
  file: string;
  args: Record<string, unknown>;
  place: Place;
  /** Where the run works. */
  cwd: string;
  /** The project the run belongs to: its agents, workflows and servers. */
  projectDir: string;
  worktree?: string;
  branch?: string;
  priority: Priority;
  /** Who started it: a person at the command line, a schedule, a rerun, or an agent in another run. */
  origin: "cli" | "schedule" | "rerun" | "agent" | "check";
  schedule?: string;
  /** The worker process, while one runs the run. */
  pid?: number;
  createdAt: string;
  /** Per-run changes to steps, by label. */
  overrides?: Record<string, Record<string, unknown>>;
  /** Model for agent steps that name none. */
  defaultModel?: string;
  concurrency?: number;
  /** The workflow's time limit, such as "2h". Each start and resume gets the whole of it. */
  timeout?: string;
  /** Set when the run was started again from another run. */
  rerunOf?: string;
  /** The run whose unchanged steps this run reuses. */
  reuseFrom?: string;
  /** The run whose agent started this one. */
  startedByRun?: string;
  /** Workflows this run started inside itself, by child run id. */
  nested?: Record<string, NestedRun>;
  /** Worktrees of steps with `isolation: "worktree"` that exist now. A step removes its own when it ends. */
  stepWorktrees?: Array<{ dir: string; branch: string }>;
  /** Set by `orc resume --latest`: the next resume takes the edited workflows. */
  resumeLatest?: boolean;
  /** Steps `orc stop --step` asked the worker to stop, by the name the log gives them. */
  stopSteps?: string[];
  /** The installed Claude Code and Codex the run's steps used, by harness, from its last start. */
  programs?: Record<string, { path: string; version?: string }>;
  /** The account each program's steps use, kept across pauses and resumes (orc's accounts.ts). */
  accounts?: Partial<Record<Program, RunAccount>>;
  /** Set when a step hit a usage limit: whose limit it was. A start or resume clears it. */
  limit?: { program: Program; account: string; at: string };
}

export interface RunAccount {
  /** An account of orc's, "default" for the program's own login, or "caller" for the login of
   *  the agent's session that started the run. */
  name: string;
  /** The program's config folder variable as it was where the run started. Null when it was not set. */
  folder: string | null;
  /** The key of the login token the run started with, when it is no account of orc's. */
  kept?: string;
}

export interface NestedRun {
  /** The run that started it: the root run or another nested run. */
  parent: string;
  workflow: string;
  /** What the script called it, such as the ticket it builds. */
  label?: string;
  /** Where it works, when it asked for a place of its own. */
  cwd?: string;
  branch?: string;
}

/** The nested runs from the root's first child down to this scope. A scope the record does not
 *  know counts as a child of the root. */
export function scopePath(nested: Record<string, NestedRun> = {}, scope: string): string[] {
  const path = [scope];
  for (let id = nested[scope]?.parent; id && nested[id] && !path.includes(id); id = nested[id]!.parent) path.unshift(id);
  return path;
}

/** How the log names a scope: "" for the run itself, else "Nested label / Inner label: ". */
export function scopePrefix(runId: string, scope: string | undefined, nested: Record<string, NestedRun> = {}): string {
  if (!scope || scope === runId) return "";
  const names = scopePath(nested, scope).map((id) => nested[id]?.label ?? nested[id]?.workflow ?? id);
  return `${names.join(" / ")}: `;
}

/** Note a nested run on its root run's record. */
export function noteNested(paths: HomePaths, rootRunId: string, childRunId: string, change: Partial<NestedRun>): void {
  const record = loadRecord(paths, rootRunId);
  if (!record) return;
  const next = { ...record.nested?.[childRunId], ...change } as NestedRun;
  saveRecord(paths, { ...record, nested: { ...record.nested, [childRunId]: next } });
}

/** Note a step's worktree on the root run's record when it is made, and drop it when it is gone. */
export function noteStepWorktree(paths: HomePaths, rootRunId: string, tree: { dir: string; branch: string }, exists: boolean): void {
  const record = loadRecord(paths, rootRunId);
  if (!record) return;
  const others = (record.stepWorktrees ?? []).filter((known) => known.dir !== tree.dir);
  const stepWorktrees = exists ? [...others, tree] : others;
  saveRecord(paths, { ...record, stepWorktrees });
}

/** The saved workflows as they were when the run started, by name. Nested workflows come from it,
 * so an edit made during the run never reaches it. */
export function snapshotFile(paths: HomePaths, runId: string): string {
  return join(paths.records, `${runId}.workflows`);
}

export function saveSnapshot(paths: HomePaths, runId: string, scripts: Record<string, string>): void {
  const file = snapshotFile(paths, runId);
  writeFileSync(`${file}.tmp`, JSON.stringify(scripts));
  renameSync(`${file}.tmp`, file);
}

export function loadSnapshot(paths: HomePaths, runId: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(snapshotFile(paths, runId), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function recordFile(paths: HomePaths, runId: string): string {
  return join(paths.records, `${runId}.json`);
}

export function saveRecord(paths: HomePaths, record: RunRecord): void {
  const file = recordFile(paths, record.runId);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, file);
}

/**
 * Read a record file. Older records have nested entries with no parent. This is the one place
 * that reads that old shape, and the only code that knows a child's id is `<parent>-nested<n>`.
 */
function readRecord(file: string): RunRecord {
  const record = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  for (const [id, child] of Object.entries(record.nested ?? {})) {
    const at = id.lastIndexOf("-nested");
    if (child.parent === undefined && at > 0) child.parent = id.slice(0, at);
  }
  return record;
}

export function loadRecord(paths: HomePaths, runId: string): RunRecord | undefined {
  const file = recordFile(paths, runId);
  if (!existsSync(file)) return undefined;
  return readRecord(file);
}

export function updateRecord(paths: HomePaths, runId: string, change: Partial<RunRecord>): RunRecord | undefined {
  const record = loadRecord(paths, runId);
  if (!record) return undefined;
  const next = { ...record, ...change };
  for (const [key, value] of Object.entries(change)) if (value === undefined) delete (next as Record<string, unknown>)[key];
  saveRecord(paths, next);
  return next;
}

/** Every run orc started, newest first. */
export function listRecords(paths: HomePaths): RunRecord[] {
  if (!existsSync(paths.records)) return [];
  const out: RunRecord[] = [];
  for (const name of readdirSync(paths.records)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(readRecord(join(paths.records, name)));
    } catch {
      // a record being written
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Find a run by its full id or a unique start of it. */
export function findRecord(paths: HomePaths, idOrPrefix: string): RunRecord | undefined {
  const exact = loadRecord(paths, idOrPrefix);
  if (exact) return exact;
  const matches = listRecords(paths).filter((record) => record.runId.startsWith(idOrPrefix));
  if (matches.length > 1) throw new Error(`"${idOrPrefix}" matches ${matches.length} runs. Give more of the id.`);
  return matches[0];
}

export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// What sous knows about a run beyond the engine's own state: which workflow, where it works,
// who started it and which process runs it. One JSON file per root run in records/.
//
// While a worker runs a run, only the worker writes its record, apart from the pid the launcher
// notes as the worker starts. A command writes a record only when no worker runs it. A save
// replaces the whole file, so two writers at once would lose one's change.

import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import type { HarnessId } from "@sous/harnesses";
import { appendJsonLine, readJsonFile, readJsonLines, writeJsonFile } from "../json-file.js";
import { redactText } from "../redact.js";
import type { ActivityEntry, ActivityStep, OnActivity } from "../steps/activity.js";
import type { PlaceNotes } from "../places/places.js";
import type { Through } from "./actions.js";
import type { HomePaths, Place } from "./home.js";
import type { Priority } from "./slots.js";
import { activityFile, recordFile, recordFiles, snapshotFile, stopRequestFile } from "./store.js";
import { Refusal } from "./refusal.js";

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
  /** How the start reached sous. A run an agent or a step started may not reach a people
   *  workflow inside itself, through workflow() or choose(). Older records have none. */
  through?: Through;
  /** Workflows this run started inside itself, by child run id. */
  nested?: Record<string, NestedRun>;
  /** Worktrees of steps with `isolation: "worktree"` that exist now. A step removes its own when it ends. */
  stepWorktrees?: Array<{ dir: string; branch: string }>;
  /** Set by `sous resume --latest`: the next resume takes the edited workflows. */
  resumeLatest?: boolean;
  /** The installed Claude Code and Codex the run's steps used, by harness, from its last start. */
  programs?: Record<string, { path: string; version?: string }>;
  /** The account each program's steps use, kept across pauses and resumes (sous's accounts.ts). */
  accounts?: Partial<Record<HarnessId, RunAccount>>;
  /** Set when a step hit a usage limit: whose limit it was. A start or resume clears it. */
  limit?: { program: HarnessId; account: string; at: string };
}

export interface RunAccount {
  /** An account of sous's, "default" for the program's own login, or "caller" for the login of
   *  the agent's session that started the run. */
  name: string;
  /** The program's config folder variable as it was where the run started. Null when it was not set. */
  folder: string | null;
  /** The key of the login token the run started with, when it is no account of sous's. */
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

/**
 * The root run's record as the notes of its run tree's places: its nested runs, and its steps'
 * worktrees while they exist. gc reads them there. A run with no record notes nothing.
 */
export function placeNotes(paths: HomePaths, rootRunId: string): PlaceNotes {
  return {
    nested(childRunId, change) {
      const record = loadRecord(paths, rootRunId);
      if (!record) return;
      const next = { ...record.nested?.[childRunId], ...change } as NestedRun;
      saveRecord(paths, { ...record, nested: { ...record.nested, [childRunId]: next } });
    },
    stepWorktree(tree, exists) {
      const record = loadRecord(paths, rootRunId);
      if (!record) return;
      const others = (record.stepWorktrees ?? []).filter((known) => known.dir !== tree.dir);
      const stepWorktrees = exists ? [...others, tree] : others;
      saveRecord(paths, { ...record, stepWorktrees });
    },
  };
}

export function saveSnapshot(paths: HomePaths, runId: string, scripts: Record<string, string>): void {
  writeJsonFile(snapshotFile(paths, runId), scripts);
}

export function loadSnapshot(paths: HomePaths, runId: string): Record<string, string> {
  return readJsonFile<Record<string, string>>(snapshotFile(paths, runId)) ?? {};
}

export function saveRecord(paths: HomePaths, record: RunRecord): void {
  writeJsonFile(recordFile(paths, record.runId), record);
}

/**
 * Read a record file. Older records have nested entries with no parent. This is the one place
 * that reads that old shape. It takes the parent from the child's id, `<parent>-nested<n>`.
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

/** A request to stop a step: the name the log gives it, and each call that runs under that name,
 *  by the run or nested run it runs in, its label there and its call index when the state has one. */
export interface StepStop {
  step: string;
  calls: Array<{ scope: string; label: string; callIndex?: number }>;
}

/**
 * Ask the worker to stop a step. The request goes to a file of its own, not the record the worker
 * writes. Each request is one appended line, so two at once both land.
 */
export function requestStepStop(paths: HomePaths, runId: string, stop: StepStop): void {
  appendFileSync(stopRequestFile(paths, runId), `${JSON.stringify(stop)}\n`);
}

/** The steps asked to stop since the last take. The file moves aside before the read, so a request
 *  that lands meanwhile starts a new file and waits for the next take. A line an older sous wrote,
 *  a bare name, is dropped. */
export function takeStepStops(paths: HomePaths, runId: string): StepStop[] {
  const file = stopRequestFile(paths, runId);
  const taken = `${file}.${process.pid}.taken`;
  try {
    renameSync(file, taken);
  } catch {
    return [];
  }
  const lines = readFileSync(taken, "utf8").split("\n").filter(Boolean);
  unlinkSync(taken);
  return lines.map((line) => JSON.parse(line) as StepStop | string).filter((stop): stop is StepStop => typeof stop === "object");
}

/** One saved activity entry: its number in the run's file, when it happened, its step and what it says. */
export type ActivityLine = { seq: number; at: string } & ActivityStep & ActivityEntry;

/** The most a saved entry's text holds. */
const ACTIVITY_TEXT = 2_000;

/** A loaded secret shorter than this stays in the text, since it would hide common words. */
const SECRET_MIN = 8;

/**
 * The worker's writer of the run's activity file. It numbers the entries on from the last one the
 * file holds, read at the first write, once the worker holds the run's lease, so a resume goes on
 * from there. Each text loses its credentials, as the event log's do, and the values of the
 * secrets given, before it is cut. A text longer than 2,000 characters is cut: an output keeps its
 * end, where a failure shows, and the rest keep their start. A write that fails loses the entry
 * and never fails the step.
 */
export function activityWriter(paths: HomePaths, runId: string, secrets: readonly string[] = []): OnActivity {
  const file = activityFile(paths, runId);
  const hidden = secrets.filter((value) => value.length >= SECRET_MIN);
  let seq: number | undefined;
  return (step, entry) => {
    const { kind, tool } = entry;
    const text = hidden.reduce((out, value) => out.split(value).join("[REDACTED]"), redactText(entry.text).value);
    const cut = text.length <= ACTIVITY_TEXT ? text : kind === "output" ? text.slice(-ACTIVITY_TEXT) : text.slice(0, ACTIVITY_TEXT);
    try {
      seq ??= readActivity(paths, runId).reduce((last, line) => Math.max(last, line.seq), 0);
      appendJsonLine(file, { seq: seq + 1, at: new Date().toISOString(), ...step, kind, ...(tool === undefined ? {} : { tool }), text: cut });
      seq += 1;
    } catch {
      // The activity is for people to read. The step goes on.
    }
  };
}

/** The run's saved activity, oldest first. */
export function readActivity(paths: HomePaths, runId: string): ActivityLine[] {
  return readJsonLines<ActivityLine>(activityFile(paths, runId));
}

export function updateRecord(paths: HomePaths, runId: string, change: Partial<RunRecord>): RunRecord | undefined {
  const record = loadRecord(paths, runId);
  if (!record) return undefined;
  const next = { ...record, ...change };
  for (const [key, value] of Object.entries(change)) if (value === undefined) delete (next as Record<string, unknown>)[key];
  saveRecord(paths, next);
  return next;
}

/** Every run sous started, newest first. */
export function listRecords(paths: HomePaths): RunRecord[] {
  const out: RunRecord[] = [];
  for (const file of recordFiles(paths)) {
    try {
      out.push(readRecord(file));
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
  if (matches.length > 1) {
    const ids = matches.map((record) => record.runId).join(", ");
    throw new Refusal("no_such_run", `"${idOrPrefix}" matches ${matches.length} runs: ${ids}. Give more of the id.`, "Give the id of a run, or a unique start of one.", "sous list --json");
  }
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

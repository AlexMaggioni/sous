// What sous knows about a run beyond the engine's own state: which workflow, where it works,
// who started it and which process runs it. One JSON file per root run in records/.
//
// While a worker runs a run, only the worker writes its record, apart from the pid the launcher
// notes as the worker starts. A command writes a record only when no worker runs it. A save
// replaces the whole file, so two writers at once would lose one's change.

import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { HarnessId, SteerOutcome } from "@sous-run/harnesses";
import { appendJsonLine, readJsonFile, readJsonLines, writeJsonFile } from "../json-file.js";
import { redactText } from "../redact.js";
import type { ActivityEntry, ActivityStep, OnActivity } from "../steps/activity.js";
import type { PlaceNotes } from "../places/places.js";
import type { By, Through } from "./actions.js";
import type { HomePaths, Place } from "./home.js";
import type { Priority } from "./slots.js";
import { activityFile, joinRequestFile, noteFile, pauseRequestFile, recordFile, recordFiles, snapshotFile, stopRequestFile, tellRequestFile } from "./store.js";
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
  /** The worker's pid while it listens for `sous pause`. Until then, and once it stops, a pause
   *  only leaves its file. */
  listening?: number;
  /** Set with the pid by this sous's launcher and worker: the worker takes `sous pause` from its
   *  file. A worker an older sous started has none, and takes only SIGUSR1. */
  pauseFile?: true;
  createdAt: string;
  /** Per-run changes to steps, by label. */
  overrides?: Record<string, Record<string, unknown>>;
  /** Model for agent steps that name none. */
  defaultModel?: string;
  concurrency?: number;
  /** The workflow's time limit, such as "2h". Each start and resume gets the whole of it. */
  timeout?: string;
  /** The most tokens one go of the run may spend, from --budget or the config's budgetTokens.
   *  Each start and resume gets the whole of it. None means no limit. */
  budget?: number;
  /** Set when the run was started again from another run. */
  rerunOf?: string;
  /** The run whose unchanged steps this run reuses. */
  reuseFrom?: string;
  /** The run whose agent started this one. */
  startedByRun?: string;
  /** How the start reached sous. A run an agent or a step started may not reach a people
   *  workflow inside itself, through workflow() or choose(). Older records have none. */
  through?: Through;
  /** The person let agents answer this run's people questions, and its nested runs', never its
   *  breakpoints: who said so, through what, and when. Set by --let-agent-answer. */
  letAgentAnswer?: { by: By; through: Through; at: string };
  /** The sha256 of the workflow's text that sous checked when it wrote the record. The worker
   *  starts only that text. Older records have none. */
  workflowHash?: string;
  /** Why the worker did not run the workflow: its file changed after sous checked it. A worker that
   *  runs the run clears it. */
  refused?: string;
  /** Workflows this run started inside itself, by child run id. */
  nested?: Record<string, NestedRun>;
  /** Worktrees of sessions and steps with `place: "worktree"`, with the label of each. A name
   *  stays while its folder or its branch does, so gc keeps the folder of an unfinished run and
   *  discard finds the branch. Older records have no label. */
  stepWorktrees?: Array<{ dir: string; branch: string; label?: string }>;
  /** Set by `sous resume --latest`: the next resume takes the edited workflows. */
  resumeLatest?: boolean;
  /** The sha256 of the text sous checked at `sous resume --latest`. The worker resumes only that text. */
  latestHash?: string;
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
 * The root run's record as the notes of its run tree's places: its nested runs, and the
 * worktrees of its sessions and steps while their folder or branch exists. gc and discard read
 * them there. A run with no record notes nothing.
 */
export function placeNotes(paths: HomePaths, rootRunId: string): PlaceNotes {
  return {
    nested(childRunId, change) {
      const record = loadRecord(paths, rootRunId);
      if (!record) return;
      const next = { ...record.nested?.[childRunId], ...change } as NestedRun;
      saveRecord(paths, { ...record, nested: { ...record.nested, [childRunId]: next } });
    },
    stepWorktree(tree, keep) {
      const record = loadRecord(paths, rootRunId);
      if (!record) return;
      const others = (record.stepWorktrees ?? []).filter((known) => known.dir !== tree.dir);
      const stepWorktrees = keep ? [...others, tree] : others;
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

/** What a run id may hold. An id with anything else, such as "../", names no record. */
const RUN_ID = /^[A-Za-z0-9_-]+$/;

export const isRunId = (text: string) => RUN_ID.test(text);

export function loadRecord(paths: HomePaths, runId: string): RunRecord | undefined {
  if (!RUN_ID.test(runId)) return undefined;
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

/** Ask the run's worker to pause: the file first, then SIGUSR1, and only to a worker that listens. A
 *  worker still loading would take SIGUSR1 as Node's call to start its inspector, and the pause would
 *  be lost. The worker marks itself listening before it looks for the file, so one of the two always
 *  sees the other, and a worker that starts later still takes the file. A worker an older sous
 *  started never reads the file, so it gets SIGUSR1 alone, as that sous sent it. */
export function requestPause(paths: HomePaths, runId: string): void {
  const before = loadRecord(paths, runId);
  if (before?.pid && before.pauseFile !== true && before.listening === undefined) return pauseSignal(before.pid);
  writeFileSync(pauseRequestFile(paths, runId), "");
  const record = loadRecord(paths, runId);
  // A worker that ended since the first read took no file, so the pause goes with it.
  if (!record?.pid) takePause(paths, runId);
  else if (record.listening === record.pid) pauseSignal(record.pid);
}

function pauseSignal(pid: number): void {
  try {
    process.kill(pid, "SIGUSR1");
  } catch {
    // The worker ended since the check. The next one takes the file.
  }
}

/** The worker of the run is gone: clear its pid, and drop a pause asked of it, so the next worker
 *  does not pause on it. The pid clears first, so a pause after the take finds no worker. */
export function endWorker(paths: HomePaths, runId: string): void {
  if (!loadRecord(paths, runId)) return;
  updateRecord(paths, runId, { pid: undefined, listening: undefined, pauseFile: undefined });
  takePause(paths, runId);
}

/** True when a pause was asked since the last take. */
export function takePause(paths: HomePaths, runId: string): boolean {
  try {
    unlinkSync(pauseRequestFile(paths, runId));
    return true;
  } catch {
    return false;
  }
}

/** The steps asked to stop since the last take. The file moves aside before the read, so a request
 *  that lands meanwhile starts a new file and waits for the next take. A line an older sous wrote,
 *  a bare name, is dropped. */
export function takeStepStops(paths: HomePaths, runId: string): StepStop[] {
  return takeLines(stopRequestFile(paths, runId))
    .map((line) => JSON.parse(line) as StepStop | string)
    .filter((stop): stop is StepStop => typeof stop === "object");
}

/** A request file's lines since the last take. It moves aside before the read. */
function takeLines(file: string): string[] {
  const taken = `${file}.${process.pid}.taken`;
  try {
    renameSync(file, taken);
  } catch {
    return [];
  }
  const lines = readFileSync(taken, "utf8").split("\n").filter(Boolean);
  unlinkSync(taken);
  return lines;
}

/** A message `sous tell` sends: its id, the step's name in the log, the text, and each call it
 *  reaches, by its run or nested run, its label and its call index when the state has one. */
export interface TellRequest {
  id: string;
  step: string;
  text: string;
  calls: Array<{ scope: string; label: string; callIndex?: number }>;
}

/** Ask the worker to give a running step a message. Each request is one appended line, as a step stop is. */
export function requestTell(paths: HomePaths, runId: string, tell: TellRequest): void {
  appendFileSync(tellRequestFile(paths, runId), `${JSON.stringify(tell)}\n`);
}

/** What became of a tell at one call: what its turn said, or no_turn when the call was in no turn
 *  that reads a message, such as while it starts, waits for a slot, or between two turns. */
export type TellOutcome = SteerOutcome | "no_turn";

/** The text of a tell's receipt in the step's activity, by what became of the message. */
export const TELL_RECEIPTS: Record<TellOutcome, string> = {
  delivered: "delivered",
  not_steerable: "not delivered, the turn takes no message now",
  ended: "not delivered, the turn ended first",
  no_turn: "not delivered, the step is not in a turn that can read a message now",
};

/** The tells sent since the last take, as takeStepStops takes the stops. */
export function takeTells(paths: HomePaths, runId: string): TellRequest[] {
  return takeLines(tellRequestFile(paths, runId)).map((line) => JSON.parse(line) as TellRequest);
}

/** A `sous join` asks the worker for a session: the session's id, and the pid of the `sous join`
 *  that will hold it. */
export interface JoinRequest {
  sessionId: string;
  pid: number;
}

/** Ask the worker to hand a session to a `sous join`. Each request is one appended line, as a step stop is. */
export function requestJoin(paths: HomePaths, runId: string, join: JoinRequest): void {
  appendFileSync(joinRequestFile(paths, runId), `${JSON.stringify(join)}\n`);
}

/** The joins asked since the last take, as takeStepStops takes the stops. */
export function takeJoins(paths: HomePaths, runId: string): JoinRequest[] {
  return takeLines(joinRequestFile(paths, runId)).map((line) => JSON.parse(line) as JoinRequest);
}

/** A note `sous resume --note` gives the resumed run: its text, and the step it is for, by its
 *  name in the log, the runs or nested runs that name covers and its label there. Without a step
 *  it goes to the first agent call that runs. */
export interface NoteRequest {
  text: string;
  step?: { name: string; scopes: string[]; label: string };
}

/** Leave a note for the next worker of the run. The latest note wins. */
export function requestNote(paths: HomePaths, runId: string, note: NoteRequest): void {
  appendFileSync(noteFile(paths, runId), `${JSON.stringify(note)}\n`);
}

/** The note left for this worker, if any. It moves aside before the read, as the tells do. */
export function takeNote(paths: HomePaths, runId: string): NoteRequest | undefined {
  const last = takeLines(noteFile(paths, runId)).at(-1);
  return last === undefined ? undefined : (JSON.parse(last) as NoteRequest);
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
    const { kind, tool, id } = entry;
    const text = hidden.reduce((out, value) => out.split(value).join("[REDACTED]"), redactText(entry.text).value);
    const cut = text.length <= ACTIVITY_TEXT ? text : kind === "output" ? text.slice(-ACTIVITY_TEXT) : text.slice(0, ACTIVITY_TEXT);
    try {
      seq ??= readActivity(paths, runId).reduce((last, line) => Math.max(last, line.seq), 0);
      appendJsonLine(file, { seq: seq + 1, at: new Date().toISOString(), ...step, kind, ...(tool === undefined ? {} : { tool }), text: cut, ...(id === undefined ? {} : { id }) });
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
  if (!RUN_ID.test(idOrPrefix)) {
    const message = `"${idOrPrefix}" is not a run id. A run id holds only letters, digits, "-" and "_".`;
    throw new Refusal("no_such_run", message, "Give the id of a run, or a unique start of one.", "sous list --json");
  }
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

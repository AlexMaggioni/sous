// Where a run's files live, plain reads of its engine files, the engine's persistence for the
// worker's manager, the agent slot pool, and the delete of a run that is forgotten. Only
// removeEngineRun and removeRunFiles write, apart from the folders the slot pool makes, and no
// manager is built.

import { existsSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { workflowProjectPaths } from "./persistence/project-paths.js";
import { createRunPersistence, loadRunState, type FsLayer, type PersistedRunState } from "./persistence/run-persistence.js";
import type { RunEventPersistence } from "./persistence/run-event-persistence.js";
import type { PersistedRunEvent } from "../run-events.js";
import { rootRunId } from "../resume-identity.js";
import type { HomePaths } from "./home.js";
import type { RunRecord } from "./records.js";
import { SlotPool, type Priority } from "./slots.js";

/** The file calls the store reads through. Tests hand it one that counts the calls. */
export type StoreFs = Pick<FsLayer, "existsSync" | "readdirSync" | "readFileSync">;

const DISK: StoreFs = { existsSync, readdirSync, readFileSync };

/** The home's folders that hold run files sous writes: records, questions, the agent cap and the
 *  worker logs. homePaths takes them from here. */
export function runFolders(home: string) {
  return {
    records: join(home, "records"),
    inbox: join(home, "inbox"),
    slots: join(home, "slots"),
    queue: join(home, "queue"),
    logs: join(home, "logs"),
  };
}

/** The run's record. */
export function recordFile(paths: HomePaths, runId: string): string {
  return join(paths.records, `${runId}.json`);
}

/** The saved workflows as they were when the run started, by name. Nested workflows come from it,
 * so an edit made during the run never reaches it. */
export function snapshotFile(paths: HomePaths, runId: string): string {
  return join(paths.records, `${runId}.workflows`);
}

/** The steps `sous stop --step` asked a running run to stop, one per line, until the worker takes them. */
export function stopRequestFile(paths: HomePaths, runId: string): string {
  return join(paths.records, `${runId}.stop`);
}

/** Marks a `sous pause` the worker has not taken yet, so a worker still starting pauses once it listens. */
export function pauseRequestFile(paths: HomePaths, runId: string): string {
  return join(paths.records, `${runId}.pause`);
}

/** The messages `sous tell` sent a running run's steps, one per line, until the worker takes them. */
export function tellRequestFile(paths: HomePaths, runId: string): string {
  return join(paths.records, `${runId}.tell`);
}

/** The note `sous resume --note` gave the next worker, until that worker takes it. */
export function noteFile(paths: HomePaths, runId: string): string {
  return join(paths.records, `${runId}.note`);
}

/** What the run's steps did, one JSON line per entry. Only the worker appends to it. */
export function activityFile(paths: HomePaths, runId: string): string {
  return join(paths.records, `${runId}.activity.jsonl`);
}

/** Every record file, in the order the folder lists them. */
export function recordFiles(paths: HomePaths): string[] {
  if (!existsSync(paths.records)) return [];
  return readdirSync(paths.records)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(paths.records, name));
}

/** A question a run waits on. */
export function questionFile(paths: HomePaths, id: string): string {
  return join(paths.inbox, `${id}.json`);
}

/** The answer to a question, next to it. */
export function answerFile(paths: HomePaths, id: string): string {
  return join(paths.inbox, `${id}.answer.json`);
}

/** Every question file, answered or not, in the order the folder lists them. Answer files are left out. */
export function questionFiles(paths: HomePaths): string[] {
  if (!existsSync(paths.inbox)) return [];
  return readdirSync(paths.inbox)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".answer.json"))
    .map((name) => join(paths.inbox, name));
}

/** The machine-wide cap on agents: a file per held slot, and a ticket per waiting agent. */
export function agentSlots(paths: HomePaths, cap: () => number, priority: Priority): SlotPool {
  return new SlotPool(paths.slots, paths.queue, cap, priority);
}

/** The run's worker log. The worker's output goes there. */
export function logFile(paths: HomePaths, runId: string): string {
  return join(paths.logs, `${runId}.log`);
}

/** The service's own log. */
export function daemonLog(paths: HomePaths): string {
  return join(paths.logs, "daemon.log");
}

/** The engine's folders for sous's runs. Every sous manager works from the home folder, so the
 *  folders do not depend on the run's project. */
function engineFolders(paths: HomePaths) {
  return workflowProjectPaths(paths.home, { persistenceRoot: paths.runs });
}

/** The engine's files for a run: its saved state and its event log. The test kit writes them
 *  by hand, to plant a run as an engine left it. */
export function engineRunFiles(paths: HomePaths, runId: string): { state: string; events: string } {
  const { runsDir } = engineFolders(paths);
  return { state: join(runsDir, `${runId}.json`), events: join(runsDir, `${runId}.events.jsonl`) };
}

/** The engine's persistence for sous's runs. The worker hands it to its manager. It writes nothing
 *  until something saves or takes a lease through it. */
export function enginePersistence(paths: HomePaths): RunEventPersistence {
  return createRunPersistence(paths.home, undefined, { persistenceRoot: paths.runs });
}

/** Where a manager of sous's runs keeps them. Run state is keyed to the manager's folder, so every
 *  sous manager uses the home folder. */
export function managerStore(paths: HomePaths): { cwd: string; persistenceRoot: string; persistence: RunEventPersistence } {
  return { cwd: paths.home, persistenceRoot: paths.runs, persistence: enginePersistence(paths) };
}

/** The run's state as the engine last saved it. A run left running by a worker that died still
 *  reads "running": the pause rule says what that means. */
export function readState(paths: HomePaths, runId: string, fs: StoreFs = DISK): PersistedRunState | undefined {
  const { runsDir } = engineFolders(paths);
  return loadRunState(runsDir, runId, fs) ?? undefined;
}

/**
 * The saved states of the given runs, by run id. A run with no state is left out. The engine's
 * folder is listed once, so a run with no state costs no file call, and a run with a good state
 * costs one read.
 */
export function readStates(paths: HomePaths, runIds: Iterable<string>, fs: StoreFs = DISK): Map<string, PersistedRunState> {
  const { runsDir } = engineFolders(paths);
  const present = new Set<string>();
  if (fs.existsSync(runsDir)) {
    for (const name of fs.readdirSync(runsDir)) present.add(join(runsDir, String(name)));
  }
  const listed = { existsSync: (file: Parameters<StoreFs["existsSync"]>[0]) => present.has(String(file)), readFileSync: fs.readFileSync };
  const states = new Map<string, PersistedRunState>();
  for (const runId of runIds) {
    const state = loadRunState(runsDir, runId, listed);
    if (state) states.set(runId, state);
  }
  return states;
}

/** A stamp of each run's files, and of each run's question files, both by root run id. A stamp
 *  changes when a file of it changes, comes or goes. It reads only folder lists and file stats. */
export interface RunStamps {
  runs: Map<string, string>;
  questions: Map<string, string>;
}

/**
 * The stamps of the runs' records and engine files, and of the open questions. A watcher that
 * reads them again and compares sees which runs changed without reading any of their files. A
 * nested run's files count for its root run.
 */
export function runStamps(paths: HomePaths): RunStamps {
  const stamps = (dir: string, key: (name: string) => string, into: Map<string, string>) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const stat = statSync(join(dir, name), { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      const id = key(name);
      into.set(id, `${into.get(id) ?? ""}${name}:${stat.mtimeMs}:${stat.size};`);
    }
  };
  // A question file is named after its id, its run or nested run, "--" and its call.
  const askedBy = (name: string) => {
    const id = name.replace(/(\.answer)?\.json$/, "");
    const at = id.lastIndexOf("--");
    return rootRunId(at > 0 ? id.slice(0, at) : id);
  };
  const runs = new Map<string, string>();
  const questions = new Map<string, string>();
  stamps(paths.records, (name) => rootRunId(name.split(".")[0]!), runs);
  stamps(engineFolders(paths).runsDir, (name) => rootRunId(name.split(".")[0]!), runs);
  stamps(paths.inbox, askedBy, questions);
  return { runs, questions };
}

/** An event the engine saved, with when it saved it and its number in the run's log. */
export interface SavedEvent {
  event: PersistedRunEvent;
  timestamp: string;
  seq: number;
}

/** Each event saved after `seq`, in order, until `visit` returns false. Throws when the run has no
 *  event log, or when `seq` is past its last event. */
export function readEventsAfter(paths: HomePaths, runId: string, seq: number, visit: (saved: SavedEvent) => unknown): void {
  // Built on each call: it writes nothing, since nothing saves through it.
  const events = enginePersistence(paths);
  let after = seq;
  for (;;) {
    const page = events.readEvents(runId, { after, limit: 1000 });
    for (const { event, timestamp, seq: number } of page.events) if (visit({ event, timestamp, seq: number }) === false) return;
    if (!page.hasMore || page.events.length === 0) break;
    after = page.events[page.events.length - 1]!.seq;
  }
}

/** The seq of the run's last saved event, 0 for an empty log. Throws when the run has no event log. */
export function lastEventSeq(paths: HomePaths, runId: string): number {
  return enginePersistence(paths).readEvents(runId, { after: 0, limit: 1 }).endCursor;
}

/** Delete the engine's files for a run: its state, event log and lock. It takes the run's lease
 *  first, as the engine does. It returns false, and deletes nothing, when another process holds
 *  the lease. */
export function removeEngineRun(paths: HomePaths, runId: string): boolean {
  const engine = enginePersistence(paths);
  const lease = engine.acquireRunLease(runId);
  if (!lease) return false;
  try {
    engine.delete(runId);
    return true;
  } finally {
    engine.releaseRunLease(lease);
  }
}

/** Delete a run's record, workflow snapshot, step stop, tell and note requests, and logs. removeEngineRun deletes the engine's files. */
export function removeRunFiles(paths: HomePaths, record: RunRecord): void {
  // The engine keeps its own copy of the log, in a folder named after where the run worked.
  const engineLogs = workflowProjectPaths(record.cwd, { persistenceRoot: paths.runs });
  const files = [recordFile(paths, record.runId), snapshotFile(paths, record.runId), stopRequestFile(paths, record.runId), pauseRequestFile(paths, record.runId), tellRequestFile(paths, record.runId), noteFile(paths, record.runId), activityFile(paths, record.runId), logFile(paths, record.runId), join(engineLogs.runsDir, `${record.runId}.log`)];
  for (const file of files) {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
  for (const dir of [engineLogs.runsDir, engineLogs.rootDir]) {
    try {
      rmdirSync(dir);
    } catch {
      // not empty, or gone
    }
  }
}

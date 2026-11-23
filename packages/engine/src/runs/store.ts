// Where a run's files live, plain reads of its engine files, the engine's persistence for the
// worker's manager, the agent slot pool, and the delete of a run that is forgotten. Only
// removeEngineRun and removeRunFiles write, apart from the folders the slot pool makes, and no
// manager is built.

import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { workflowProjectPaths } from "./persistence/project-paths.js";
import { createRunPersistence, loadRunState, type FsLayer, type PersistedRunState } from "./persistence/run-persistence.js";
import type { RunEventPersistence } from "./persistence/run-event-persistence.js";
import type { HomePaths } from "./home.js";
import type { RunRecord } from "./records.js";
import { SlotPool, type Priority } from "./slots.js";

/** The file calls the store reads through. Tests hand it one that counts the calls. */
export type StoreFs = Pick<FsLayer, "existsSync" | "readdirSync" | "readFileSync">;

const DISK: StoreFs = { existsSync, readdirSync, readFileSync };

/** The home's folders that hold run files orc writes: records, questions, the agent cap and the
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

/** The steps `orc stop --step` asked a running run to stop, one per line, until the worker takes them. */
export function stopRequestFile(paths: HomePaths, runId: string): string {
  return join(paths.records, `${runId}.stop`);
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

/** The engine's folders for orc's runs. Every orc manager works from the home folder, so the
 *  folders do not depend on the run's project. */
function engineFolders(paths: HomePaths) {
  return workflowProjectPaths(paths.home, { persistenceRoot: paths.runs });
}

/** The engine's persistence for orc's runs. The worker hands it to its manager. It writes nothing
 *  until something saves or takes a lease through it. */
export function enginePersistence(paths: HomePaths): RunEventPersistence {
  return createRunPersistence(paths.home, undefined, { persistenceRoot: paths.runs });
}

/** Where a manager of orc's runs keeps them. Run state is keyed to the manager's folder, so every
 *  orc manager uses the home folder. */
export function managerStore(paths: HomePaths): { cwd: string; persistenceRoot: string; persistence: RunEventPersistence } {
  return { cwd: paths.home, persistenceRoot: paths.runs, persistence: enginePersistence(paths) };
}

/** The run's state as the engine last saved it. A run left running by a worker that died still
 *  reads "running": the pause rule says what that means. */
export function readState(paths: HomePaths, runId: string, fs: StoreFs = DISK): PersistedRunState | undefined {
  const { runsDir, legacyRunsDir } = engineFolders(paths);
  return loadRunState(runsDir, legacyRunsDir, runId, fs) ?? undefined;
}

/**
 * The saved states of the given runs, by run id. A run with no state is left out. Each engine
 * folder is listed once, so a run with no state costs no file call, and a run with a good state
 * costs one read.
 */
export function readStates(paths: HomePaths, runIds: Iterable<string>, fs: StoreFs = DISK): Map<string, PersistedRunState> {
  const { runsDir, legacyRunsDir } = engineFolders(paths);
  const present = new Set<string>();
  for (const dir of new Set([runsDir, legacyRunsDir])) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) present.add(join(dir, String(name)));
  }
  const listed = { existsSync: (file: Parameters<StoreFs["existsSync"]>[0]) => present.has(String(file)), readFileSync: fs.readFileSync };
  const states = new Map<string, PersistedRunState>();
  for (const runId of runIds) {
    const state = loadRunState(runsDir, legacyRunsDir, runId, listed);
    if (state) states.set(runId, state);
  }
  return states;
}

/** An event the engine saved, with when it saved it. */
export interface SavedEvent {
  event: Record<string, unknown>;
  timestamp: string;
}

/** Each event saved after `seq`, in order. Throws when the run has no event log. */
export function readEventsAfter(paths: HomePaths, runId: string, seq: number, visit: (saved: SavedEvent) => void): void {
  // Built on each call: it writes nothing, since nothing saves through it.
  const events = enginePersistence(paths);
  let after = seq;
  for (;;) {
    const page = events.readEvents(runId, { after, limit: 1000 });
    for (const { event, timestamp } of page.events) visit({ event: event as unknown as Record<string, unknown>, timestamp });
    if (!page.hasMore || page.events.length === 0) break;
    after = page.events[page.events.length - 1]!.seq;
  }
}

/** Delete the engine's files for a run: its state, event log and lock. It takes the run's lease
 *  first, as the engine does, and returns false when another process holds it. */
export function removeEngineRun(paths: HomePaths, runId: string): boolean {
  const engine = enginePersistence(paths);
  const lease = engine.acquireRunLease(runId);
  if (!lease) return false;
  try {
    return engine.delete(runId);
  } finally {
    engine.releaseRunLease(lease);
  }
}

/** Delete a run's record, workflow snapshot, step stop requests and logs. removeEngineRun deletes the engine's files. */
export function removeRunFiles(paths: HomePaths, record: RunRecord): void {
  // The engine keeps its own copy of the log, in a folder named after where the run worked.
  const engineLogs = workflowProjectPaths(record.cwd, { persistenceRoot: paths.runs });
  const files = [recordFile(paths, record.runId), snapshotFile(paths, record.runId), stopRequestFile(paths, record.runId), logFile(paths, record.runId), join(engineLogs.runsDir, `${record.runId}.log`)];
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

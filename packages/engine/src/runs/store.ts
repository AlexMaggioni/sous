// Where a run's files live, plain reads of its engine files, the engine's persistence for the
// worker's manager, and the delete of a run that is forgotten. Only removeEngineRun and
// removeRunFiles write, and no manager is built.

import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { workflowProjectPaths } from "./persistence/project-paths.js";
import { createRunPersistence, loadRunState, type FsLayer, type PersistedRunState } from "./persistence/run-persistence.js";
import type { RunEventPersistence } from "./persistence/run-event-persistence.js";
import type { HomePaths } from "./home.js";
import { snapshotFile, type RunRecord } from "./records.js";

/** The file calls the store reads through. Tests hand it one that counts the calls. */
export type StoreFs = Pick<FsLayer, "existsSync" | "readdirSync" | "readFileSync">;

const DISK: StoreFs = { existsSync, readdirSync, readFileSync };

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

/** Delete a run's record, workflow snapshot and logs. removeEngineRun deletes the engine's files. */
export function removeRunFiles(paths: HomePaths, record: RunRecord): void {
  // The engine keeps its own copy of the log, in a folder named after where the run worked.
  const engineLogs = workflowProjectPaths(record.cwd, { persistenceRoot: paths.runs });
  const files = [join(paths.records, `${record.runId}.json`), snapshotFile(paths, record.runId), logFile(paths, record.runId), join(engineLogs.runsDir, `${record.runId}.log`)];
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

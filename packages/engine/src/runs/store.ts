// Plain reads of a run's engine files. Nothing here writes, and no manager is built.

import { workflowProjectPaths } from "./persistence/project-paths.js";
import { createRunPersistence, loadRunState, type PersistedRunState } from "./persistence/run-persistence.js";
import type { HomePaths } from "./home.js";

/** The engine's folders for orc's runs. Every orc manager works from the home folder, so the
 *  folders do not depend on the run's project. */
function engineFolders(paths: HomePaths) {
  return workflowProjectPaths(paths.home, { persistenceRoot: paths.runs });
}

/** The run's state as the engine last saved it. A run left running by a worker that died still
 *  reads "running": the pause rule says what that means. */
export function readState(paths: HomePaths, runId: string): PersistedRunState | undefined {
  const { runsDir, legacyRunsDir } = engineFolders(paths);
  return loadRunState(runsDir, legacyRunsDir, runId) ?? undefined;
}

/** An event the engine saved, with when it saved it. */
export interface SavedEvent {
  event: Record<string, unknown>;
  timestamp: string;
}

/** Each event saved after `seq`, in order. Throws when the run has no event log. */
export function readEventsAfter(paths: HomePaths, runId: string, seq: number, visit: (saved: SavedEvent) => void): void {
  // Built on each call: the store writes nothing until something saves through it.
  const events = createRunPersistence(paths.home, undefined, { persistenceRoot: paths.runs });
  let after = seq;
  for (;;) {
    const page = events.readEvents(runId, { after, limit: 1000 });
    for (const { event, timestamp } of page.events) visit({ event: event as unknown as Record<string, unknown>, timestamp });
    if (!page.hasMore || page.events.length === 0) break;
    after = page.events[page.events.length - 1]!.seq;
  }
}

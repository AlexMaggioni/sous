// Where a manager keeps a run's files, for tests that look at them on disk.

import { join } from "node:path";
import { readJsonFile } from "../../src/json-file.js";
import { workflowProjectPaths } from "../../src/runs/persistence/project-paths.js";

/** The folder of a manager's run files, for its cwd and persistence root. */
export function runsDir(cwd: string, persistenceRoot?: string): string {
  return workflowProjectPaths(cwd, { persistenceRoot }).runsDir;
}

/** The pid in a run's lock file, or undefined when no process holds the run. */
export function lockOwnerPid(cwd: string, persistenceRoot: string | undefined, runId: string): number | undefined {
  return readJsonFile<{ pid?: number }>(join(runsDir(cwd, persistenceRoot), `${runId}.lock`))?.pid;
}

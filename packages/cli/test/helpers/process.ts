// Processes a test plants in a run's files.

import { spawnSync } from "node:child_process";

/** A pid that no process has now: a child that already ended. */
export function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

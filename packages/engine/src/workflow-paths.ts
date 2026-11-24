/**
 * The workflow home: where the engine keeps its state for the user. Each project's run folders
 * under it are in runs/persistence/project-paths.ts.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const WORKFLOW_HOME_RELATIVE_DIR = ".sous/engine";

export interface WorkflowPathOptions {
  /** Absolute workflow persistence root. When omitted, the home default (`~/.sous/engine`). */
  persistenceRoot?: string;
}

export function workflowHomeDir(options: WorkflowPathOptions = {}): string {
  if (options.persistenceRoot === undefined) return join(homedir(), WORKFLOW_HOME_RELATIVE_DIR);
  if (!isAbsolute(options.persistenceRoot)) throw new Error("persistenceRoot must be an absolute path");
  return options.persistenceRoot;
}

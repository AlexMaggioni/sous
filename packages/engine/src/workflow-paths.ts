/**
 * The workflow home: where the engine keeps its state for the user. Each project's run folders
 * under it are in runs/persistence/project-paths.ts.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const WORKFLOW_HOME_RELATIVE_DIR = ".orchestrator/engine";
export const ORCHESTRATOR_PERSISTENCE_ROOT_ENV = "ORCHESTRATOR_PERSISTENCE_ROOT";

export interface WorkflowPathOptions {
  /**
   * Absolute workflow persistence root. When omitted, ORCHESTRATOR_PERSISTENCE_ROOT
   * wins over the homedir default (`~/.orchestrator/engine`).
   */
  persistenceRoot?: string;
  /** Injectable env map for tests; production callers use process.env. */
  env?: Record<string, string | undefined>;
}

export function workflowHomeDir(options: WorkflowPathOptions = {}): string {
  return resolveWorkflowHomeDir(options);
}

function resolveWorkflowHomeDir(options: WorkflowPathOptions): string {
  // Precedence is explicit option > env fallback > historical homedir default.
  if (options.persistenceRoot !== undefined) return validatePersistenceRoot(options.persistenceRoot, "persistenceRoot");

  const envRoot = (options.env ?? process.env)[ORCHESTRATOR_PERSISTENCE_ROOT_ENV];
  if (envRoot !== undefined && envRoot.trim() !== "") {
    return validatePersistenceRoot(envRoot, ORCHESTRATOR_PERSISTENCE_ROOT_ENV);
  }

  return join(homedir(), WORKFLOW_HOME_RELATIVE_DIR);
}

function validatePersistenceRoot(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

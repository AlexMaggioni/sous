// The workflow texts of one run, for the page sous serve opens: the text the run runs, the texts
// of the saved workflows it started inside itself, and which of them changed since it started.
// It only reads.

import type { HomePaths } from "./home.js";
import { loadSnapshot, type RunRecord } from "./records.js";
import { changedWorkflows } from "./run.js";
import { readState } from "./store.js";

export interface RunTexts {
  /** The text the run runs. Unset while the run has no state. */
  script?: string;
  /** The nested workflows' texts as they were when the run started, by workflow name. */
  workflows: Record<string, string>;
  /** The workflows edited since the run started, as `sous resume` sees them. */
  changed: string[];
}

/** The texts of a run. A workflow folder that can't be read leaves `changed` empty. */
export function runTexts(paths: HomePaths, record: RunRecord): RunTexts {
  const state = readState(paths, record.runId);
  let changed: string[] = [];
  try {
    if (state) changed = changedWorkflows(paths, record, state);
  } catch {
    // The resume makes the caller choose once it can read the folders.
  }
  return { ...(state ? { script: state.script } : {}), workflows: loadSnapshot(paths, record.runId), changed };
}

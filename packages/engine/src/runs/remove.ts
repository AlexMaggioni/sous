// The two removals of the page `sous serve` opens: one run that ended, and one saved workflow,
// whose file goes to <home>/trash/. Each records its action. sous prune removes the same runs by
// age, and this removes one by its id.

import { basename } from "node:path";
import type { Removed } from "../catalog/types.js";
import { findSavedWorkflow } from "../workflows/dir.js";
import { recordAction, type Who } from "./actions.js";
import { moveToTrash, type HomePaths } from "./home.js";
import { Refusal } from "./refusal.js";
import { forgetRun, readRun, startedAndUnfinished, workerRuns } from "./run.js";

/**
 * Remove one run that ended: its saved state, its record, its workflow snapshot, its logs and its
 * open questions. Its worktrees stay. It removes the runs sous prune removes: one that completed,
 * failed or stopped, and one that never started and has no worker. Anything else is refused.
 */
export function removeRun(paths: HomePaths, runId: string, who: Who): Removed {
  const run = readRun(paths, runId);
  const id = run.record.runId;
  if (workerRuns(run)) {
    throw new Refusal("run_is_running", `${id} is running, so it can't be removed.`, "Stop the run, then remove it.", `sous stop ${id} --json`);
  }
  if (startedAndUnfinished(run)) {
    throw new Refusal("run_not_ended", `${id} is ${run.word}, and only a run that ended can be removed.`, "Stop the run, then remove it.", `sous stop ${id} --json`);
  }
  if (!forgetRun(paths, run.record)) {
    throw new Refusal("run_is_running", `${id} is held by another process, which may run it now.`, "Look at the run again, then remove it once it has ended.", `sous show ${id} --json`);
  }
  recordAction(paths, { act: "remove-run", ...who, runId: id, workflow: run.record.workflow });
  return { removed: id };
}

/**
 * Move a saved workflow's file to <home>/trash/, the project's first, as the name finds it. A file
 * that does not parse goes too. The trash never replaces a file, so a second workflow of the same
 * name goes in as name-2. Its runs stay.
 */
export function trashWorkflow(paths: HomePaths, projectDir: string, name: string, who: Who): Removed {
  let file: string;
  try {
    file = findSavedWorkflow(paths, projectDir, name).file;
  } catch (error) {
    if (error instanceof Refusal && error.code === "no_such_workflow") {
      throw new Refusal(error.code, error.message, "Give the name of a saved workflow. A path is not one.", error.call);
    }
    throw error;
  }
  const trash = moveToTrash(paths, file);
  // The line keeps the name in the trash alone. recordAction hides a path with a part that looks
  // like a token, such as a temp folder's, so a whole path could come out as "[REDACTED].js".
  recordAction(paths, { act: "trash-workflow", ...who, workflow: name, value: basename(trash) });
  return { removed: file, trash };
}

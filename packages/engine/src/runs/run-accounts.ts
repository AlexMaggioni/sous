// The account changes that look at sous's runs: `sous account use` moves the runs waiting at a
// usage limit to the account it names, `sous account` lists them, and `sous account remove`
// refuses a login an unfinished run uses.

import { deleteAccount, DEFAULT, moveRunAccount, setCurrentAccount, type AccountName } from "../accounts.js";
import type { HarnessId } from "@sous-run/harnesses";
import { recordAction, type Who } from "./actions.js";
import type { HomePaths } from "./home.js";
import type { Launcher } from "./launch.js";
import { processAlive, type RunRecord } from "./records.js";
import { listRuns } from "./run.js";

/** A run that `sous account use` moved, or left waiting. */
export interface Moved {
  runId: string;
  workflow: string;
  from: string;
}

export interface UseResult extends AccountName {
  /** The runs moved to the account and resumed. */
  moved: Moved[];
  /** Runs waiting at the limit of this same account. They go on after the reset. */
  same: Moved[];
}

/**
 * Make the account sous's current one for its program. Then each run waiting at that program's
 * usage limit moves to it and resumes now, also the runs that agents started.
 */
export function useAccount(paths: HomePaths, spec: string, launch: Launcher, who: Who): UseResult {
  const { program, name } = setCurrentAccount(paths, spec);
  recordAction(paths, { act: "account-use", ...who, value: `${program}/${name}` });
  const moved: Moved[] = [];
  const same: Moved[] = [];
  for (const run of waitingRuns(paths)) {
    if (run.program !== program) continue;
    const entry = { runId: run.runId, workflow: run.workflow, from: run.account };
    if (run.account === name) {
      same.push(entry);
      continue;
    }
    moveRunAccount(paths, run.runId, program, name);
    launch(paths, run.runId, "resume");
    moved.push(entry);
  }
  return { program, name, moved, same };
}

/** A run waiting at a usage limit. */
export interface WaitingRun {
  runId: string;
  workflow: string;
  program: HarnessId;
  /** The account whose limit the run hit. A run from before the record kept the limit names its
   *  own account, or default. */
  account: string;
  limit?: RunRecord["limit"];
}

/** The runs waiting at a usage limit, newest first: their worker is gone and they paused there.
 *  `sous account` lists them, and `sous account use` moves them. */
export function waitingRuns(paths: HomePaths): WaitingRun[] {
  const waiting: WaitingRun[] = [];
  for (const { record, pause } of listRuns(paths)) {
    if (processAlive(record.pid) || pause?.reason !== "usage_limit") continue;
    // A run from before accounts, or one whose program is unknown, counts as waiting on Claude Code.
    const program = record.limit?.program ?? "claude";
    const account = record.limit?.account ?? record.accounts?.[program]?.name ?? DEFAULT;
    waiting.push({ runId: record.runId, workflow: record.workflow, program, account, limit: record.limit });
  }
  return waiting;
}

/** Forget a login. Refused while an unfinished run uses it, also one that has not started yet. */
export function removeAccount(paths: HomePaths, spec: string): AccountName {
  const unfinished = listRuns(paths).filter((run) => run.unfinished).map((run) => run.record);
  return deleteAccount(paths, spec, unfinished);
}

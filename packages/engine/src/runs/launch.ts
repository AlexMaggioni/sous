// Start a run: find the workflow, check its inputs, make its place, write its record, and
// start its worker through a launcher. Used by `sous run`, `sous rerun` and the schedules.

import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { generateRunId } from "./persistence/run-persistence.js";
import { resolveWorkflow } from "../workflows/dir.js";
import { checkInputs } from "../workflows/meta.js";
import { preparePlace } from "../places/places.js";
import { loadConfig, rememberProject, type HomePaths, type Place } from "./home.js";
import { accountsForRun } from "../accounts.js";
import { saveRecord, updateRecord, type RunRecord } from "./records.js";
import { logFile } from "./store.js";
import type { Priority } from "./slots.js";
import { Refusal } from "./refusal.js";
import { recordAction, type Who } from "./actions.js";
import { letAgentAnswerBy, mayStart } from "./consent.js";

export interface CreateRunRequest {
  workflow: string;
  projectDir: string;
  inputs: Record<string, unknown>;
  place?: Place;
  priority?: Priority;
  origin?: RunRecord["origin"];
  schedule?: string;
  overrides?: Record<string, Record<string, unknown>>;
  defaultModel?: string;
  concurrency?: number;
  rerunOf?: string;
  /** Reuse the results of this run's steps that did not change. The new run works in its place. */
  reuseFrom?: RunRecord;
  /** The run whose agent asks for this one, when an agent starts it. */
  startedByRun?: string;
  /** Set when a Claude Code session starts the run. Its Claude Code steps then use that session's login. */
  caller?: boolean;
  /** Who starts the run. A start is recorded as run, or rerun with rerunOf. A dry run records nothing. */
  who: Who;
  /** The command the person types to start the run, for a refusal. Default: sous run and the workflow. */
  command?: string;
  /** --let-agent-answer: agents may answer the run's people questions. Only the person sets it. */
  letAgentAnswer?: boolean;
}

export class InputProblems extends Error {
  constructor(readonly workflow: string, readonly problems: string[]) {
    super(`${workflow} cannot start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

/** Check the request and write the run's record. Nothing runs yet. */
export function createRun(paths: HomePaths, request: CreateRunRequest): RunRecord {
  const resolved = resolveWorkflow(paths, request.projectDir, request.workflow);
  const checked = checkInputs(resolved.extras, request.inputs);
  const args = checked.args;
  const problems = [...(resolved.extras.metaProblems ?? []), ...checked.problems];
  // A problem in the workflow's own meta is no wrong input, so the file must change.
  if (resolved.extras.metaProblems?.length) {
    const message = new InputProblems(resolved.name, problems).message;
    throw new Refusal("workflow_invalid", message, `Fix the workflow file ${resolved.file}.`, `sous check ${resolved.name} --json`);
  }
  if (problems.length) throw new InputProblems(resolved.name, problems);
  mayStart(resolved, request.who, request.command ?? `sous run ${resolved.name}`);
  const letAgentAnswer = request.letAgentAnswer ? letAgentAnswerBy(request.who, request.command ?? `sous run ${resolved.name} --let-agent-answer`) : undefined;
  const config = loadConfig(paths);
  const runId = generateRunId();
  const reuse = request.reuseFrom;
  // A run that reuses another's results needs that run's files too, so it works where it did.
  const place = reuse ? reuse.place : (request.place ?? resolved.extras.place ?? config.defaultPlace);
  const prepared = reuse
    ? { cwd: reuse.cwd, ...(reuse.worktree ? { worktree: reuse.worktree, branch: reuse.branch } : {}) }
    : preparePlace(paths, place, runId, request.projectDir);
  const record: RunRecord = {
    runId,
    workflow: resolved.name,
    file: resolved.file,
    args,
    place,
    cwd: prepared.cwd,
    projectDir: request.projectDir,
    ...(prepared.worktree ? { worktree: prepared.worktree, branch: prepared.branch } : {}),
    priority: request.priority ?? "user",
    origin: request.origin ?? "cli",
    ...(request.schedule ? { schedule: request.schedule } : {}),
    createdAt: new Date().toISOString(),
    ...(request.overrides && Object.keys(request.overrides).length ? { overrides: request.overrides } : {}),
    ...(request.defaultModel ? { defaultModel: request.defaultModel } : {}),
    ...((request.concurrency ?? resolved.extras.concurrency) ? { concurrency: request.concurrency ?? resolved.extras.concurrency } : {}),
    ...(resolved.extras.timeout ? { timeout: resolved.extras.timeout } : {}),
    ...(request.rerunOf ? { rerunOf: request.rerunOf } : {}),
    ...(reuse ? { reuseFrom: reuse.runId } : {}),
    ...(request.startedByRun ? { startedByRun: request.startedByRun } : {}),
    through: request.who.through,
    ...(letAgentAnswer ? { letAgentAnswer } : {}),
    accounts: accountsForRun(paths, process.env, { caller: request.caller, parentRunId: request.startedByRun }),
  };
  saveRecord(paths, record);
  rememberProject(paths, request.projectDir);
  if (record.origin !== "check") recordAction(paths, { act: request.rerunOf ? "rerun" : "run", ...request.who, runId, workflow: resolved.name });
  if (letAgentAnswer && record.origin !== "check") recordAction(paths, { act: "let-agent-answer", ...request.who, runId, workflow: resolved.name });
  return record;
}

/**
 * Starts the worker of a run whose record is written. The worker notes its process in the
 * record. sous starts it as a process of its own with workerProcess. Tests pass their own.
 */
export type Launcher = (paths: HomePaths, runId: string, mode: "start" | "resume") => void;

/** The worker as a process of its own, in the background, as sous starts it. `cliFile` gives sous's
 *  built cli.js. It is read only when a worker starts. */
export function workerProcess(cliFile: () => string): Launcher {
  return (paths, runId, mode) => updateRecord(paths, runId, { pid: spawnWorker(paths, cliFile(), runId, mode) });
}

/** Start the run's worker in the background. Its output goes to logs/<run id>.log. */
function spawnWorker(paths: HomePaths, cliFile: string, runId: string, mode: "start" | "resume"): number {
  const out = openSync(logFile(paths, runId), "a");
  try {
    const child = spawn(process.execPath, [cliFile, "_worker", runId, mode], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, SOUS_HOME: paths.home },
    });
    child.unref();
    return child.pid!;
  } finally {
    closeSync(out);
  }
}

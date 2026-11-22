// Changing a run: stop it or one of its steps, pause, resume, run it again, answer it, and
// delete its worktrees. orc parses the command and prints what these return.

import { existsSync, readFileSync } from "node:fs";
import type { PersistedRunState } from "./persistence/run-persistence.js";
import { removeWorktree, runWorktrees } from "../places/places.js";
import type { HomePaths, Place } from "./home.js";
import { listQuestions, normalizeAnswer, readQuestion, removeRunQuestions, writeAnswer, type Question } from "./inbox.js";
import { createRun, startWorker } from "./launch.js";
import { findRecord, loadSnapshot, processAlive, updateRecord, type RunRecord } from "./records.js";
import { stateOf, runningSteps } from "./view.js";
import { currentWorkflows, managerFor } from "./worker.js";

/** How a stop went. */
export type StopOutcome = "stopping" | "stopped" | "already-ended" | "never-started" | "held-elsewhere";

/** Stop a run. A running one gets SIGTERM; a paused one is marked stopped here. */
export function stopRun(paths: HomePaths, record: RunRecord): { outcome: StopOutcome; status?: string } {
  if (processAlive(record.pid)) {
    process.kill(record.pid!, "SIGTERM");
    return { outcome: "stopping" };
  }
  const result = managerFor(paths, record.projectDir).stopPersistedRun(record.runId);
  removeRunQuestions(paths, record.runId);
  if (result.outcome === "already-terminal") return { outcome: "already-ended", ...(result.state?.status ? { status: result.state.status } : {}) };
  if (result.outcome === "missing") return { outcome: "never-started" };
  if (result.outcome === "owned-elsewhere") return { outcome: "held-elsewhere" };
  return { outcome: "stopped" };
}

/** Stop one running step by its name in the log. The run pauses on it, and resume runs it again.
 *  Returns false when the run is not running. */
export function stopStep(paths: HomePaths, record: RunRecord, step: string): boolean {
  if (!processAlive(record.pid)) return false;
  const running = runningSteps(paths, record);
  if (!running.includes(step)) {
    const now = running.length ? `Running now: ${running.map((name) => `"${name}"`).join(", ")}.` : "No step runs now.";
    throw new Error(`no step named "${step}" runs in ${record.runId}. ${now}`);
  }
  updateRecord(paths, record.runId, { stopSteps: [...(record.stopSteps ?? []), step] });
  process.kill(record.pid!, "SIGUSR2");
  return true;
}

/** Pause a running run: steps already running finish, nothing new starts. False when it does not run. */
export function pauseRun(record: RunRecord): boolean {
  if (!processAlive(record.pid)) return false;
  process.kill(record.pid!, "SIGUSR1");
  return true;
}

/** The workflows of a run edited since it started: its own file, and the nested ones it used. */
export function changedWorkflows(paths: HomePaths, record: RunRecord, state: PersistedRunState): string[] {
  const snapshot = loadSnapshot(paths, record.runId);
  const current = currentWorkflows(paths, record.projectDir);
  const used = new Set(Object.values(record.nested ?? {}).map((child) => child.workflow));
  return [
    ...(existsSync(record.file) && readFileSync(record.file, "utf8") !== state.script ? [record.workflow] : []),
    ...[...used].filter((name) => name !== record.workflow && snapshot[name] !== undefined && current[name] !== snapshot[name]),
  ];
}

/** Check a run can resume. Returns the workflows edited since it started, which reach it only
 *  when the user says so. */
export function resumeCheck(paths: HomePaths, record: RunRecord): string[] {
  if (processAlive(record.pid)) throw new Error(`${record.runId} is running already`);
  const state = stateOf(paths, record);
  if (!state) throw new Error(`${record.runId} never started. orc rerun ${record.runId} starts it fresh.`);
  if (state.status === "completed") throw new Error(`${record.runId} completed. orc rerun ${record.runId} runs it again.`);
  if (state.status === "aborted") throw new Error(`${record.runId} was stopped. orc rerun ${record.runId} starts it again.`);
  return changedWorkflows(paths, record, state);
}

/** Resume a run in a new worker. With `latest`, it takes the edited workflows. */
export function resumeRun(paths: HomePaths, cliFile: string, record: RunRecord, latest: boolean): void {
  if (latest) updateRecord(paths, record.runId, { resumeLatest: true });
  startWorker(paths, cliFile, record.runId, "resume");
}

/** Check an earlier run can be run again with its unchanged steps reused. */
export function reuseCheck(paths: HomePaths, old: RunRecord): void {
  const state = stateOf(paths, old);
  if (processAlive(old.pid) || state?.status === "running" || state?.status === "pending") throw new Error(`${old.runId} is still running. orc stop ${old.runId} first.`);
  if (state?.status === "paused") throw new Error(`${old.runId} is paused. orc resume ${old.runId} takes your edits and keeps the finished steps.`);
}

export interface RerunRequest {
  place: Place;
  /** Reuse the earlier run's unchanged steps. */
  reuse?: boolean;
  /** Inputs that replace the earlier run's. */
  inputs?: Record<string, unknown>;
  /** Step changes added to the earlier run's. */
  overrides?: Record<string, Record<string, unknown>>;
  defaultModel?: string;
  startedByRun?: string;
  caller?: boolean;
}

/** Start an earlier run again as a new run, with its inputs, step changes and model. */
export function rerun(paths: HomePaths, cliFile: string, old: RunRecord, request: RerunRequest): RunRecord {
  const defaultModel = request.defaultModel ?? old.defaultModel;
  const record = createRun(paths, {
    ...(request.reuse ? { reuseFrom: old } : {}),
    workflow: old.file,
    projectDir: old.projectDir,
    inputs: { ...old.args, ...request.inputs },
    place: request.place,
    origin: "rerun",
    rerunOf: old.runId,
    ...(old.overrides || request.overrides ? { overrides: { ...old.overrides, ...request.overrides } } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(old.concurrency ? { concurrency: old.concurrency } : {}),
    ...(request.startedByRun ? { startedByRun: request.startedByRun } : {}),
    caller: request.caller === true,
  });
  startWorker(paths, cliFile, record.runId, "start");
  return record;
}

/** An open question by its id, a unique start of it, or the run that asks only it. */
export function findQuestion(paths: HomePaths, id: string): Question {
  const exact = readQuestion(paths, id);
  if (exact) return exact;
  const all = listQuestions(paths);
  const byPrefix = all.filter((q) => q.id.startsWith(id));
  if (byPrefix.length === 1) return byPrefix[0]!;
  const record = findRecord(paths, id);
  if (record) {
    const forRun = all.filter((q) => q.runId === record.runId);
    if (forRun.length === 1) return forRun[0]!;
    if (forRun.length > 1) throw new Error(`run ${record.runId} asks ${forRun.length} questions. Name one: ${forRun.map((q) => q.id).join(", ")}`);
    throw new Error(`run ${record.runId} asks nothing right now`);
  }
  throw new Error(`no open question "${id}". orc inbox lists them.`);
}

/** A reply to a breakpoint: approve, stop, or a note that sends the work back. */
export function breakpointValue(reply: string): unknown {
  const lower = reply.trim().toLowerCase();
  if (lower === "" || lower === "approve" || lower === "yes" || lower === "ok") return "approve";
  if (lower === "stop") return "stop";
  return { decision: "send back", note: reply.replace(/^send[ -]back\s*:?\s*/i, "").trim() };
}

export type AnswerKind = "answer" | "approve" | "send-back";

/** The value a reply gives a question, or what is wrong with the command when it does not fit. */
export function answerValue(question: Question, kind: AnswerKind, text: string, json = false): { value: unknown } | { usage: string } {
  if (kind === "approve") return { value: question.breakpoint ? "approve" : question.kind === "confirm" ? true : "approve" };
  if (kind === "send-back") {
    if (!question.breakpoint) return { usage: `${question.id} is not a breakpoint. Use orc answer ${question.id} "..."` };
    if (!text) return { usage: `orc send-back ${question.id} "what to change"` };
    return { value: { decision: "send back", note: text } };
  }
  if (!text && question.kind !== "confirm") return { usage: `orc answer ${question.id} "your answer"` };
  const value = question.breakpoint ? breakpointValue(text) : json ? parseJson(text) : normalizeAnswer(question, text);
  if (question.kind === "select" && question.choices && !question.choices.includes(value as string)) {
    return { usage: `answer one of: ${question.choices.join(", ")}` };
  }
  return { value };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Write the answer. Returns whether the run still runs, so it reads the answer now. */
export function answerQuestion(paths: HomePaths, question: Question, value: unknown): boolean {
  writeAnswer(paths, question, value);
  return processAlive(findRecord(paths, question.runId)?.pid);
}

/** A stopped run's worktrees. With `remove`, deletes each branch and folder and calls `deleted`
 *  after each. */
export function discardRun(paths: HomePaths, record: RunRecord, options: { remove?: boolean; deleted?: (tree: { dir: string; branch: string }) => void } = {}): Array<{ dir: string; branch: string }> {
  if (processAlive(record.pid)) throw new Error(`${record.runId} is running. orc stop ${record.runId} first.`);
  const trees = runWorktrees(record);
  if (options.remove) {
    for (const tree of trees) {
      removeWorktree(record.projectDir, tree.dir, tree.branch);
      options.deleted?.(tree);
    }
  }
  return trees;
}

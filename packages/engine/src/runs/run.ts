// sous's runs. The reads: the list of runs, one run, its steps, its questions, and the wait for it
// to end. The requests: start, stop, stop a step, pause, resume, run again, answer, discard the
// worktrees, forget and prune, and the account changes that look at the runs. Callers get views
// and never open a run file. A read writes nothing.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { interruptedReason, type PersistedRunState, type RunStatus } from "./persistence/run-persistence.js";
import { gcWorktrees, removeWorktree, runWorktrees, type GcResult } from "../places/places.js";
import { recordAction, type Who } from "./actions.js";
import { recordAndTell, type Tell } from "./notify.js";
import type { HomePaths, Place } from "./home.js";
import { decisionOf, listQuestions, questionView, readQuestion, removeRunQuestions, reply, triedOf, type Misfit, type Question, type QuestionView, type Reply } from "./inbox.js";
import { answerCalls, letAgentAnswerBy, mayAnswer } from "./consent.js";
import { createRun, type CreateRunRequest, type Launcher } from "./launch.js";
import { findRecord, isRunId, listRecords, loadRecord, loadSnapshot, processAlive, requestNote, requestPause, requestStepStop, scopePrefix, updateRecord, type NoteRequest, type RunRecord } from "./records.js";
import { liveSteps, withTries, type RunningStep, type Step } from "./live-steps.js";
import { olderSave } from "../older-save.js";
import { readWorkflowScript } from "../workflows/script.js";
import { resolveWorkflow } from "../workflows/dir.js";
import { needApproval, NotApproved } from "./approval-check.js";
import { workflowHash } from "./approvals.js";
import { Refusal } from "./refusal.js";
import { judge, type ResumeRefusal, type ReuseRefusal, type Verdict } from "./rule.js";
import { logFile, readState, readStates, removeEngineRun, removeRunFiles, type StoreFs } from "./store.js";
import { currentWorkflows, stopColdRun } from "./worker.js";

/** A question a run asks, as the inbox holds it. */
export type RunQuestion = Question;

/** What the run's saved state says, as sous shows it. A run left pending or running by a worker
 *  that died shows as paused "interrupted", the way `sous resume` saves it before it goes on. */
export interface SavedFacts {
  status: RunStatus;
  pauseReason?: string;
  resetHint?: string;
  /** The engine's text for a failure, a pause or a lost worker. */
  reason?: string;
  /** The run's tokens and cost so far, and how long it ran, as the state saved them. */
  tokens?: number;
  cost?: number;
  durationMs?: number;
}

/** A run as sous's readers see it: its record, what the pause rule says of it, and its open
 *  questions. */
export interface RunView extends Verdict {
  runId: string;
  record: RunRecord;
  questions: RunQuestion[];
  /** Unset while the run has no state. */
  saved?: SavedFacts;
  /** When the state last changed: the end, else the pause, else the last save. Unset while the
   *  run has no state. */
  changedAt?: string;
}

/** A run with its steps, for sous show. */
export interface RunDetail extends RunView {
  /** The steps in the order they started. While the worker runs, the steps the event log has
   *  since the last save are in it too. */
  steps: Step[];
  /** The steps that run now, by the name the log gives them: the label for a top-level step,
   *  and "Nested label / Inner label: step label" for a step of a nested run. Empty once no
   *  worker runs. */
  running: string[];
  /** What the run returned. Set once it completed. */
  result?: unknown;
  tokens?: number;
  durationMs?: number;
  /** The saved state with the steps above, without the script and the journals. sous show
   *  --full --json prints it. */
  engineState?: Omit<PersistedRunState, "script" | "journal" | "nestedJournal" | "calls">;
  failure?: Failure;
}

/** The step that failed and what it said, on a failed run or a run paused at a failed step. */
export interface Failure {
  step?: string;
  message: string;
}

export type { QuestionView };

/** The short view of a run, what sous show --json prints. */
export interface ShortRun {
  runId: string;
  workflow: string;
  status: Verdict["status"];
  word: string;
  cwd: string;
  branch?: string;
  worktree?: string;
  startedAt: string;
  seconds?: number;
  tokens: number;
  /** Why the run paused, and the tokens one go may spend when it has a budget, as wait gives them. */
  pauseReason?: string;
  budget?: number;
  steps: Array<{ label: string; status: string; seconds?: number; tokens?: number }>;
  questions: QuestionView[];
  failure?: Failure;
  /** When the service resumes a run paused at a usage limit. */
  resumesAt?: string;
  /** A dry run, from sous check --dry-run. It never resumes: the check runs it again. */
  dryRun?: true;
}

/** What a run that starts may cost, from the workflow's text and its last runs. */
export interface RunPreview {
  /** The ask(), breakpoint() and checkpoint() calls in the workflow's text. */
  asks: number;
  /** The workflow's last completed runs, at most five: how many, and their mean seconds and tokens. */
  lastRuns: { count: number; seconds: number; tokens: number };
}

/** How many of the workflow's last runs the preview reads, and how many completed ones it counts. */
const PREVIEW_READS = 20;
const PREVIEW_RUNS = 5;

/** The failure of a failed run or a run paused at a failed step: the last step in error, when
 *  the run's reason is that step's error. Otherwise only the run's reason. A worker that refused
 *  to run the workflow's text gives why first. */
function failureOf(record: RunRecord, state: PersistedRunState | undefined, steps: readonly Step[]): Failure | undefined {
  if (record.refused) return { message: record.refused };
  if (state?.status !== "failed" && !(state?.status === "paused" && state.pauseReason === "step_failed")) return undefined;
  const step = [...steps].reverse().find((agent) => agent.status === "error");
  const { reason } = state;
  const ours = step?.error !== undefined && (reason === undefined || reason.includes(step.error) || step.error.includes(reason) || reason.includes(`"${step.label}"`));
  if (ours) return { step: step.label, message: step.error! };
  return { message: reason ?? step?.error ?? "the run failed" };
}

const secondsOf = (ms: number) => Math.round(ms / 1000);

/** The state as sous shows it, given what the rule says of it. Nothing is written. */
function shownState(record: RunRecord, state: PersistedRunState | undefined, verdict: Verdict): PersistedRunState | undefined {
  if (!state || state.status === "paused" || verdict.pause?.reason !== "interrupted") return state;
  return { ...state, status: "paused", pauseReason: "interrupted", reason: interruptedReason(record.pid) };
}

function savedFacts(shown: PersistedRunState): SavedFacts {
  const { status, pauseReason, resetHint, reason, tokenUsage, durationMs } = shown;
  return {
    status,
    ...(pauseReason === undefined ? {} : { pauseReason }),
    ...(resetHint === undefined ? {} : { resetHint }),
    ...(reason === undefined ? {} : { reason }),
    ...(tokenUsage?.total === undefined ? {} : { tokens: tokenUsage.total }),
    ...(tokenUsage?.cost === undefined ? {} : { cost: tokenUsage.cost }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

/** The view of one run. The rule counts the questions only while the worker runs. */
function viewOf(record: RunRecord, state: PersistedRunState | undefined, questions: RunQuestion[], alive = processAlive(record.pid)): { view: RunView; shown: PersistedRunState | undefined } {
  const verdict = judge({ state, alive, openQuestions: alive ? questions.length : 0, older: state !== undefined && olderSave(state) !== undefined, dryRun: record.origin === "check" });
  const shown = shownState(record, state, verdict);
  return { view: { runId: record.runId, record, ...verdict, questions, ...(shown ? { saved: savedFacts(shown), changedAt: shown.completedAt ?? shown.pausedAt ?? shown.updatedAt } : {}) }, shown };
}

/** The run with this id or a unique start of it. */
function needRecord(paths: HomePaths, id: string): RunRecord {
  const record = findRecord(paths, id);
  if (!record) throw new Refusal("no_such_run", `no run "${id}". sous list shows the runs.`, "Give the id of a run, or a unique start of one.", "sous status --json");
  return record;
}

/**
 * sous's runs, newest first, or the newest `limit` of them. It reads the records, the engine
 * folder and the inbox once each, so its cost grows with the number of runs. The records option
 * saves the read of the records when the caller has them, newest first. `fs` is for tests.
 */
export function listRuns(paths: HomePaths, options: { limit?: number; fs?: StoreFs; records?: RunRecord[] } = {}): RunView[] {
  const records = options.records ?? listRecords(paths);
  const shown = options.limit === undefined ? records : records.slice(0, options.limit);
  const states = readStates(paths, shown.map((record) => record.runId), options.fs);
  const asked = new Map<string, RunQuestion[]>();
  for (const question of listQuestions(paths)) {
    const list = asked.get(question.runId);
    if (list) list.push(question);
    else asked.set(question.runId, [question]);
  }
  return shown.map((record) => viewOf(record, states.get(record.runId), asked.get(record.runId) ?? []).view);
}

/** One run, by its id or a unique start of it. Throws when no run has it. */
export function readRun(paths: HomePaths, id: string): RunView {
  const record = needRecord(paths, id);
  return viewOf(record, readState(paths, record.runId), listQuestions(paths, record.runId)).view;
}

/** One run with its steps, by its id or a unique start of it. */
export function runDetail(paths: HomePaths, id: string): RunDetail {
  const record = needRecord(paths, id);
  const state = readState(paths, record.runId);
  const alive = processAlive(record.pid);
  const { view, shown } = viewOf(record, state, listQuestions(paths, record.runId), alive);
  // The event log has the steps the worker did not save yet, and a killed worker never saves them.
  const live = state ? liveSteps(paths, record, state) : undefined;
  const steps = withTries(live?.steps ?? shown?.agents ?? [], shown?.calls, record.runId);
  let engineState: RunDetail["engineState"];
  if (shown) {
    const { script: _script, journal: _journal, nestedJournal: _nested, calls: _calls, ...rest } = shown;
    engineState = { ...rest, agents: steps };
  }
  return {
    ...view,
    steps,
    running: alive ? (live?.running.map((step) => step.name) ?? []) : [],
    ...(shown?.status === "completed" && shown.result !== undefined ? { result: shown.result } : {}),
    ...(shown?.tokenUsage ? { tokens: shown.tokenUsage.total } : {}),
    ...(shown?.durationMs === undefined ? {} : { durationMs: shown.durationMs }),
    ...(engineState ? { engineState } : {}),
    ...withFailure(failureOf(record, shown, steps)),
  };
}

const withFailure = (failure: Failure | undefined) => (failure ? { failure } : {});

/** The short view of a run, from its detail. A run a worker runs counts its seconds to `now`, a
 *  paused run to its pause, and an ended run with no saved duration to its last change. */
export function shortRun(run: RunDetail, now: Date): ShortRun {
  const { record } = run;
  const seconds = secondsOf(run.durationMs ?? spanOf(run, now));
  const steps = run.steps.map((step) => {
    const tokens = step.tokens ?? step.usage?.total;
    return {
      label: step.label,
      status: step.status,
      ...(step.startedAt && step.endedAt ? { seconds: secondsOf(Date.parse(step.endedAt) - Date.parse(step.startedAt)) } : {}),
      ...(tokens ? { tokens } : {}),
    };
  });
  return {
    runId: record.runId,
    workflow: record.workflow,
    status: run.status,
    word: run.word,
    cwd: record.cwd,
    ...placeOf(record),
    startedAt: record.createdAt,
    ...(Number.isNaN(seconds) ? {} : { seconds }),
    tokens: run.tokens ?? 0,
    ...(run.saved?.pauseReason ? { pauseReason: run.saved.pauseReason } : {}),
    ...(record.budget ? { budget: record.budget } : {}),
    steps,
    questions: run.questions.map((question) => questionView(question, record)),
    ...withFailure(run.failure),
    ...(run.pause?.resumeAt ? { resumesAt: run.pause.resumeAt.toISOString() } : {}),
    ...(record.origin === "check" ? { dryRun: true as const } : {}),
  };
}

/** How long a run with no saved duration ran, in ms: to now while a worker runs it, else to its
 *  pause or its last change. NaN when it has no state to tell. */
function spanOf(run: RunDetail, now: Date): number {
  const end = run.unfinished && !run.pause && run.status !== "not started" ? now.toISOString() : (run.engineState?.pausedAt ?? run.changedAt);
  return end === undefined ? Number.NaN : Date.parse(end) - Date.parse(run.record.createdAt);
}

/** The branch and worktree a run works in, when it has them. */
function placeOf(record: RunRecord): { branch?: string; worktree?: string } {
  return { ...(record.branch ? { branch: record.branch } : {}), ...(record.worktree ? { worktree: record.worktree } : {}) };
}

/** What a run that starts may ask and cost: the asks in its workflow's text, and its workflow's
 *  last completed runs, by the workflow's file. */
export function runPreview(paths: HomePaths, record: RunRecord): RunPreview {
  let asks = 0;
  try {
    asks = readWorkflowScript(readFileSync(record.file, "utf8")).refs.asks;
  } catch {
    // The worker reports a workflow that does not read. The preview counts no ask.
  }
  const earlier = listRecords(paths).filter((other) => other.file === record.file && other.runId !== record.runId).slice(0, PREVIEW_READS);
  const states = readStates(paths, earlier.map((other) => other.runId));
  const done = earlier.flatMap((other) => (states.get(other.runId)?.status === "completed" ? [states.get(other.runId)!] : [])).slice(0, PREVIEW_RUNS);
  const mean = (values: number[]) => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0);
  return { asks, lastRuns: { count: done.length, seconds: mean(done.map((state) => (state.durationMs ?? 0) / 1000)), tokens: mean(done.map((state) => state.tokenUsage?.total ?? 0)) } };
}

/** The open questions, oldest first: every run's, or one run's. */
export function runQuestions(paths: HomePaths, runId?: string): RunQuestion[] {
  return listQuestions(paths, runId);
}

/** What `sous wait --json` prints. Its status is the rule's, so a run at a question "asks". A
 *  completed run has its result twice: as today, and under review with where it worked. */
function runSummary(record: RunRecord, state: PersistedRunState | undefined, view: RunView): WaitSummary {
  const { questions } = view;
  const done = state?.status === "completed";
  return {
    runId: record.runId,
    workflow: record.workflow,
    status: view.status,
    ...(state?.pauseReason ? { pauseReason: state.pauseReason } : {}),
    ...(record.budget ? { budget: record.budget } : {}),
    ...(state?.resetHint ? { resetHint: state.resetHint } : {}),
    ...(state?.reason && !done ? { reason: state.reason } : {}),
    ...(questions.length ? { questions: questions.map((question) => questionView(question, record)) } : {}),
    cwd: record.cwd,
    ...(record.branch ? { branch: record.branch } : {}),
    ...(done ? { result: state.result, review: { ...placeOf(record), result: state.result } } : {}),
    ...withFailure(failureOf(record, state, state?.agents ?? [])),
    ...(view.pause?.resumeAt ? { resumesAt: view.pause.resumeAt.toISOString() } : {}),
    ...(record.origin === "check" ? { dryRun: true as const } : {}),
  };
}

/** What `sous wait --json` prints. */
export interface WaitSummary {
  runId: string;
  workflow: string;
  status: Verdict["status"];
  pauseReason?: string;
  /** The tokens one go of the run may spend, when it has a budget. */
  budget?: number;
  resetHint?: string;
  reason?: string;
  questions?: QuestionView[];
  cwd: string;
  branch?: string;
  result?: unknown;
  /** Set once the run completed: where it worked and what it returned. */
  review?: { branch?: string; worktree?: string; result: unknown };
  failure?: Failure;
  /** When the service resumes a run paused at a usage limit. */
  resumesAt?: string;
  /** A dry run, from sous check --dry-run. */
  dryRun?: true;
}

/** A piece of a run's log. */
export interface LogRead {
  runId: string;
  /** The log from the byte asked for to `end`. */
  text: string;
  end: number;
  /** Whether the run's worker ran just before the read. When it did not, `text` holds the rest
   *  of the log. */
  running: boolean;
}

/** A run's log from byte `from` on, by the run's id or a unique start of it. Throws when no run
 *  has it. It looks at the worker before it reads, so a read that says it ended is complete. */
export function readLog(paths: HomePaths, id: string, from = 0): LogRead {
  const record = needRecord(paths, id);
  const running = processAlive(record.pid);
  let text = "";
  const end = readLogFrom(logFile(paths, record.runId), from, (chunk) => (text = chunk));
  return { runId: record.runId, text, end, running };
}

/** Hand the log from `from` to `write`, and return where it ended. */
function readLogFrom(file: string, from: number, write: (text: string) => void): number {
  if (!existsSync(file)) return from;
  const size = statSync(file).size;
  if (size <= from) return from;
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    write(buffer.toString("utf8"));
  } finally {
    closeSync(fd);
  }
  return size;
}

export interface WaitHooks {
  /** The time, in ms since the epoch, after which the wait ends while the run goes on. */
  until?: number;
  /** Gets the log as it grows. */
  log?: (text: string) => void;
  /** Gets the questions the run asks, each once, and the wait goes on. Without it, the wait ends at them. */
  asks?: (questions: RunQuestion[], record: RunRecord) => Promise<void>;
}

export interface WaitEnd {
  /** The rule's exit code for how the wait ended. */
  code: number;
  summary: WaitSummary;
  /** Set when the wait ended at questions. */
  questions?: RunQuestion[];
  /** Set when the wait reached `until` while the run went on. */
  timedOut?: true;
}

/** Wait for a run to end, or to ask something the hooks do not answer. */
export async function waitForRun(paths: HomePaths, runId: string, hooks: WaitHooks = {}): Promise<WaitEnd> {
  const file = logFile(paths, runId);
  let offset = 0;
  const follow = () => {
    if (hooks.log) offset = readLogFrom(file, offset, hooks.log);
  };
  const asked = new Set<string>();
  for (;;) {
    follow();
    const record = findRecord(paths, runId);
    if (!record) throw new Error(`run ${runId} is gone`);
    if (!processAlive(record.pid)) {
      await new Promise((r) => setTimeout(r, 150));
      follow();
      const { view, shown } = viewOf(record, readState(paths, runId), listQuestions(paths, runId), false);
      // The rule gives every run with a gone worker an exit code.
      return { code: view.exit!, summary: runSummary(record, shown, view) };
    }
    const open = listQuestions(paths, runId).filter((q) => !asked.has(q.id));
    if (open.length) {
      if (!hooks.asks) {
        // Nothing was asked here, so these are all the run's questions.
        const { view, shown } = viewOf(record, readState(paths, runId), open, true);
        return { code: view.exit!, summary: runSummary(record, shown, view), questions: open };
      }
      for (const question of open) asked.add(question.id);
      await hooks.asks(open, record);
    }
    const left = hooks.until === undefined ? 400 : hooks.until - Date.now();
    if (left <= 0) {
      const { view, shown } = viewOf(record, readState(paths, runId), [], true);
      return { code: 0, summary: runSummary(record, shown, view), timedOut: true };
    }
    await new Promise((r) => setTimeout(r, Math.min(400, left)));
  }
}

// ── Requests ──

/** Check the request, write the run's record and start its worker. */
export function startRun(paths: HomePaths, launch: Launcher, request: CreateRunRequest): RunRecord {
  const record = createRun(paths, request);
  launch(paths, record.runId, "start");
  return record;
}

/** How a stop went. */
export type StopOutcome = "stopping" | "stopped" | "already-ended" | "never-started" | "held-elsewhere";

/** Stop a run. A running one gets SIGTERM. A paused one is marked stopped here. */
export function stopRun(paths: HomePaths, runId: string, who: Who): { outcome: StopOutcome; status?: RunStatus } {
  const record = needRecord(paths, runId);
  if (processAlive(record.pid)) {
    process.kill(record.pid!, "SIGTERM");
    recordAction(paths, { act: "stop", ...who, runId: record.runId });
    return { outcome: "stopping" };
  }
  const result = stopColdRun(paths, record);
  removeRunQuestions(paths, record.runId);
  if (result.outcome === "already-terminal") return { outcome: "already-ended", ...(result.state?.status ? { status: result.state.status } : {}) };
  if (result.outcome === "missing") return { outcome: "never-started" };
  if (result.outcome === "owned-elsewhere") return { outcome: "held-elsewhere" };
  recordAction(paths, { act: "stop", ...who, runId: record.runId });
  return { outcome: "stopped" };
}

/** Stop one running step by its name in the log. The run pauses on it, and resume runs it again.
 *  The worker gets the step's run or nested run and its call, so a step with the same label
 *  elsewhere goes on. Returns false when the run is not running, and refuses a name the run never had. */
export function stopStep(paths: HomePaths, runId: string, step: string, who: Who): boolean {
  const record = needRecord(paths, runId);
  const alive = processAlive(record.pid);
  const state = readState(paths, record.runId);
  const live = state ? liveSteps(paths, record, state) : { running: [] };
  // With no event log to read, the steps are the ones the state saved.
  const ran = (live.steps ?? state?.agents ?? []).some((agent) => `${scopePrefix(record.runId, typeof agent.scope === "string" ? agent.scope : undefined, record.nested)}${agent.label}` === step);
  const change = "Name a step that runs now, by the name sous log gives it.";
  // With no worker no step runs, so a step the run has stops nothing. A name it lacks is a typo.
  if (!alive) {
    if (ran) return false;
    throw new Refusal("no_such_step", `no step named "${step}" ran in ${record.runId}.`, change, `sous show ${record.runId} --json`);
  }
  const running = live.running;
  const calls = running.filter((call) => call.name === step).map(({ name: _name, ...call }) => call);
  if (!calls.length) {
    const now = running.length ? `Running now: ${running.map((call) => `"${call.name}"`).join(", ")}.` : "No step runs now.";
    const message = ran ? `"${step}" does not run now in ${record.runId}. ${now}` : `no step named "${step}" runs in ${record.runId}. ${now}`;
    throw new Refusal(ran ? "step_not_running" : "no_such_step", message, change, `sous show ${record.runId} --json`);
  }
  requestStepStop(paths, record.runId, { step, calls });
  process.kill(record.pid!, "SIGUSR2");
  recordAction(paths, { act: "stop-step", ...who, runId: record.runId, step });
  return true;
}

/** The calls that run now, as stopStep finds them. Empty when no worker runs. */
export function runningCalls(paths: HomePaths, runId: string): RunningStep[] {
  const record = needRecord(paths, runId);
  const state = readState(paths, record.runId);
  return processAlive(record.pid) && state ? liveSteps(paths, record, state).running : [];
}

/** Pause a running run: steps already running finish, nothing new starts. False when it does not run. */
export function pauseRun(paths: HomePaths, runId: string, who: Who): boolean {
  const record = needRecord(paths, runId);
  if (!processAlive(record.pid)) return false;
  requestPause(paths, record.runId);
  recordAction(paths, { act: "pause", ...who, runId: record.runId });
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

/** Why a resume changes nothing: the run runs, never started, completed or was stopped. */
export type ResumeWrongState = Exclude<ResumeRefusal, "older" | "dry-run">;

/** What resume says of a run in a state it does not resume from. */
const WRONG_STATE: Record<ResumeWrongState, (runId: string) => string> = {
  running: (runId) => `${runId} is running already, so there is nothing to resume.`,
  "never-started": (runId) => `${runId} never started, so there is nothing to resume. sous rerun ${runId} starts it fresh.`,
  completed: (runId) => `${runId} completed, so there is nothing to resume. sous rerun ${runId} runs it again.`,
  stopped: (runId) => `${runId} was stopped, so it does not resume. sous rerun ${runId} starts it again.`,
};

/** How a resume went: it started a worker, or the run is in a state that has nothing to resume,
 *  or the workflow changed and the caller must choose a version. Nothing changes in the last two.
 *  `refused` is the refusal this caller's --latest would get, such as not_approved. */
export type ResumeOutcome =
  | { resumed: RunRecord }
  | { wrongState: ResumeWrongState; view: RunView; message: string }
  | { mustChoose: string[]; message: string; refused?: NotApproved; broken?: string };

export interface ResumeOptions {
  choice?: "latest" | "same";
  letAgentAnswer?: { command: string };
  tell?: Tell;
  /** The most tokens this go and the ones after it may spend, in place of the run's. */
  budget?: number;
  /** The note for the worker, from the text the run goes on with. It may refuse, before any write. */
  note?: (script: string) => NoteRequest;
  /** The run as the caller read it just now, so the resume reads it once. */
  view?: RunView;
}

/**
 * Resume a run in a new worker. A workflow edited since the run started reaches it only by
 * choice: "latest" takes the edits, and "same" goes on with the version it started with. With
 * no choice, an edit makes the caller choose. A run an older sous saved is refused. With
 * `letAgentAnswer`, the person lets agents answer the run's people questions; `command` is the
 * resume the person types, for needs_person. `tell` sends that consent's notice. resumeWithNote
 * gives `note` the text the run goes on with: the one --latest checked, else the run's own. The
 * note it returns waits for the worker, and the resume line in events.jsonl holds it.
 */
export function resumeRun(paths: HomePaths, launch: Launcher, runId: string, who: Who, options: ResumeOptions = {}): ResumeOutcome {
  const { choice, letAgentAnswer } = options;
  const view = options.view ?? readRun(paths, runId);
  const { record, resume } = view;
  const consent = letAgentAnswer ? letAgentAnswerBy(who, letAgentAnswer.command, new Date()) : undefined;
  const why = resume.ok ? undefined : resume.why;
  if (why === "older") {
    const message = `${record.runId} was saved by an older sous, and this sous cannot resume it. sous rerun ${record.runId} starts it again, and sous stop ${record.runId} ends it.`;
    throw new Refusal("cannot_resume", message, "Start the run again with sous rerun, or end it with sous stop.", `sous rerun ${record.runId} --json`);
  }
  if (why === "dry-run") {
    const message = `${record.runId} is a dry run, and a dry run runs no step for real, so it does not resume. sous check ${record.workflow} --dry-run runs it again.`;
    throw new Refusal("cannot_resume", message, "Run the dry run again. To run the workflow for real, start it with sous run.", `sous check ${record.workflow} --dry-run --json`);
  }
  if (why) return { wrongState: why, view, message: WRONG_STATE[why](record.runId) };
  // The rule lets a run resume only once it has a state. The check runs with a choice too, so a
  // workflow folder that cannot be read stops the resume here.
  const state = readState(paths, record.runId)!;
  const changed = changedWorkflows(paths, record, state);
  if (changed.length && !choice) {
    const message =
      `${changed.join(", ")} changed since ${record.runId} started. ` +
      `sous resume ${record.runId} --latest takes the new version, and the finished steps that match stay done. ` +
      `sous resume ${record.runId} --same goes on with the version it started with.`;
    return { mustChoose: changed, message, ...latestRefusal(paths, record, who) };
  }
  // The edits reach a run that an agent resumes only once the person approved them.
  // The worker resumes only the text checked here, by its hash.
  const latest = choice === "latest" && existsSync(record.file) ? resolveWorkflow(paths, record.projectDir, record.file) : undefined;
  const note = options.note?.(latest ? latest.script : state.script);
  if (latest) needApproval(paths, record.projectDir, latest, who);
  const latestHash = latest ? workflowHash(latest.script) : undefined;
  const budget = options.budget ? { budget: options.budget } : {};
  if (choice === "latest" || consent || options.budget) updateRecord(paths, record.runId, { ...(choice === "latest" ? { resumeLatest: true, latestHash } : {}), ...(consent ? { letAgentAnswer: consent } : {}), ...budget });
  if (note) requestNote(paths, record.runId, note);
  launch(paths, record.runId, "resume");
  recordAction(paths, { act: "resume", ...who, runId: record.runId, ...budget, ...(note ? { text: note.text, ...(note.step ? { step: note.step.name } : {}) } : {}) });
  if (consent) recordAndTell(paths, { act: "let-agent-answer", ...who, runId: record.runId, workflow: record.workflow }, options.tell);
  return { resumed: record };
}

/** Why this caller's resume --latest would not go through now, checked as --latest checks it. A
 *  person's yes is not recorded here, only at their resume, but the check may seed the approvals
 *  file on its first use. `refused` is a missing yes, whose call shows the diff. `broken` is a new
 *  text that does not load, or another stop: no call works on it until the file is fixed. */
function latestRefusal(paths: HomePaths, record: RunRecord, who: Who): { refused?: NotApproved; broken?: string } {
  try {
    const latest = existsSync(record.file) ? resolveWorkflow(paths, record.projectDir, record.file) : undefined;
    if (latest && who.through.kind !== "person") needApproval(paths, record.projectDir, latest, who);
    return {};
  } catch (error) {
    if (error instanceof NotApproved) return { refused: error };
    const message = error instanceof Error ? error.message : String(error);
    return { broken: error instanceof Refusal ? message : `${record.file} does not parse: ${message}` };
  }
}

/** What rerun --reuse says when the rule refuses it. */
const REUSE_REFUSALS: Record<ReuseRefusal, (runId: string) => string> = {
  running: (runId) => `${runId} is still running. sous stop ${runId} first.`,
  paused: (runId) => `${runId} is paused. sous resume ${runId} takes your edits and keeps the finished steps.`,
  older: (runId) => `${runId} was saved by an older sous, and this sous cannot reuse its steps. sous rerun ${runId} without --reuse starts it again.`,
};

export interface RerunRequest {
  place: Place;
  /** Reuse the earlier run's unchanged steps. */
  reuse?: boolean;
  /** Inputs that replace the earlier run's. */
  inputs?: Record<string, unknown>;
  /** Step changes added to the earlier run's. */
  overrides?: Record<string, Record<string, unknown>>;
  defaultModel?: string;
  /** --budget. Default: the earlier run's budget. */
  budget?: number;
  startedByRun?: string;
  caller?: boolean;
  /** Who starts it again, and the command the person types when a people workflow refuses it. */
  who: Who;
  command?: string;
  /** --let-agent-answer. The earlier run's consent never carries over. `tell` sends its notice. */
  letAgentAnswer?: boolean;
  tell?: Tell;
}

/** Start an earlier run again as a new run, with its inputs, step changes and model. */
export function rerunRun(paths: HomePaths, launch: Launcher, runId: string, request: RerunRequest): RunRecord {
  const { record: old, reuse } = readRun(paths, runId);
  // A dry run's steps ran with stand-ins, so a real run never reuses them.
  if (request.reuse && old.origin === "check") {
    const message = `${old.runId} is a dry run, and its steps ran with stand-ins, so a real run does not reuse them. sous rerun ${old.runId} without --reuse starts it fresh, and sous check ${old.workflow} --dry-run runs the dry run again.`;
    throw new Refusal("cannot_resume", message, "Run the dry run again, or rerun it without --reuse.", `sous check ${old.workflow} --dry-run --json`);
  }
  if (request.reuse && !reuse.ok) throw new Error(REUSE_REFUSALS[reuse.why](old.runId));
  const defaultModel = request.defaultModel ?? old.defaultModel;
  const budget = request.budget ?? old.budget;
  return startRun(paths, launch, {
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
    ...(budget ? { budget } : {}),
    ...(request.startedByRun ? { startedByRun: request.startedByRun } : {}),
    caller: request.caller === true,
    who: request.who,
    command: request.command ?? `sous rerun ${old.runId}${request.letAgentAnswer ? " --let-agent-answer" : ""}`,
    ...(request.letAgentAnswer ? { letAgentAnswer: true, tell: request.tell } : {}),
  });
}

/** The answer calls of a question for `who`, the person when not given, as consent.ts builds
 *  them for its root run's record, with one per value when `values` are given. */
export function answerCallsFor(paths: HomePaths, question: Question, who?: Who, values?: string[]): string[] {
  return answerCalls(question, who, loadRecord(paths, question.runId), values);
}

/** An open question by its id, a unique start of it, or the run that asks only it. */
export function findQuestion(paths: HomePaths, id: string): RunQuestion {
  const exact = readQuestion(paths, id);
  if (exact) return exact;
  const all = listQuestions(paths);
  const byPrefix = all.filter((q) => q.id.startsWith(id));
  if (byPrefix.length === 1) return byPrefix[0]!;
  const record = isRunId(id) ? findRecord(paths, id) : undefined;
  if (record) {
    const forRun = all.filter((q) => q.runId === record.runId);
    if (forRun.length === 1) return forRun[0]!;
    if (forRun.length > 1) {
      const message = `run ${record.runId} asks ${forRun.length} questions. Name one: ${forRun.map((q) => q.id).join(", ")}`;
      throw new Refusal("no_such_question", message, "Give the id of one question.", `sous inbox ${record.runId} --json`);
    }
    throw new Refusal("no_such_question", `run ${record.runId} asks nothing right now`, "Answer once the run asks.", `sous wait ${record.runId} --json`);
  }
  // A question's id is its run or nested run, "--" and its call. While that run is there, the
  // question was answered or closed, and the run's next question comes from waiting on it.
  const asker = id.includes("--") ? ownRun(paths, id.slice(0, id.lastIndexOf("--"))) : undefined;
  if (asker) throw new Refusal("no_such_question", `no open question "${id}". It was answered, or ${asker.runId} no longer asks it.`, "Wait for the run's next question.", `sous wait ${asker.runId} --json`);
  throw new Refusal("no_such_question", `no open question "${id}". sous inbox lists them.`, "Give the id of an open question.", "sous inbox --json");
}

/** The root run of a run or nested run id, when its record is there. A nested run's id starts
 *  with its root's id and a dash. */
function ownRun(paths: HomePaths, scope: string): RunRecord | undefined {
  return listRecords(paths)
    .filter((record) => scope === record.runId || scope.startsWith(`${record.runId}-`))
    .sort((a, b) => b.runId.length - a.runId.length)[0];
}

/** What an answer did. It was written, and `running` says whether the run reads it now or on
 *  resume, and `notJson` that --value-json text went as text. Or it stopped the run, or it does
 *  not fit the command, or the prompt's question was already closed. */
export type AnswerOutcome = { answered: true; running: boolean; notJson?: true } | { stopped: ReturnType<typeof stopRun> } | Misfit | { gone: true };

/** Answer a question with what a person typed, or refuse a caller that may not answer it, before
 *  anything is written. The answer keeps who gave it, and `tell` sends its notice. A reply that
 *  stops the run stops it as sous stop does. Only a reply typed at a prompt finds the question gone. */
export function answerQuestion(paths: HomePaths, question: RunQuestion, typed: Reply & { via: Exclude<Reply["via"], "prompt"> }, who: Who, tell?: Tell): Exclude<AnswerOutcome, { gone: true }>;
export function answerQuestion(paths: HomePaths, question: RunQuestion, typed: Reply, who: Who, tell?: Tell): AnswerOutcome;
export function answerQuestion(paths: HomePaths, question: RunQuestion, typed: Reply, who: Who, tell?: Tell): AnswerOutcome {
  mayAnswer(question, loadRecord(paths, question.runId) ?? {}, who, triedOf(typed));
  const result = reply(paths, question, typed, who);
  if ("stop" in result) return { stopped: stopRun(paths, question.runId, who) };
  if (!("answered" in result)) return result;
  // approve and send-back keep their name, and an answer at the prompt is an answer.
  const act = typed.via === "approve" || typed.via === "send-back" ? typed.via : "answer";
  const said = act === "send-back" ? { text: decisionOf(result.value).note ?? "" } : { value: result.value };
  recordAndTell(paths, { act, ...who, runId: question.runId, question: question.id, prompt: question.prompt, ...said }, tell);
  return { answered: true, running: processAlive(findRecord(paths, question.runId)?.pid), ...(result.notJson ? { notJson: true as const } : {}) };
}

/** A stopped run's worktrees. With `remove`, deletes each branch and folder and calls `deleted`
 *  after each. A discard that removed something records it. */
export function discardRun(paths: HomePaths, runId: string, who: Who, options: { remove?: boolean; deleted?: (tree: { dir: string; branch: string }) => void } = {}): Array<{ dir: string; branch: string }> {
  const record = needRecord(paths, runId);
  if (processAlive(record.pid)) throw new Refusal("run_is_running", `${record.runId} is running. sous stop ${record.runId} first.`, "Stop the run, then discard it.", `sous stop ${record.runId} --json`);
  const trees = runWorktrees(record);
  if (options.remove) {
    for (const tree of trees) {
      removeWorktree(record.projectDir, tree.dir, tree.branch);
      options.deleted?.(tree);
    }
    if (trees.length) recordAction(paths, { act: "discard", ...who, runId: record.runId, workflow: record.workflow });
  }
  return trees;
}

/** Delete a run's saved state, record, workflow snapshot, logs and open questions. Its worktrees
 *  stay. It returns false, and deletes nothing, when another process holds the run's lease. */
export function forgetRun(paths: HomePaths, record: RunRecord): boolean {
  if (!removeEngineRun(paths, record.runId)) return false;
  removeRunFiles(paths, record);
  removeRunQuestions(paths, record.runId);
  return true;
}

/** A schedule waits for its last run, and prune keeps a run, while the run is unfinished. Here a
 *  run that never saved a state counts as finished. */
export function startedAndUnfinished(verdict: Verdict): boolean {
  return verdict.unfinished && verdict.status !== "not started";
}

/** A worker runs the run now, or ran it when its view was read. Its view may be out of date. */
export function workerRuns(run: RunView): boolean {
  return processAlive(run.record.pid) || (!run.resume.ok && run.resume.why === "running");
}

/** What a person may do with a run now, from the checks its requests refuse with. */
export interface RunActions {
  stop: boolean;
  pause: boolean;
  resume: boolean;
  remove: boolean;
}

export function runActions(run: RunView): RunActions {
  const working = workerRuns(run);
  return {
    // stopRun signals a worker, or stops a run that started and has not ended.
    stop: working || startedAndUnfinished(run),
    // pauseRun reaches only a worker.
    pause: working,
    resume: run.resume.ok,
    // removeRun refuses a run a worker runs, and one that started and has not ended.
    remove: !working && !startedAndUnfinished(run),
  };
}

/** Remove finished runs older than `days`: the engine's state, sous's record and the log. Worktrees
 *  stay. A prune that removed a run records it, the service's own as SERVICE. */
export function pruneRuns(paths: HomePaths, days: number, who: Who, now = new Date()): string[] {
  const cutoff = now.getTime() - days * 86_400_000;
  const removed: string[] = [];
  for (const run of listRuns(paths)) {
    const { record } = run;
    if (Date.parse(record.createdAt) > cutoff || workerRuns(run) || startedAndUnfinished(run)) continue;
    if (forgetRun(paths, record)) removed.push(record.runId);
  }
  if (removed.length) recordAction(paths, { act: "prune", ...who, value: removed });
  return removed;
}

/** The worktrees of the runs that have not finished, borrowed ones included. gc keeps these. */
export function busyWorktrees(paths: HomePaths, runs = listRuns(paths)): Set<string> {
  const dirs = new Set<string>();
  for (const { record, unfinished } of runs) {
    if (!unfinished) continue;
    if (record.worktree) dirs.add(record.worktree);
    for (const tree of runWorktrees(record)) dirs.add(tree.dir);
  }
  return dirs;
}

/**
 * Remove sous's merged worktrees in each project a run used, and keep those of the runs that have
 * not finished. The service passes the scan it already made as `runs`, and SERVICE as `who`. A
 * dry run, or a gc that removes nothing, records nothing.
 */
export function gcRuns(paths: HomePaths, who: Who, options: { dryRun?: boolean; runs?: RunView[] } = {}): GcResult {
  const runs = options.runs ?? listRuns(paths);
  const projects = [...new Set(runs.map((run) => run.record.projectDir))];
  const result = gcWorktrees(paths, projects, { dryRun: options.dryRun, busy: busyWorktrees(paths, runs) });
  if (result.removed.length && !options.dryRun) recordAction(paths, { act: "gc", ...who, value: result.removed.map((tree) => tree.branch) });
  return result;
}

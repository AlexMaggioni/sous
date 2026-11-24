// sous's runs. The reads: the list of runs, one run, its steps, its questions, and the wait for it
// to end. The requests: start, stop, stop a step, pause, resume, run again, answer, discard the
// worktrees, forget and prune, and the account changes that look at the runs. Callers get views
// and never open a run file. A read writes nothing.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { interruptedReason, type PersistedRunState, type RunStatus } from "./persistence/run-persistence.js";
import { deleteAccount, DEFAULT, moveRunAccount, setCurrentAccount, type AccountName } from "../accounts.js";
import type { HarnessId } from "@sous/harnesses";
import { foldStep } from "../display.js";
import { gcWorktrees, removeWorktree, runWorktrees, type GcResult } from "../places/places.js";
import type { HomePaths, Place } from "./home.js";
import { listQuestions, readQuestion, removeRunQuestions, reply, type Misfit, type Question, type Reply } from "./inbox.js";
import { createRun, type CreateRunRequest, type Launcher } from "./launch.js";
import { findRecord, listRecords, loadRecord, loadSnapshot, processAlive, requestStepStop, scopePrefix, updateRecord, type RunRecord } from "./records.js";
import { olderSave } from "../older-save.js";
import { Refusal } from "./refusal.js";
import { judge, type ResumeRefusal, type ReuseRefusal, type Verdict } from "./rule.js";
import { logFile, readEventsAfter, readState, readStates, removeEngineRun, removeRunFiles, type StoreFs } from "./store.js";
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
}

/** A run as sous's readers see it: its record, what the pause rule says of it, and its open
 *  questions. */
export interface RunView extends Verdict {
  runId: string;
  record: RunRecord;
  questions: RunQuestion[];
  /** Unset while the run has no state. */
  saved?: SavedFacts;
}

type Step = PersistedRunState["agents"][number];

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
   *  --json prints it. */
  engineState?: Omit<PersistedRunState, "script" | "journal" | "nestedJournal" | "calls">;
}

/** The state as sous shows it, given what the rule says of it. Nothing is written. */
function shownState(record: RunRecord, state: PersistedRunState | undefined, verdict: Verdict): PersistedRunState | undefined {
  if (!state || state.status === "paused" || verdict.pause?.reason !== "interrupted") return state;
  return { ...state, status: "paused", pauseReason: "interrupted", reason: interruptedReason(record.pid) };
}

function savedFacts(shown: PersistedRunState): SavedFacts {
  const { status, pauseReason, resetHint, reason } = shown;
  return { status, ...(pauseReason === undefined ? {} : { pauseReason }), ...(resetHint === undefined ? {} : { resetHint }), ...(reason === undefined ? {} : { reason }) };
}

/** The view of one run. The rule counts the questions only while the worker runs. */
function viewOf(record: RunRecord, state: PersistedRunState | undefined, questions: RunQuestion[], alive = processAlive(record.pid)): { view: RunView; shown: PersistedRunState | undefined } {
  const verdict = judge({ state, alive, openQuestions: alive ? questions.length : 0, older: state !== undefined && olderSave(state) !== undefined });
  const shown = shownState(record, state, verdict);
  return { view: { runId: record.runId, record, ...verdict, questions, ...(shown ? { saved: savedFacts(shown) } : {}) }, shown };
}

/** The run with this id or a unique start of it. The call `sous status --json` arrives in piece 4. */
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
  const steps = live?.steps ?? shown?.agents ?? [];
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
  };
}

/** The open questions, oldest first: every run's, or one run's. */
export function runQuestions(paths: HomePaths, runId?: string): RunQuestion[] {
  return listQuestions(paths, runId);
}

/** A step's key: its scope and its call. Retries of a step happen inside the one call. */
function stepKey(record: RunRecord, scope: unknown, callIndex: unknown): string {
  return `${typeof scope === "string" ? scope : record.runId}#${String(callIndex)}`;
}

/** Events after which no step of the run runs. */
const ENDS_STEPS = new Set(["complete", "paused", "error", "stopped", "resumed"]);

/** A step that runs now: the name the log gives it, the run or nested run it runs in, its label
 *  there, and its call index when known. */
interface RunningStep {
  name: string;
  scope: string;
  label: string;
  callIndex?: number;
}

/**
 * A run's steps and the steps that run now, if its worker runs. The saved state lags
 * the run: it is saved when a step ends. The event log has every step that started or ended since.
 * The steps are left unset when the run has no state or its event log cannot be read.
 */
function liveSteps(paths: HomePaths, record: RunRecord, state: PersistedRunState | undefined): { steps?: Step[]; running: RunningStep[] } {
  const agents: Step[] = (state?.agents ?? []).map((agent) => ({ ...agent }));
  const running = new Map<string, Omit<RunningStep, "name">>();
  const start = (scope: string | undefined, label: string, callIndex: number | undefined) => {
    const step = { scope: typeof scope === "string" ? scope : record.runId, label, ...(callIndex === undefined ? {} : { callIndex }) };
    running.set(stepKey(record, step.scope, callIndex), step);
  };
  const runningInState = () => {
    for (const agent of state?.agents ?? []) if (agent.status === "running") start(agent.scope, agent.label, agent.callIndex);
  };
  runningInState();
  const named = (): RunningStep[] => {
    // A nested run notes its label on the record when it starts, so the record is read again.
    const nested = loadRecord(paths, record.runId)?.nested ?? record.nested;
    return [...running.values()].map((step) => ({ name: `${scopePrefix(record.runId, step.scope, nested)}${step.label}`, ...step }));
  };
  try {
    readEventsAfter(paths, record.runId, state?.eventSeq ?? 0, ({ event, timestamp }) => {
      if (event.type === "agentStart" || event.type === "agentEnd") {
        foldStep(agents, event, timestamp);
        // A step that starts again keeps one name, at the end.
        running.delete(stepKey(record, event.scope, event.callIndex));
        if (event.type === "agentStart") start(event.scope, event.label, event.callIndex);
      } else if (ENDS_STEPS.has(event.type) && event.scope === record.runId) {
        running.clear();
      }
    });
  } catch {
    // The steps stay as the state saved them, and so do the ones that run.
    running.clear();
    runningInState();
    return { running: named() };
  }
  return { ...(state ? { steps: agents } : {}), running: named() };
}

/** What `sous wait --json` prints. Its status is the saved one, not the rule's word. */
function runSummary(record: RunRecord, state: PersistedRunState | undefined, questions: RunQuestion[]): Record<string, unknown> {
  return {
    runId: record.runId,
    workflow: record.workflow,
    status: state?.status ?? (processAlive(record.pid) ? "running" : "pending"),
    ...(state?.pauseReason ? { pauseReason: state.pauseReason } : {}),
    ...(state?.resetHint ? { resetHint: state.resetHint } : {}),
    ...(state?.reason && state.status !== "completed" ? { reason: state.reason } : {}),
    ...(questions.length ? { questions: questions.map((q) => ({ id: q.id, prompt: q.prompt, kind: q.kind, ...(q.choices ? { choices: q.choices } : {}), breakpoint: q.breakpoint })) } : {}),
    cwd: record.cwd,
    ...(record.branch ? { branch: record.branch } : {}),
    ...(state?.status === "completed" ? { result: state.result } : {}),
  };
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
  /** Gets the log as it grows. */
  log?: (text: string) => void;
  /** Gets the questions the run asks, each once, and the wait goes on. Without it, the wait ends at them. */
  asks?: (questions: RunQuestion[], record: RunRecord) => Promise<void>;
}

export interface WaitEnd {
  /** The rule's exit code for how the wait ended. */
  code: number;
  summary: Record<string, unknown>;
  /** Set when the wait ended at questions. */
  questions?: RunQuestion[];
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
      return { code: view.exit!, summary: runSummary(record, shown, view.questions) };
    }
    const open = listQuestions(paths, runId).filter((q) => !asked.has(q.id));
    if (open.length) {
      if (!hooks.asks) {
        // Nothing was asked here, so these are all the run's questions.
        const { view, shown } = viewOf(record, readState(paths, runId), open, true);
        return { code: view.exit!, summary: runSummary(record, shown, open), questions: open };
      }
      for (const question of open) asked.add(question.id);
      await hooks.asks(open, record);
    }
    await new Promise((r) => setTimeout(r, 400));
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
export function stopRun(paths: HomePaths, runId: string): { outcome: StopOutcome; status?: RunStatus } {
  const record = needRecord(paths, runId);
  if (processAlive(record.pid)) {
    process.kill(record.pid!, "SIGTERM");
    return { outcome: "stopping" };
  }
  const result = stopColdRun(paths, record);
  removeRunQuestions(paths, record.runId);
  if (result.outcome === "already-terminal") return { outcome: "already-ended", ...(result.state?.status ? { status: result.state.status } : {}) };
  if (result.outcome === "missing") return { outcome: "never-started" };
  if (result.outcome === "owned-elsewhere") return { outcome: "held-elsewhere" };
  return { outcome: "stopped" };
}

/** Stop one running step by its name in the log. The run pauses on it, and resume runs it again.
 *  The worker gets the step's run or nested run and its call, so a step with the same label
 *  elsewhere goes on. Returns false when the run is not running. */
export function stopStep(paths: HomePaths, runId: string, step: string): boolean {
  const record = needRecord(paths, runId);
  if (!processAlive(record.pid)) return false;
  const state = readState(paths, record.runId);
  const live = state ? liveSteps(paths, record, state) : { running: [] };
  const running = live.running;
  const calls = running.filter((call) => call.name === step).map(({ name: _name, ...call }) => call);
  if (!calls.length) {
    const now = running.length ? `Running now: ${running.map((call) => `"${call.name}"`).join(", ")}.` : "No step runs now.";
    const ran = (live.steps ?? []).some((agent) => `${scopePrefix(record.runId, typeof agent.scope === "string" ? agent.scope : undefined, record.nested)}${agent.label}` === step);
    const message = ran ? `"${step}" does not run now in ${record.runId}. ${now}` : `no step named "${step}" runs in ${record.runId}. ${now}`;
    throw new Refusal(ran ? "step_not_running" : "no_such_step", message, "Name a step that runs now, by the name sous log gives it.", `sous show ${record.runId} --json`);
  }
  requestStepStop(paths, record.runId, { step, calls });
  process.kill(record.pid!, "SIGUSR2");
  return true;
}

/** Pause a running run: steps already running finish, nothing new starts. False when it does not run. */
export function pauseRun(paths: HomePaths, runId: string): boolean {
  const record = needRecord(paths, runId);
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

/** What resume says when the rule refuses it. */
const RESUME_REFUSALS: Record<ResumeRefusal, (runId: string) => string> = {
  running: (runId) => `${runId} is running already`,
  "never-started": (runId) => `${runId} never started. sous rerun ${runId} starts it fresh.`,
  completed: (runId) => `${runId} completed. sous rerun ${runId} runs it again.`,
  stopped: (runId) => `${runId} was stopped. sous rerun ${runId} starts it again.`,
  older: (runId) => `${runId} was saved by an older sous, and this sous cannot resume it. sous rerun ${runId} starts it again, and sous stop ${runId} ends it.`,
};

/**
 * Resume a run in a new worker. A workflow edited since the run started reaches it only by
 * choice: "latest" takes the edits, and "same" goes on with the version it started with. With
 * no choice, an edit refuses the resume.
 */
export function resumeRun(paths: HomePaths, launch: Launcher, runId: string, choice?: "latest" | "same"): RunRecord {
  const { record, resume } = readRun(paths, runId);
  if (!resume.ok) throw new Error(RESUME_REFUSALS[resume.why](record.runId));
  // The rule lets a run resume only once it has a state. The check runs with a choice too, so a
  // workflow folder that cannot be read stops the resume here.
  const changed = changedWorkflows(paths, record, readState(paths, record.runId)!);
  if (changed.length && !choice) {
    throw new Error(
      `${changed.join(", ")} changed since ${record.runId} started. ` +
        `sous resume ${record.runId} --latest takes the new version, and the finished steps that match stay done. ` +
        `sous resume ${record.runId} --same goes on with the version it started with.`,
    );
  }
  if (choice === "latest") updateRecord(paths, record.runId, { resumeLatest: true });
  launch(paths, record.runId, "resume");
  return record;
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
  startedByRun?: string;
  caller?: boolean;
}

/** Start an earlier run again as a new run, with its inputs, step changes and model. */
export function rerunRun(paths: HomePaths, launch: Launcher, runId: string, request: RerunRequest): RunRecord {
  const { record: old, reuse } = readRun(paths, runId);
  if (request.reuse && !reuse.ok) throw new Error(REUSE_REFUSALS[reuse.why](old.runId));
  const defaultModel = request.defaultModel ?? old.defaultModel;
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
    ...(request.startedByRun ? { startedByRun: request.startedByRun } : {}),
    caller: request.caller === true,
  });
}

/** An open question by its id, a unique start of it, or the run that asks only it. */
export function findQuestion(paths: HomePaths, id: string): RunQuestion {
  const exact = readQuestion(paths, id);
  if (exact) return exact;
  const all = listQuestions(paths);
  const byPrefix = all.filter((q) => q.id.startsWith(id));
  if (byPrefix.length === 1) return byPrefix[0]!;
  const record = findRecord(paths, id);
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
 *  resume. Or it stopped the run, or it does not fit the command, or the prompt's question was
 *  already closed. */
export type AnswerOutcome = { answered: true; running: boolean } | { stopped: ReturnType<typeof stopRun> } | Misfit | { gone: true };

/** Answer a question with what a person typed. A reply that stops the run stops it as sous stop does. */
export function answerQuestion(paths: HomePaths, question: RunQuestion, typed: Reply): AnswerOutcome {
  const result = reply(paths, question, typed);
  if ("stop" in result) return { stopped: stopRun(paths, question.runId) };
  if ("answered" in result) return { answered: true, running: processAlive(findRecord(paths, question.runId)?.pid) };
  return result;
}

/** A stopped run's worktrees. With `remove`, deletes each branch and folder and calls `deleted`
 *  after each. */
export function discardRun(paths: HomePaths, runId: string, options: { remove?: boolean; deleted?: (tree: { dir: string; branch: string }) => void } = {}): Array<{ dir: string; branch: string }> {
  const record = needRecord(paths, runId);
  if (processAlive(record.pid)) throw new Error(`${record.runId} is running. sous stop ${record.runId} first.`);
  const trees = runWorktrees(record);
  if (options.remove) {
    for (const tree of trees) {
      removeWorktree(record.projectDir, tree.dir, tree.branch);
      options.deleted?.(tree);
    }
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

/** Remove finished runs older than `days`: the engine's state, sous's record and the log. Worktrees stay. */
export function pruneRuns(paths: HomePaths, days: number, now = new Date()): string[] {
  const cutoff = now.getTime() - days * 86_400_000;
  const removed: string[] = [];
  for (const run of listRuns(paths)) {
    const { record } = run;
    if (Date.parse(record.createdAt) > cutoff || workerRuns(run) || startedAndUnfinished(run)) continue;
    if (forgetRun(paths, record)) removed.push(record.runId);
  }
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
 * not finished. The service passes the scan it already made as `runs`.
 */
export function gcRuns(paths: HomePaths, options: { dryRun?: boolean; runs?: RunView[] } = {}): GcResult {
  const runs = options.runs ?? listRuns(paths);
  const projects = [...new Set(runs.map((run) => run.record.projectDir))];
  return gcWorktrees(paths, projects, { dryRun: options.dryRun, busy: busyWorktrees(paths, runs) });
}

// ── Accounts ──

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
export function useAccount(paths: HomePaths, spec: string, launch: Launcher): UseResult {
  const { program, name } = setCurrentAccount(paths, spec);
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

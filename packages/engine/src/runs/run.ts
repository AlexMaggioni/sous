// Reading a run: the list of runs, one run, its steps, its questions, and the wait for it to end.
// Callers get views and never open a run file. Nothing here writes.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { PersistedRunState, RunStatus } from "./persistence/run-persistence.js";
import type { HomePaths } from "./home.js";
import { listQuestions, type Question } from "./inbox.js";
import { logFile } from "./launch.js";
import { findRecord, listRecords, loadRecord, processAlive, scopePrefix, type RunRecord } from "./records.js";
import { judge, type Verdict } from "./rule.js";
import { readEventsAfter, readState, readStates, type StoreFs } from "./store.js";

/** A question a run asks, as the inbox holds it. */
export type RunQuestion = Question;

/** What the run's saved state says, as orc shows it. A run left pending or running by a worker
 *  that died shows as paused "interrupted", the way `orc resume` saves it before it goes on. */
export interface SavedFacts {
  status: RunStatus;
  pauseReason?: string;
  resetHint?: string;
  /** The engine's text for a failure, a pause or a lost worker. */
  reason?: string;
}

/** A run as orc's readers see it: its record, what the pause rule says of it, and its open
 *  questions. */
export interface RunView extends Verdict {
  runId: string;
  record: RunRecord;
  questions: RunQuestion[];
  /** Unset while the run has no state. */
  saved?: SavedFacts;
}

type Step = PersistedRunState["agents"][number];

/** A run with its steps, for orc show. */
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
  /** The saved state with the steps above, without the script and the journals. orc show
   *  --json prints it. */
  engineState?: Omit<PersistedRunState, "script" | "journal" | "nestedJournal" | "calls">;
}

/** The state as orc shows it, given what the rule says of it. Nothing is written. */
function shownState(record: RunRecord, state: PersistedRunState | undefined, verdict: Verdict): PersistedRunState | undefined {
  if (!state || state.status === "paused" || verdict.pause?.reason !== "interrupted") return state;
  return { ...state, status: "paused", pauseReason: "interrupted", reason: interruptedReason(record.pid) };
}

/** The engine's reason for a run its worker left, as the engine saves it on resume. */
function interruptedReason(pid: number | undefined): string {
  return pid === undefined
    ? "Interrupted: the owning process exited before completion (PID unavailable); recovered to a resumable pause."
    : `Interrupted: owning process PID ${pid} exited before completion; recovered to a resumable pause.`;
}

function savedFacts(shown: PersistedRunState): SavedFacts {
  const { status, pauseReason, resetHint, reason } = shown;
  return { status, ...(pauseReason === undefined ? {} : { pauseReason }), ...(resetHint === undefined ? {} : { resetHint }), ...(reason === undefined ? {} : { reason }) };
}

/** The view of one run. The rule counts the questions only while the worker runs. */
function viewOf(record: RunRecord, state: PersistedRunState | undefined, questions: RunQuestion[], alive = processAlive(record.pid)): { view: RunView; shown: PersistedRunState | undefined } {
  const verdict = judge({ state, alive, openQuestions: alive ? questions.length : 0 });
  const shown = shownState(record, state, verdict);
  return { view: { runId: record.runId, record, ...verdict, questions, ...(shown ? { saved: savedFacts(shown) } : {}) }, shown };
}

function needRecord(paths: HomePaths, id: string): RunRecord {
  const record = findRecord(paths, id);
  if (!record) throw new Error(`no run "${id}". orc list shows the runs.`);
  return record;
}

/**
 * orc's runs, newest first, or the newest `limit` of them. It reads the records, the engine
 * folder and the inbox once each, so its cost grows with the number of runs. `fs` is for tests.
 */
export function listRuns(paths: HomePaths, options: { limit?: number; fs?: StoreFs } = {}): RunView[] {
  const records = listRecords(paths);
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
  const live = alive ? liveSteps(paths, record, state) : undefined;
  const steps = live?.steps ?? shown?.agents ?? [];
  let engineState: RunDetail["engineState"];
  if (shown) {
    const { script: _script, journal: _journal, nestedJournal: _nested, calls: _calls, ...rest } = shown;
    engineState = { ...rest, agents: steps };
  }
  return {
    ...view,
    steps,
    running: live?.running ?? [],
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

/**
 * A live run's steps and the names of the steps that run now. The saved state lags a live run:
 * it is saved when a step ends. The event log has every step that started or ended since. The
 * steps are left unset when the run has no state or its event log cannot be read.
 */
function liveSteps(paths: HomePaths, record: RunRecord, state: PersistedRunState | undefined): { steps?: Step[]; running: string[] } {
  const agents: Step[] = (state?.agents ?? []).map((agent) => ({ ...agent }));
  const byKey = new Map(agents.map((agent) => [stepKey(record, agent.scope, agent.callIndex), agent]));
  const running = new Map<string, { scope?: string; label: string }>();
  for (const agent of state?.agents ?? []) {
    if (agent.status === "running") running.set(stepKey(record, agent.scope, agent.callIndex), { ...(agent.scope ? { scope: agent.scope } : {}), label: agent.label });
  }
  const named = () => {
    // A nested run notes its label on the record when it starts, so the record is read again.
    const nested = loadRecord(paths, record.runId)?.nested ?? record.nested;
    return [...running.values()].map((step) => `${scopePrefix(record.runId, step.scope, nested)}${step.label}`);
  };
  try {
    readEventsAfter(paths, record.runId, state?.eventSeq ?? 0, ({ event: e, timestamp }) => {
      const k = stepKey(record, e.scope, e.callIndex);
      if (e.type === "agentStart") {
        if (!byKey.has(k)) {
          const step = {
            id: agents.length + 1,
            label: String(e.label ?? "agent"),
            status: "running",
            startedAt: timestamp,
            ...(typeof e.phase === "string" ? { phase: e.phase } : {}),
            ...(typeof e.model === "string" ? { model: e.model } : {}),
            ...(typeof e.callIndex === "number" ? { callIndex: e.callIndex } : {}),
            ...(typeof e.scope === "string" ? { scope: e.scope } : {}),
          } as Step;
          agents.push(step);
          byKey.set(k, step);
        }
        // A step tried again starts again under the same key. It is listed once.
        running.delete(k);
        running.set(k, { ...(typeof e.scope === "string" ? { scope: e.scope } : {}), label: String(e.label ?? "agent") });
      } else if (e.type === "agentEnd") {
        const step = byKey.get(k);
        if (step && step.status === "running") {
          step.status = e.errorRecord ? "error" : "done";
          step.endedAt = timestamp;
          if (typeof e.tokens === "number") step.tokens = e.tokens;
          if (typeof e.error === "string") step.error = e.error;
        }
        running.delete(k);
      } else if (ENDS_STEPS.has(String(e.type)) && (e.scope === undefined || e.scope === record.runId)) {
        running.clear();
      }
    });
  } catch {
    // The steps stay as the state saved them, and so do the ones that run.
    running.clear();
    for (const agent of state?.agents ?? []) {
      if (agent.status === "running") running.set(stepKey(record, agent.scope, agent.callIndex), { ...(agent.scope ? { scope: agent.scope } : {}), label: agent.label });
    }
    return { running: named() };
  }
  return { ...(state ? { steps: agents } : {}), running: named() };
}

/** What `orc wait --json` prints. Its status is the saved one, not the rule's word. */
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

/** Hand the log from `from` to `write`, and return where it ended. */
export function readLogFrom(file: string, from: number, write: (text: string) => void): number {
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

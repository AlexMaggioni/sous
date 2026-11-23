// Reading a run: its state, the steps that run now, what the pause rule says of it, and the
// wait for it to end. orc prints what these return.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { PersistedRunState, RunStatus } from "./persistence/run-persistence.js";
import type { HomePaths } from "./home.js";
import { listQuestions, type Question } from "./inbox.js";
import { logFile } from "./launch.js";
import { findRecord, listRecords, loadRecord, processAlive, scopePrefix, type RunRecord } from "./records.js";
import { judge, type Verdict } from "./rule.js";
import { readEventsAfter, readState, readStates, type StoreFs } from "./store.js";

/**
 * The run's state as orc shows it. Nothing is written. A run left pending or running by a worker
 * that died stays so on disk, and the pause rule reads it as paused "interrupted". It shows as the
 * paused state that `orc resume` saves before it goes on, so list, show and wait print what they
 * printed when this read saved it.
 */
export function stateOf(paths: HomePaths, record: RunRecord): PersistedRunState | undefined {
  const state = readState(paths, record.runId);
  return shownState(record, state, judge({ state, alive: processAlive(record.pid), openQuestions: 0 }));
}

/** The state as orc shows it, given what the rule says of it. */
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

type Step = PersistedRunState["agents"][number];
type EventFields = Record<string, unknown>;

/** Each event saved after the run's state, in order. */
function eventsSinceState(paths: HomePaths, record: RunRecord, state: PersistedRunState | undefined, visit: (event: EventFields, timestamp: string) => void): void {
  readEventsAfter(paths, record.runId, state?.eventSeq ?? 0, ({ event, timestamp }) => visit(event, timestamp));
}

/** A step's key: its scope and its call. Retries of a step happen inside the one call. */
function stepKey(record: RunRecord, scope: unknown, callIndex: unknown): string {
  return `${typeof scope === "string" ? scope : record.runId}#${String(callIndex)}`;
}

/** The saved state lags a live run: it is saved when a step ends. The event log has every step
 *  that started or ended since, so show and the monitor see what runs now. */
export function withLiveSteps(paths: HomePaths, record: RunRecord, state: PersistedRunState | undefined): PersistedRunState | undefined {
  if (!state || !processAlive(record.pid)) return state;
  const agents: Step[] = state.agents.map((agent) => ({ ...agent }));
  const byKey = new Map(agents.map((agent) => [stepKey(record, agent.scope, agent.callIndex), agent]));
  try {
    eventsSinceState(paths, record, state, (e, timestamp) => {
      const k = stepKey(record, e.scope, e.callIndex);
      if (e.type === "agentStart" && !byKey.has(k)) {
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
      } else if (e.type === "agentEnd") {
        const step = byKey.get(k);
        if (step && step.status === "running") {
          step.status = e.errorRecord ? "error" : "done";
          step.endedAt = timestamp;
          if (typeof e.tokens === "number") step.tokens = e.tokens;
          if (typeof e.error === "string") step.error = e.error;
        }
      }
    });
  } catch {
    return state;
  }
  return { ...state, agents };
}

/** Events after which no step of the run runs. */
const ENDS_STEPS = new Set(["complete", "paused", "error", "stopped", "resumed"]);

/**
 * The steps that run now, by the name the log gives them: the label for a top-level step, and
 * "Nested label / Inner label: step label" for a step of a nested run. They come from the saved
 * state and the events saved after it.
 */
export function runningSteps(paths: HomePaths, record: RunRecord): string[] {
  const state = readState(paths, record.runId);
  const running = new Map<string, { scope?: string; label: string }>();
  for (const agent of state?.agents ?? []) {
    if (agent.status === "running") running.set(stepKey(record, agent.scope, agent.callIndex), { ...(agent.scope ? { scope: agent.scope } : {}), label: agent.label });
  }
  eventsSinceState(paths, record, state, (e) => {
    if (e.type === "agentStart") {
      const k = stepKey(record, e.scope, e.callIndex);
      running.delete(k);
      running.set(k, { ...(typeof e.scope === "string" ? { scope: e.scope } : {}), label: String(e.label ?? "agent") });
    } else if (e.type === "agentEnd") {
      running.delete(stepKey(record, e.scope, e.callIndex));
    } else if (ENDS_STEPS.has(String(e.type)) && (e.scope === undefined || e.scope === record.runId)) {
      running.clear();
    }
  });
  const nested = loadRecord(paths, record.runId)?.nested ?? record.nested;
  return [...running.values()].map((step) => `${scopePrefix(record.runId, step.scope, nested)}${step.label}`);
}

/** A run as orc's readers see it: its record, what the pause rule says of it, and its open
 *  questions. */
export interface RunView extends Verdict {
  runId: string;
  record: RunRecord;
  questions: Question[];
  /** The saved status and pause reason as orc shows them. A run left pending or running by a
   *  worker that died shows as paused "interrupted". Unset while the run has no state. */
  saved?: { status: RunStatus; pauseReason?: string };
}

function viewOf(record: RunRecord, state: PersistedRunState | undefined, questions: Question[]): RunView {
  const alive = processAlive(record.pid);
  const verdict = judge({ state, alive, openQuestions: alive ? questions.length : 0 });
  const shown = shownState(record, state, verdict);
  const saved = shown ? { status: shown.status, ...(shown.pauseReason === undefined ? {} : { pauseReason: shown.pauseReason }) } : undefined;
  return { runId: record.runId, record, ...verdict, questions, ...(saved ? { saved } : {}) };
}

/**
 * orc's runs, newest first, or the newest `limit` of them. It reads the records, the engine
 * folder and the inbox once each, so its cost grows with the number of runs. `fs` is for tests.
 */
export function listRuns(paths: HomePaths, options: { limit?: number; fs?: StoreFs } = {}): RunView[] {
  const records = listRecords(paths);
  const shown = options.limit === undefined ? records : records.slice(0, options.limit);
  const states = readStates(paths, shown.map((record) => record.runId), options.fs);
  const asked = new Map<string, Question[]>();
  for (const question of listQuestions(paths)) {
    const list = asked.get(question.runId);
    if (list) list.push(question);
    else asked.set(question.runId, [question]);
  }
  return shown.map((record) => viewOf(record, states.get(record.runId), asked.get(record.runId) ?? []));
}

/** What the pause rule says of the run: its word, its pause, and whether it may resume. It
 *  lists the run's questions only while the worker runs, since the rule counts them only then. */
export function verdictOf(paths: HomePaths, record: RunRecord, state: PersistedRunState | undefined): Verdict {
  const alive = processAlive(record.pid);
  return judge({ state, alive, openQuestions: alive ? listQuestions(paths, record.runId).length : 0 });
}

/** What `orc wait --json` prints. Its status is the saved one, not the rule's word. */
function runSummary(paths: HomePaths, record: RunRecord, state: PersistedRunState | undefined): Record<string, unknown> {
  const questions = listQuestions(paths, record.runId);
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
  asks?: (questions: Question[], record: RunRecord) => Promise<void>;
}

export interface WaitEnd {
  /** The rule's exit code for how the wait ended. */
  code: number;
  summary: Record<string, unknown>;
  /** Set when the wait ended at questions. */
  questions?: Question[];
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
      const state = stateOf(paths, record);
      // The rule gives every run with a gone worker an exit code.
      return { code: judge({ state, alive: false, openQuestions: 0 }).exit!, summary: runSummary(paths, record, state) };
    }
    const open = listQuestions(paths, runId).filter((q) => !asked.has(q.id));
    if (open.length) {
      if (!hooks.asks) {
        const state = stateOf(paths, record);
        return { code: judge({ state, alive: true, openQuestions: open.length }).exit!, summary: runSummary(paths, record, state), questions: open };
      }
      for (const question of open) asked.add(question.id);
      await hooks.asks(open, record);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

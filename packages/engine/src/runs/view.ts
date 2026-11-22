// Reading a run: its state, the steps that run now, one word for its status, and the wait for
// it to end. orc prints what these return.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { PersistedRunState } from "./persistence/run-persistence.js";
import type { HomePaths } from "./home.js";
import { listQuestions, type Question } from "./inbox.js";
import { logFile } from "./launch.js";
import { findRecord, loadRecord, processAlive, scopePrefix, type RunRecord } from "./records.js";
import { managerFor } from "./worker.js";

/** The run's saved state. A run left running by a process that died reads as interrupted. */
export function stateOf(paths: HomePaths, record: RunRecord): PersistedRunState | undefined {
  const manager = managerFor(paths, record.projectDir);
  const state = manager.getPersistence().load(record.runId) ?? undefined;
  if (state && (state.status === "running" || state.status === "pending") && !processAlive(record.pid)) {
    return manager.reconcileExternallyDeadRun(record.runId) ?? state;
  }
  return state;
}

type Step = PersistedRunState["agents"][number];
type EventFields = Record<string, unknown>;

/** Each event saved after the run's state, in order. */
function eventsSinceState(paths: HomePaths, record: RunRecord, state: PersistedRunState | undefined, visit: (event: EventFields, timestamp: string) => void): void {
  const persistence = managerFor(paths, record.projectDir).getPersistence();
  let after = state?.eventSeq ?? 0;
  for (;;) {
    const page = persistence.readEvents(record.runId, { after, limit: 1000 });
    for (const { event, timestamp } of page.events) visit(event as unknown as EventFields, timestamp);
    if (!page.hasMore || page.events.length === 0) break;
    after = page.events[page.events.length - 1]!.seq;
  }
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
  const state = managerFor(paths, record.projectDir).getPersistence().load(record.runId) ?? undefined;
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

/** One word for the list: what the run is doing, or what it waits for. */
export function statusWord(paths: HomePaths, record: RunRecord, state: PersistedRunState | undefined): string {
  const alive = processAlive(record.pid);
  if (alive && listQuestions(paths, record.runId).length) return "asks";
  if (!state) return alive ? "starting" : "not started";
  if (state.status === "running" && !alive) return "interrupted";
  if (state.status === "paused") {
    const reason = state.pauseReason;
    if (reason === "usage_limit") return "paused: limit";
    if (reason === "step_failed") return "paused: failed step";
    if (reason === "step_stopped") return "paused: stopped step";
    if (reason === "time_limit") return "paused: time limit";
    if (reason === "checkpoint_required") return "paused: asks";
    if (reason === "requested") return "paused";
    if (reason === "interrupted") return "interrupted";
    return `paused: ${reason ?? "?"}`;
  }
  if (state.status === "aborted") return "stopped";
  return state.status;
}

/** The exit code of `orc wait` and `orc run --wait` for each way a run ends. */
export const EXIT: Record<string, number> = { completed: 0, failed: 1, paused: 2, aborted: 3, asks: 4 };

/** What `orc wait --json` prints. */
export function runSummary(paths: HomePaths, record: RunRecord): Record<string, unknown> {
  const state = stateOf(paths, record);
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
  /** EXIT's code for how the wait ended. */
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
      const summary = runSummary(paths, record);
      return { code: EXIT[String(summary.status)] ?? 1, summary };
    }
    const open = listQuestions(paths, runId).filter((q) => !asked.has(q.id));
    if (open.length) {
      if (!hooks.asks) return { code: EXIT.asks!, summary: runSummary(paths, record), questions: open };
      for (const question of open) asked.add(question.id);
      await hooks.asks(open, record);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

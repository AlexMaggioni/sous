// A run's steps as they are now. The saved state lags the run, so the steps that started or ended
// since its last save come from the event log, and each step gets the tries its call took.

import { foldStep } from "../display.js";
import type { PersistedRunState } from "./persistence/run-persistence.js";
import type { HomePaths } from "./home.js";
import { loadRecord, scopePrefix, type RunRecord } from "./records.js";
import { readEventsAfter } from "./store.js";

/** A step as the state saves it, with how many tries its call took when more than one. */
export type Step = PersistedRunState["agents"][number] & { tries?: number };

/** The steps, each run's own step with the tries its call took when more than one. The state keeps
 *  the calls of the run itself, not those of its nested runs. */
export function withTries(steps: readonly Step[], calls: PersistedRunState["calls"], runId: string): Step[] {
  const tries = new Map((calls ?? []).flatMap((call) => (call.attempts ?? 1) > 1 ? [[call.index, call.attempts!] as const] : []));
  return steps.map((step) => {
    const own = step.scope === undefined || step.scope === runId;
    const count = own && step.callIndex !== undefined ? tries.get(step.callIndex) : undefined;
    return count ? { ...step, tries: count } : step;
  });
}

/** A step's key: its scope and its call. Retries of a step happen inside the one call. */
function stepKey(record: RunRecord, scope: unknown, callIndex: unknown): string {
  return `${typeof scope === "string" ? scope : record.runId}#${String(callIndex)}`;
}

/** Events after which no step of the run runs. */
const ENDS_STEPS = new Set(["complete", "paused", "error", "stopped", "resumed"]);

/** A step that runs now: the name the log gives it, the run or nested run it runs in, its label
 *  there, and its call index when known. */
export interface RunningStep {
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
export function liveSteps(paths: HomePaths, record: RunRecord, state: PersistedRunState | undefined): { steps?: Step[]; running: RunningStep[] } {
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

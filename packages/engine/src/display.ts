// The snapshot of a run's steps that the run manager keeps up to date as the run goes, and the
// one rule that turns a step's start and end into the step list.
import type { AgentHistoryEntry } from "./steps/agent-history.js";
import type { AgentResultProvenance, AgentUsage } from "./steps/agent-run.js";
import type { AgentSessionRecord } from "./workflow-result.js";
import type { WorkflowErrorCode } from "./errors.js";
import type { RunAgentEndPayload, RunAgentStartPayload } from "./run-events.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  /** Tokens used by this agent. */
  tokens?: number;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
  /** The agent's session re-attach record (live or journal-replayed), when one exists. */
  session?: AgentSessionRecord;
  callIndex?: number;
  scope?: string;
  usage?: AgentUsage;
  provenance?: AgentResultProvenance;
  /** When this step started and ended, as ISO times. */
  startedAt?: string;
  endedAt?: string;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  runId?: string;
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A step's start or end, as the live event and the event log both carry it. The log holds a
 *  cut copy of the error record, so the fold only asks whether there is one. Only the manager
 *  has the result preview and the session: the log keeps a longer, redacted preview and no
 *  session. */
export type StepEvent =
  | ({ type: "agentStart" } & Pick<RunAgentStartPayload, "scope" | "callIndex" | "label" | "phase" | "prompt" | "model">)
  | ({ type: "agentEnd" } & Pick<RunAgentEndPayload, "scope" | "callIndex" | "error" | "errorCode" | "recoverable" | "tokens" | "model" | "usage" | "provenance" | "session"> & { errorRecord?: object; resultPreview?: string });

/**
 * Fold one step event into the step list, at the time `at`, and return the step it touched. The
 * manager folds each event as it happens. orc folds the event log the same way while a run is
 * live, for the steps the saved state does not have yet.
 *
 * A step is its scope and its call index. A start adds the step, or starts the listed one again
 * in its place. An end settles the running step: "error" when it carries an error record, "done"
 * otherwise. An end with no running step changes nothing.
 *
 * The keys go in the order the saved state has always had, since `orc show --json` prints them
 * in that order. So the start sets phase and model even when they are undefined.
 */
export function foldStep(steps: WorkflowAgentSnapshot[], event: StepEvent, at: string): WorkflowAgentSnapshot | undefined {
  const index = steps.findIndex((step) => step.scope === event.scope && step.callIndex === event.callIndex);
  if (event.type === "agentStart") {
    const step: WorkflowAgentSnapshot = {
      id: index === -1 ? steps.length + 1 : steps[index]!.id,
      label: event.label,
      phase: event.phase,
      prompt: event.prompt,
      status: "running",
      model: event.model,
      callIndex: event.callIndex,
      scope: event.scope,
      startedAt: at,
    };
    if (index === -1) steps.push(step);
    else steps[index] = step;
    return step;
  }
  const step = index === -1 ? undefined : steps[index]!;
  if (step?.status !== "running") return undefined;
  step.status = event.errorRecord ? "error" : "done";
  if (event.resultPreview !== undefined) step.resultPreview = event.resultPreview;
  if (event.error !== undefined) step.error = event.error;
  if (event.errorCode !== undefined) step.errorCode = event.errorCode;
  if (event.recoverable !== undefined) step.recoverable = event.recoverable;
  if (event.tokens !== undefined) step.tokens = event.tokens;
  if (event.usage !== undefined) step.usage = event.usage;
  if (event.provenance !== undefined) step.provenance = event.provenance;
  if (event.model) step.model = event.model;
  if (event.session) step.session = event.session;
  step.endedAt = at;
  return step;
}

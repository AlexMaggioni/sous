import type { AgentHistoryEntry } from "./steps/agent-history.js";
import type { AgentResultProvenance, AgentUsage } from "./steps/agent-run.js";
import type {
  AuthErrorContext,
  CheckpointContext,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowRecordedError,
} from "./errors.js";
import type {
  AgentSessionRecord,
  JournalEntry,
  TokenUsage,
  WorkflowCallRecord,
  WorkflowRunResult,
} from "./workflow-result.js";

/** Root run that owns the event stream, plus the engine run that originated the event. */
export interface RunEventOrigin {
  runId: string;
  scope: string;
}

export interface RunLogPayload extends RunEventOrigin {
  message: string;
}

export interface RunPhasePayload extends RunEventOrigin {
  title: string;
}

export interface RunAgentStartPayload extends RunEventOrigin {
  label: string;
  phase?: string;
  prompt: string;
  model?: string;
  configOptions?: Record<string, string | boolean>;
  callIndex: number;
  /** The structural call-path key (WorkflowCallRecord.path), when captured. */
  path?: string;
}

export interface RunAgentEndPayload extends RunEventOrigin {
  label: string;
  phase?: string;
  result: unknown;
  tokens?: number;
  worktree?: string;
  model?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  session?: AgentSessionRecord;
  callIndex: number;
  usage?: AgentUsage;
  modelResolved?: string;
  backendId?: string;
  provenance?: AgentResultProvenance;
  errorRecord?: WorkflowRecordedError;
}

export interface RunAgentHistoryPayload extends RunEventOrigin {
  label: string;
  phase?: string;
  history: AgentHistoryEntry[];
  callIndex: number;
}

export interface RunTokenUsagePayload extends RunEventOrigin {
  usage: TokenUsage;
}

export interface RunCompletePayload extends RunEventOrigin {
  result: WorkflowRunResult;
}

export interface RunJournalPayload extends RunEventOrigin {
  entry: JournalEntry;
}

export interface RunCallRecordPayload extends RunEventOrigin {
  record: WorkflowCallRecord;
}

/**
 * The reasons a pause in the "requested" shape gives. "requested": a host asked for the pause.
 * The others come from the run itself: a step failed, a host stopped a step, or the worker
 * stopped the run at its time limit. Event logs written before the last three say "requested".
 */
export const REQUESTED_PAUSE_REASONS = ["requested", "step_failed", "step_stopped", "time_limit"] as const;
export type RequestedPauseReason = (typeof REQUESTED_PAUSE_REASONS)[number];

export function isRequestedPauseReason(value: unknown): value is RequestedPauseReason {
  return (REQUESTED_PAUSE_REASONS as readonly unknown[]).includes(value);
}

/** A pause where executing calls finished and journaled, and nothing new was admitted. */
export interface RunRequestedPausedPayload extends RunEventOrigin {
  reason: RequestedPauseReason;
  error: WorkflowError;
  errorRecord: WorkflowRecordedError;
  resetHint?: never;
  authContext?: never;
  checkpointContext?: never;
}

export interface RunUsageLimitPausedPayload extends RunEventOrigin {
  reason: "usage_limit";
  error: WorkflowError;
  /** Strict-JSON projection of `error`; added to the live payload for durable consumers. */
  errorRecord: WorkflowRecordedError;
  resetHint?: string;
  authContext?: never;
  checkpointContext?: never;
}

export interface RunAuthPausedPayload extends RunEventOrigin {
  reason: "auth_required";
  error: WorkflowError;
  errorRecord: WorkflowRecordedError;
  authContext?: AuthErrorContext;
  resetHint?: never;
  checkpointContext?: never;
}

export interface RunCheckpointPausedPayload extends RunEventOrigin {
  reason: "checkpoint_required";
  error: WorkflowError;
  errorRecord: WorkflowRecordedError;
  checkpointContext?: CheckpointContext;
  resetHint?: never;
  authContext?: never;
}

export type RunPausedPayload =
  | RunRequestedPausedPayload
  | RunUsageLimitPausedPayload
  | RunAuthPausedPayload
  | RunCheckpointPausedPayload;

/** Why a run paused. The state's pauseReason and the paused event give the same one. */
export type RunPauseReason = RunPausedPayload["reason"];

export interface RunErrorPayload extends RunEventOrigin {
  error: WorkflowError;
  /** Strict-JSON projection of `error`; added to the live payload for durable consumers. */
  errorRecord: WorkflowRecordedError;
}

export interface RunStoppedPayload extends RunEventOrigin {}
export interface RunResumedPayload extends RunEventOrigin {}

export type RunLogEvent = { type: "log" } & RunLogPayload;
export type RunPhaseEvent = { type: "phase" } & RunPhasePayload;
export type RunAgentStartEvent = { type: "agentStart" } & RunAgentStartPayload;
export type RunAgentEndEvent = { type: "agentEnd" } & RunAgentEndPayload;
export type RunAgentHistoryEvent = { type: "agentHistory" } & RunAgentHistoryPayload;
export type RunTokenUsageEvent = { type: "tokenUsage" } & RunTokenUsagePayload;
export type RunCompleteEvent = { type: "complete" } & RunCompletePayload;
export type RunJournalEvent = { type: "journal" } & RunJournalPayload;
export type RunCallRecordEvent = { type: "callRecord" } & RunCallRecordPayload;
export type RunPausedEvent = { type: "paused" } & RunPausedPayload;
export type RunErrorEvent = { type: "error" } & RunErrorPayload;
export type RunStoppedEvent = { type: "stopped" } & RunStoppedPayload;
export type RunResumedEvent = { type: "resumed" } & RunResumedPayload;

/** Engine-manager events only; the SDK adds the specialized agentEvent branch. */
export type EngineRunEvent =
  | RunLogEvent
  | RunPhaseEvent
  | RunAgentStartEvent
  | RunAgentEndEvent
  | RunAgentHistoryEvent
  | RunTokenUsageEvent
  | RunCompleteEvent
  | RunJournalEvent
  | RunCallRecordEvent
  | RunPausedEvent
  | RunErrorEvent
  | RunStoppedEvent
  | RunResumedEvent;

/** Engine events admitted by the frozen persistence policy. */
export type PersistableEngineRunEvent = Exclude<EngineRunEvent, RunAgentHistoryEvent>;

export type RunEventPayload<Event extends { type: string }> =
  Event extends unknown ? Omit<Event, "type"> : never;

export type EngineRunEventName = EngineRunEvent["type"];
export type EngineRunEventPayloadMap = {
  [Name in EngineRunEventName]: RunEventPayload<Extract<EngineRunEvent, { type: Name }>>;
};

/** Bounded JSON text for an otherwise-unbounded strict-JSON value. */
export interface RunEventValueProjection {
  preview: string;
  redacted: boolean;
  truncated: boolean;
}

export interface RunEventCheckpointProjection
  extends Omit<CheckpointContext, "prompt" | "choices"> {
  prompt: string;
  choices?: string[];
}

export interface RunEventErrorProjection
  extends Omit<
    WorkflowRecordedError,
    "name" | "message" | "agentLabel" | "details" | "resetHint" |
    "authContext" | "checkpointContext" | "props" | "value"
  > {
  name?: string;
  message?: string;
  agentLabel?: string;
  details?: RunEventValueProjection;
  resetHint?: string;
  authContext?: AuthErrorContext;
  checkpointContext?: RunEventCheckpointProjection;
  props?: RunEventValueProjection;
  value?: RunEventValueProjection;
}

export interface PersistedRunAgentEndPayload
  extends Omit<RunAgentEndPayload, "result" | "errorRecord" | "session"> {
  result: RunEventValueProjection;
  errorRecord?: RunEventErrorProjection;
}

export interface PersistedRunJournalEntry extends Omit<JournalEntry, "result" | "session"> {
  result: RunEventValueProjection;
}

export interface PersistedRunJournalPayload extends RunEventOrigin {
  entry: PersistedRunJournalEntry;
}

export interface PersistedRunCallRecord extends Omit<WorkflowCallRecord, "error"> {
  error?: RunEventErrorProjection;
}

export interface PersistedRunCallRecordPayload extends RunEventOrigin {
  record: PersistedRunCallRecord;
}

export interface PersistedRunCompleteSummary {
  status: "completed";
  workflowName: string;
  agentCount: number;
  durationMs: number;
  phaseCount: number;
  callCount: number;
  tokenUsage?: TokenUsage;
  result: RunEventValueProjection;
}

export interface PersistedRunCompletePayload extends RunEventOrigin {
  summary: PersistedRunCompleteSummary;
}

/** Rows written by the earlier interrupting `pause()`, which recorded no reason. Never produced now. */
export interface PersistedRunUnreasonedPausedPayload extends RunEventOrigin {
  reason?: never;
  errorRecord?: never;
  resetHint?: never;
  authContext?: never;
  checkpointContext?: never;
}

export interface PersistedRunRequestedPausedPayload extends RunEventOrigin {
  reason: RequestedPauseReason;
  errorRecord: RunEventErrorProjection;
}

export interface PersistedRunUsageLimitPausedPayload extends RunEventOrigin {
  reason: "usage_limit";
  errorRecord: RunEventErrorProjection;
  resetHint?: string;
}

export interface PersistedRunAuthPausedPayload extends RunEventOrigin {
  reason: "auth_required";
  errorRecord: RunEventErrorProjection;
  authContext?: AuthErrorContext;
}

export interface PersistedRunCheckpointPausedPayload extends RunEventOrigin {
  reason: "checkpoint_required";
  errorRecord: RunEventErrorProjection;
  checkpointContext?: RunEventCheckpointProjection;
}

export type PersistedRunPausedPayload =
  | PersistedRunUnreasonedPausedPayload
  | PersistedRunRequestedPausedPayload
  | PersistedRunUsageLimitPausedPayload
  | PersistedRunAuthPausedPayload
  | PersistedRunCheckpointPausedPayload;

export interface PersistedRunErrorPayload extends RunEventOrigin {
  errorRecord: RunEventErrorProjection;
}

export type PersistedRunEvent =
  | RunLogEvent
  | RunPhaseEvent
  | RunAgentStartEvent
  | ({ type: "agentEnd" } & PersistedRunAgentEndPayload)
  | RunTokenUsageEvent
  | ({ type: "complete" } & PersistedRunCompletePayload)
  | ({ type: "journal" } & PersistedRunJournalPayload)
  | ({ type: "callRecord" } & PersistedRunCallRecordPayload)
  | ({ type: "paused" } & PersistedRunPausedPayload)
  | ({ type: "error" } & PersistedRunErrorPayload)
  | RunStoppedEvent
  | RunResumedEvent;

export const RUN_EVENT_LOG_VERSION = 1 as const;

export interface RunEventLogRecord {
  version: typeof RUN_EVENT_LOG_VERSION;
  /** Writer-generated generation ID; stable across resume, different after delete/recreate. */
  streamId: string;
  runId: string;
  seq: number;
  timestamp: string;
  event: PersistedRunEvent;
  projection: {
    redacted: boolean;
    truncated: boolean;
  };
}

// The report an isolation run saved with its state. Isolation runs are gone, but a run file
// written before may still hold one, so its shape stays.
import type { AgentUsage } from "./steps/agent-run.js";
import type { WorkflowErrorCode, WorkflowRecordedError } from "./errors.js";

export const REPLAY_DIVERGENCE_KINDS = Object.freeze([
  "path-unavailable",
  "nested-workflow-call",
  "identity-reexecuted",
  "target-site-reexecuted",
  "dependent-or-drifted-target",
  "ambiguous-path",
  "unrecorded-call",
  "target-inputs-drift",
  "target-unsettled",
  "candidate-fallback",
  "checkpoint-context-unavailable",
] as const);

type ReplayDivergenceKind = (typeof REPLAY_DIVERGENCE_KINDS)[number];

export interface ResolvedIsolationTarget {
  recordedIndex: number;
  hash: string;
  path: string;
  inputsHash: string;
  model?: string;
}

export interface ReplayDivergenceEvent {
  kind: ReplayDivergenceKind;
  liveCallIndex?: number;
  path?: string;
  candidateIndexes?: number[];
  detail: string;
}

export interface ReplayCallReport {
  liveIndex: number;
  recordedIndex?: number;
  kind: "agent" | "checkpoint";
  mode: "served" | "live-target";
  hashMatched: boolean;
  label?: string;
  recordedFailure?: boolean;
  recordedError?: WorkflowRecordedError;
  recordedUsage?: AgentUsage;
  liveResult?: unknown;
  liveUsage?: AgentUsage;
  attempts?: number;
  modelRequested?: string;
  overrideModel?: string;
  resolvedModel?: string;
  modelFallbacks?: string[];
  backendId?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  candidateEvidence?: "verified" | "unverified";
}

export interface ReplayReport {
  baselineRunId: string;
  isolationRunId: string;
  targets: ResolvedIsolationTarget[];
  calls: ReplayCallReport[];
  divergence?: ReplayDivergenceEvent;
  unvisitedRecordedIndexes?: number[];
  unreachedTargets?: number[];
  unverifiedTargets?: number[];
  targetUnsettled?: number[];
  finalized: boolean;
  notes: string[];
}

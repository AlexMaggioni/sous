// What a run returns and records: its result, its journal, its calls and its resume report.

import type { AgentResultProvenance, AgentUsage, ContinuationSkipReason } from "./steps/agent-run.js";
import type { AuthErrorContext, CheckpointContext, WorkflowRecordedError } from "./errors.js";

/** Aggregate token/cost usage for a whole run (engine-summed; matches the
 *  onTokenUsage shape at workflow.ts:112-119). */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

/** The `export const meta = {...}` literal parsed from the head of a script. */
export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
  /** Default model for agents whose phase has no route and that set no model. */
  model?: string;
  // The fields below are as the script wrote them. workflowExtras checks them and gives them types.
  inputs?: unknown;
  outputs?: unknown;
  /** The shape of the workflow's result, a JSON schema. */
  schema?: unknown;
  place?: unknown;
  concurrency?: unknown;
  startedBy?: unknown;
  timeout?: unknown;
  schedule?: unknown;
  /** The cap on the run's calls. With none, the run has no cap. */
  maxAgents?: unknown;
  /** How deep workflow() may nest. With none, there is no cap. */
  maxNestingDepth?: unknown;
}

/**
 * The handle for ONE session a step opened on a harness. The steps module builds it from
 * the session id the harness reports and hands it out through StepRequest.onSessionOpen,
 * never through run()'s return value. A later call continues the session when the engine
 * passes it back as StepRequest.continueFromSession. It holds no secrets and is
 * JSON-round-trippable, since journal entries and run results keep it.
 */
export interface AgentSessionRef {
  /** The session id the harness reported: a Claude Code session or a Codex thread. */
  sessionId: string;
  /** The backend that owns the session (built-in id or registered custom name). */
  backendId: string;
  /** The harness id, the same as backendId. A continuation goes ahead only when both name the
   *  harness the call routes to. Otherwise the call runs fresh (`backend-mismatch`). ADDITIVE
   *  and NOT a hash input. Older refs may lack it. */
  poolKey?: string;
  /** Recursively frozen JSON snapshot of initialize-response `_meta`, when the agent sent it. */
  initializeMeta?: Readonly<Record<string, unknown>>;
  /** ABSOLUTE working directory the session was opened with. Sessions are cwd-scoped on
   *  agents that key their stores by workspace — pass this back when re-opening. */
  cwd: string;
  /** Which re-open paths the agent advertised at initialize (NegotiatedCapabilities). */
  reopen: {
    /** `session/load` — re-open WITH history replay (`runner.loadSession`). */
    load: boolean;
    /** `session/resume` — re-open WITHOUT replay (`runner.resumeSession`). */
    resume: boolean;
    /** `session/list` — enumerable via `runner.listSessions`. */
    list: boolean;
    /** `session/fork` — driven via `runner.forkSession()`; optional for pre-fork records. */
    fork?: boolean;
  };
  /** The model the session was on when this ref was captured, as a routing spec that leads back
   *  to the same backend (`<backendId>/<model id>`, e.g. `"claude/opus[1m]"`). Present only when a
   *  model was SELECTED on the session (`session/set_config_option`); a session left on its
   *  backend's default records none. A reopen by ref selects it again, because what an agent
   *  restores by itself differs: Codex returns to the session's model, while
   *  Claude lets `ANTHROPIC_MODEL` / `settings.model` outrank it. ADDITIVE and NOT a hash input. */
  model?: string;
  /** The session's latest CUMULATIVE cost gauge (`usage_update.cost.amount`, in the agent's
   *  currency) observed when this ref was captured — the session's total so far, not any one
   *  call's spend. A reopened or forked session's gauge can carry this total forward (every
   *  built-in that reports cost does on `session/resume`/`session/load`), so the reopening side
   *  baselines it and reports only the spend that follows. Absent when the agent reported no
   *  cost. ADDITIVE and NOT a hash input. */
  costGauge?: number;
}

/** One run's session ref PLUS its workflow-call context — what lands in JournalEntry.session,
 *  the agent snapshot, and WorkflowRunResult.agentSessions. `keptOpen` records whether the
 *  release-time best-effort `session/close` was SKIPPED, as for every step of a session handle. */
export interface AgentSessionRecord extends AgentSessionRef {
  /** The owning agent() call's deterministic index (same key as JournalEntry.index). */
  callIndex: number;
  label: string;
  phase?: string;
  keptOpen: boolean;
}

/** One notice observed while serving an agent() call: a continuation attempt on resume. */
export interface WorkflowRunFallback {
  /** The owning agent() call's deterministic index. */
  callIndex: number;
  label: string;
  phase?: string;
  /** For continuation: the model spec the engine asked the runner to serve on the continued
   *  call (identical to the interrupted call's — the hash proves it). */
  requestedSpec: string;
  /** Actual backend that opened the session, when the runner reported one. */
  backendId?: string;
  kind: "continuation";
  /** The human-readable line emitted to the workflow log. */
  message: string;
  /** Present when — and only when — the engine emits `kind: "continuation"`. See the emission
   *  invariant; the type keeps it structurally optional so the flat interface stays non-breaking
   *  and no consumer must switch on `kind` to parse. */
  continuation?:
    | { outcome: "reattached"; method: "resume" | "load" }
    | { outcome: "skipped"; reason: ContinuationSkipReason };
}

/** How a checkpoint() decision was obtained in this execution. */
export type WorkflowCheckpointSource = "live" | "journal-replay" | "injected";

/** One checkpoint() call that resolved during a workflow execution. */
export interface WorkflowCheckpointTaken {
  callIndex: number;
  kind: "confirm" | "input" | "select";
  /** The exact decision value stored in (or replayed from) the journal. */
  decision: unknown;
  source: WorkflowCheckpointSource;
}

/** Same-run continuation telemetry. This is intentionally not a replay/fork report. */
export interface WorkflowContinuationResult {
  generation: number;
  replayedPrefix: number;
  /** This generation runs a revised script: unchanged calls replay by identity, the rest run live. */
  scriptRevised?: true;
}

/** One cached agent()/checkpoint() result, keyed by its deterministic call index
 *  (PersistedRunState.journal, run-persistence.ts). The frozen AgentResult MUST
 *  round-trip through this JSON unchanged for resume. */
export type JournalCallMetadata =
  | {
      kind: "agent";
      label: string;
      phase?: string;
      /** Resolved model when the runner reported one; otherwise the engine's best-known spec. */
      model?: string;
      /** Actual backend from onSessionOpen; absent when the runner supplied no session ref. */
      backendId?: string;
      /** Diagnostic-only: present when this result was produced by reattaching to a paused session
       *  and continuing the interrupted turn, and which reopen method reattached. NOT part of
       *  replay identity — replay restores it verbatim (`workflow.ts` replayPreparedAgent) and never
       *  consults it; the run-event journal projection preserves it (`run-observability.ts`). */
      continuation?: { method: "resume" | "load" };
    }
  | {
      kind: "checkpoint";
      label: "checkpoint";
      phase?: string;
    };

export interface JournalEntry {
  /** Required on checkpoint results; absent/older provenance cannot authorize replay. */
  checkpointDecision?: "explicit-v1";
  index: number;
  /** sha256 of the call identity (prompt + model + phase + agentType + agentDef + schema, and a tier that is always null). */
  hash: string;
  result: unknown;
  /** The call's session record, when one was opened live. ADDITIVE: absent on
   *  pre-session-ref journals and on checkpoint entries; replay restores it as-is. */
  session?: AgentSessionRecord;
  /** Additive diagnostic metadata; it is not part of replay identity. */
  call?: JournalCallMetadata;
  /** Which primitive journaled this entry. Absent on old journals ("unknown"). */
  kind?: "agent" | "checkpoint";
  /** The logical call's provider-reported usage: the per-call sum. Absent on old
   *  journals, on checkpoint entries, and when no attempt reported in time. A
   *  present value is a LOWER BOUND on true spend. The chars/4 estimate is never
   *  written here. Replay carries it verbatim. */
  usage?: AgentUsage;
  /** The emitting engine run's runId. Absent on old journals (treated as root).
   *  The manager persists only root-scope entries. */
  scope?: string;
}

/** Resume correspondence policy selected for a manager-prepared new execution. */
export type ResumePolicy = "auto" | "positional";

/** "occurrence": the n-th call with a key took the n-th recorded call with that key. */
export type WorkflowResumeMatch = "path-hash" | "unique-hash" | "index-hash" | "occurrence";

export type WorkflowResumeFallbackReason =
  | "legacy-recording"
  | "crash-residue"
  | "unsafe-recording"
  | "nested-workflows"
  | "legacy-resume";

export type WorkflowResumeDisabledReason =
  | "unsupported-format"
  | "source-not-terminal"
  | "abort-residue"
  | "isolation-recording"
  | "resume-metadata-missing"
  | "manifest-invalid"
  | "cwd-mismatch"
  | "runtime-mismatch"
  | "environment-missing"
  | "environment-mismatch"
  | "source-environment-drift"
  | "resume-seed-invalid";

export type WorkflowResumeCallLiveReason =
  | "strategy-live"
  | "positional-miss"
  | "positional-suffix"
  | "not-recorded"
  | "path-missing"
  | "inputs-missing"
  | "inputs-changed"
  | "ambiguous-identity"
  | "ambiguous-content"
  | "candidate-consumed"
  | "empty-output"
  | "worktree-degraded";

export type WorkflowResumeCallFailedReason =
  | "seed-persistence-error"
  | "resume-fatal-latch";

export interface WorkflowCallReplayProvenance {
  sourceRunId: string;
  recordedIndex: number;
  match: WorkflowResumeMatch;
  /** Checkpoints only: diagnostic origin marker for a host-confirmed or injected
   *  decision. It never determines whether a completed checkpoint can replay. */
  checkpointHostDecision?: true;
  checkpointInjected?: true;
}

export type WorkflowResumeCallDecision =
  | {
      index: number;
      kind: "agent" | "checkpoint";
      action: "replayed";
      sourceRunId: string;
      recordedIndex: number;
      match: WorkflowResumeMatch;
      reason?: never;
      checkpointInjected?: true;
    }
  | {
      index: number;
      kind: "agent" | "checkpoint";
      action: "live";
      reason: WorkflowResumeCallLiveReason;
      sourceRunId?: never;
      recordedIndex?: never;
      match?: never;
      checkpointInjected?: never;
    }
  | {
      index: number;
      kind: "agent" | "checkpoint";
      action: "failed";
      reason: WorkflowResumeCallFailedReason;
      sourceRunId?: never;
      recordedIndex?: never;
      match?: never;
      checkpointInjected?: never;
    };

interface WorkflowResumeReportBase {
  sourceRunId: string;
  requestedPolicy: ResumePolicy;
  replayed: number;
  live: number;
  failed: number;
  /** One decision per root call, ordered by current execution index. */
  calls: WorkflowResumeCallDecision[];
}

export type WorkflowResumeReport = WorkflowResumeReportBase &
  (
    | {
        strategy: "identity-v1";
        fallbackReason?: never;
        disabledReason?: never;
        eligibility?: never;
      }
    | {
        strategy: "positional-v1";
        fallbackReason: WorkflowResumeFallbackReason;
        eligibility: "legacy" | "safe-prefix" | "all-live";
        disabledReason?: never;
      }
    | {
        strategy: "live";
        disabledReason: WorkflowResumeDisabledReason;
        fallbackReason?: never;
        eligibility?: never;
      }
    | {
        /** Each call took the recorded call with its key and occurrence. */
        strategy: "occurrence-v1";
        fallbackReason?: never;
        disabledReason?: never;
        eligibility?: never;
      }
  );

export type WorkflowReplayOperationalOption =
  | "agentRetries"
  | "concurrency";

/** One operational run-bound change observed between a resume source and its new run.
 *  These values are diagnostic only and never gate replay eligibility. */
export interface WorkflowReplayOperationalChange {
  option: WorkflowReplayOperationalOption;
  source: number | null;
  current: number | null;
  detail: string;
}

export type WorkflowReplayProvenanceField =
  | "runtime.node"
  | "runtime.v8"
  | "environment.identity"
  | "environment.git.head"
  | "environment.git.dirtyDigest";

/** One recorded-world difference observed between a resume source and its new run.
 *  These values are provenance only and never gate admission, strategy, or replay. */
export interface WorkflowReplayProvenanceChange {
  field: WorkflowReplayProvenanceField;
  source: string | null;
  current: string | null;
  detail: string;
}

export interface WorkflowReplayFirstNonReplay {
  index: number;
  action: "live" | "failed";
  reason:
    | WorkflowResumeCallLiveReason
    | WorkflowResumeCallFailedReason
    | WorkflowResumeDisabledReason
    | WorkflowResumeFallbackReason;
  /** A safe diagnostic that says why the call did not replay, when known. */
  detail?: string;
}

interface WorkflowReplayEligibilityBase {
  sourceRunId: string;
  /** Admission-time upper bound from the durable source prefix. Actual call identity
   *  and inputs are still checked before any result is replayed. */
  predictedReplayablePrefix: number;
  /** Contiguous replayed prefix observed so far in the new run. */
  replayedPrefix: number;
  replayed: number;
  live: number;
  failed: number;
  firstNonReplay?: WorkflowReplayFirstNonReplay;
  sourceEngineVersion?: string;
  currentEngineVersion: string;
  engineVersionComparison: "same" | "different" | "source-unknown";
  sourceInputsFormat?: number;
  currentInputsFormat: number;
  /** Additive for persisted eligibility records written before provenance diagnostics. */
  provenanceChanges?: WorkflowReplayProvenanceChange[];
  operationalChanges: WorkflowReplayOperationalChange[];
}

/** Bounded resume plan and progress summary kept on the run.
 *  The full per-call decisions remain in WorkflowResumeReport. */
export type WorkflowReplayEligibility = WorkflowReplayEligibilityBase &
  (
    | {
        strategy: "identity-v1";
        fallbackReason?: never;
        disabledReason?: never;
        eligibility?: never;
      }
    | {
        strategy: "positional-v1";
        fallbackReason: WorkflowResumeFallbackReason;
        eligibility: "legacy" | "safe-prefix" | "all-live";
        disabledReason?: never;
      }
    | {
        strategy: "live";
        disabledReason: WorkflowResumeDisabledReason;
        fallbackReason?: never;
        eligibility?: never;
      }
    | {
        /** Each call took the recorded call with its key and occurrence. */
        strategy: "occurrence-v1";
        fallbackReason?: never;
        disabledReason?: never;
        eligibility?: never;
      }
  );

/** One record per TERMINATED call of an engine run, emitted at the call's terminal
 *  transition — including calls that never journal (failures, caught throws,
 *  engine-side deaths, aborts). What the journal is to results, this is to structure. */
export interface WorkflowCallRecord {
  /** Required on journaled checkpoint results, including replayed explicit decisions. */
  checkpointDecision?: "explicit-v1";
  /** Same space as JournalEntry.index. */
  index: number;
  kind: "agent" | "checkpoint";
  /** hashAgentCall / hashCheckpoint at call time. Present on every record. */
  hash: string;
  /** The structural call-path key, when captured. */
  path?: string;
  /** hashCallInputs() for an agent or hashCheckpointInputs() for a checkpoint,
   *  when the corresponding strict fingerprint was computable. */
  inputsHash?: string;
  /** options.label as resolved by the engine (agent calls). */
  label?: string;
  /** "result" — a value returned to the script; "null" — recoverable exhaustion
   *  resolved null; "error" — a throw propagated into the script (catchable there). */
  outcome: "result" | "null" | "error";
  /** Which mechanism terminated the call. */
  origin: "runner" | "journal-replay" | "confirm" | "engine";
  /** REQUIRED on outcome "null"/"error", forbidden on "result": the projection of
   *  the terminal error/thrown value. */
  error?: WorkflowRecordedError;
  /** True exactly on the signal-abort exits. */
  aborted?: boolean;
  /** Runner attempts that ran (origin "runner"; >=1). */
  attempts?: number;
  /** The logical call's usage: the per-call sum — present for failed calls too.
   *  A LOWER BOUND. Journal-replayed calls carry the entry's usage verbatim. */
  usage?: AgentUsage;
  /** The REQUESTED (script-resolved) model spec the engine passed to the runner.
   *  This is what the hash proves. NOT the served model. */
  modelRequested?: string;
  /** The mode this call set, which is part of its identity. */
  modeRequested?: string;
  /** The configOptions a call set when steps still took them. Older records may hold it. Nothing sets it now. */
  configOptionsRequested?: Record<string, string | boolean>;
  /** The runner-reported concrete model id from the terminal attempt. */
  modelResolved?: string;
  /** The terminal attempt's runner-reported backendId, when reported. */
  backendId?: string;
  /** True when the engine created a git worktree for this call. */
  worktree?: boolean;
  /** The resolved isolation request at call time; absent when none. */
  isolation?: "worktree";
  /** The post-resolution execution directory handed to the runner. */
  resolvedCwd?: string;
  /** Manager-owned provenance for a resumeFromRunId journal replay. */
  replay?: WorkflowCallReplayProvenance;
  /** 1-based position of this call's terminal transition in the run's settlement
   *  sequence. */
  settlementOrdinal?: number;
  /** The terminal attempt's runner-reported result provenance. Permitted only on
   *  origin "runner" rows. */
  provenance?: AgentResultProvenance;
  /** The emitting engine run's runId. Manager persists root-scope records only. */
  scope?: string;
}

/** Host-resolved execution bounds in force for one run. */
export interface WorkflowRunLimits {
  /** The cap on the run's agent, code and checkpoint calls. None when unset. */
  maxAgents?: number;
  concurrency: number;
  agentRetries: number;
}

/** A run's status, as its saved state gives it. A host-facing WorkflowRunResult
 *  always carries a TERMINAL value: "completed" | "paused" | "failed" | "aborted". */
export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

/**
 * The PUBLIC, host-facing result of a workflow run — also the MCP tool's
 * structuredContent shape. It is the engine's `runWorkflow<T>()` return
 * (meta/result/logs/phases/agentCount/durationMs/runId/tokenUsage) PLUS the run-manager's
 * terminal status trio
 * (status/reason/resetHint).
 *
 * The ENGINE SEAM IS UNCHANGED: bare `runWorkflow()` returns
 *   Omit<WorkflowRunResult<T>, "status" | "reason" | "resetHint">  (runId optional there)
 * and the WorkflowManager STAMPS status/reason/resetHint on top and guarantees runId.
 * So hosts get a complete, resumable result without widening the engine's return.
 */
export interface WorkflowRunResult<T = unknown> {
  /** Stable id; MCP continuation keeps this exact identity. */
  runId: string;
  /** Terminal status. "paused" => resumable (usage limit / auth / durable checkpoint). */
  status: RunStatus;
  /** The script's parsed `meta`. */
  meta: WorkflowMeta;
  /** The value the script's top level resolved to (must be JSON-serializable). */
  result: T;
  /** Phase titles in declaration/visit order. */
  phases: string[];
  /** Number of agent() calls executed (live + replayed). */
  agentCount: number;
  /** Wall-clock duration (ms). */
  durationMs: number;
  /** Aggregate token/cost usage (omitted if never measured). */
  tokenUsage?: TokenUsage;
  /** Captured log lines. */
  logs: string[];
  /** Present when status !== "completed": human-readable cause (e.g. "usage_limit",
   *  "auth_required", "checkpoint_required"). NOT the machine-readable contract — hosts branch
   *  on `reason`, then read the corresponding structured context when present. */
  reason?: string;
  /** Provider reset hint for a usage-limit pause (verbatim, e.g. "Resets in ~3h"). */
  resetHint?: string;
  /** Present when a run paused with reason "auth_required" (§2.12): the structured, NON-SECRET
   *  auth surface (backendId + advertised method ids/types/names). Carries no credential
   *  material (Principle 9). Hosts read this — never the `reason` message string. */
  authContext?: AuthErrorContext;
  /** Present when status is "paused" with reason "checkpoint_required": the structured,
   *  NON-SECRET pending checkpoint surface a host uses to collect and resume with a reply. */
  checkpointContext?: CheckpointContext;
  /** Session records for every session the run opened (live + journal-replayed), in call
   *  order. */
  agentSessions?: AgentSessionRecord[];
  /** Model-selection degrades observed on live agent calls. Absent when none occurred. */
  fallbacks?: WorkflowRunFallback[];
  /** Checkpoint calls resolved in this execution. Absent when none resolved. */
  checkpointsTaken?: WorkflowCheckpointTaken[];
  /** Present after an in-place continuation of this run. */
  continuation?: WorkflowContinuationResult;
  /** The engine-owned authoritative manifest: one frozen record per terminated call. */
  calls?: WorkflowCallRecord[];
  /** Manager-owned correspondence report for a resumeFromRunId execution. */
  resumeReport?: WorkflowResumeReport;
  /** Bounded admission/progress summary for a resumeFromRunId execution. */
  replayEligibility?: WorkflowReplayEligibility;
  /** Final number of agent()/checkpoint() call indexes allocated by this engine run. */
  callsAllocated?: number;
  /** The resolved execution inputs in force for this engine run. */
  effectiveLimits?: WorkflowRunLimits;
  /** Set iff the composed signal was ever observed aborted. */
  abortSignaled?: true;
  /** True when this run invoked workflow(), including a zero-call child workflow. */
  nestedWorkflows?: true;
}

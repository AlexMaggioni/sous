/**
 * The manager of one orc run, set up by the run's worker. It starts or resumes the run, pauses
 * it, saves its state and publishes its events.
 *
 * The agent steps go to the injected `AgentRunner` (steps/agent-runner.ts). The manager never
 * builds a concrete agent. It builds the `WorkflowRunResult`, with the run's status, on top of
 * the engine's bare `EngineRunResult`. `runSync`, the worker's path, resolves to a final result
 * even when the run pauses, fails or stops, so the worker reads `run.status` with no try/catch.
 */

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { AgentRunner } from "./steps/agent-runner.js";
import type {
  AgentSessionRecord,
  JournalEntry,
  TokenUsage,
  WorkflowCallRecord,
  WorkflowCheckpointTaken,
  WorkflowContinuationResult,
  WorkflowMeta,
  WorkflowRunFallback,
  WorkflowRunResult,
} from "./workflow-result.js";
import type {
  EngineRunEvent,
  EngineRunEventName,
  EngineRunEventPayloadMap,
  PersistableEngineRunEvent,
  RequestedPauseReason,
  RunPausedPayload,
  RunPauseReason,
} from "./run-events.js";
import { foldStep, preview, recomputeWorkflowSnapshot, type WorkflowSnapshot } from "./display.js";
import { isAbsolute } from "node:path";
import { errorMessage, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { captureRunEnvironment, type RunEnvironmentIdentity } from "./run-environment.js";
import { isNestedScope } from "./resume-identity.js";
import { journalRows } from "./resume-rows.js";
import { continueRows, handedInRows, newRows, reuseRows, reviseRows, type RunRows } from "./run-rows.js";
import {
  createRunPersistence,
  generateRunId,
  interruptedReason,
  type PersistedResumeFormat,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
  type WorkflowScriptOrigin,
  type WorkflowScriptRevision,
} from "./runs/persistence/run-persistence.js";
import { admitResumeSource } from "./resume-matcher.js";
import { startResumeReport, type ResumeReporting } from "./resume-report.js";
import type {
  ContinuationCandidate,
  OccurrenceResume,
  PreparedContinuation,
} from "./resume.js";
import { hasEventLog, type RunEventLog } from "./runs/persistence/run-event-persistence.js";
import { projectRecordedError } from "./recorded-error.js";
import { workflowHomeDir } from "./workflow-paths.js";
import { cloneStrictJsonValue, deepFreeze } from "./strict-json.js";
import {
  CALL_INPUTS_FORMAT,
  CALL_PATH_FORMAT,
  CHECKPOINT_INPUTS_FORMAT,
  type CheckpointCallContext,
  type CheckpointOptions,
  type EngineRunResult,
  type WorkflowAgentAttemptControl,
  type WorkflowResume,
  type WorkflowRunOptions,
  isStepFailedPause,
  resolveWorkflowRunLimits,
  runWorkflow,
} from "./workflow.js";
import { parseWorkflowScript } from "./workflows/script.js";
import type { RunPlaces } from "./places/places.js";
import { createWorkflowLogTail } from "./run-observability.js";
import { assertExplicitCheckpointProvenance } from "./checkpoint-provenance.js";
import type { CodeStepEnv } from "./code-steps.js";

const ENGINE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export interface ManagedRun {
  runId: string;
  status: RunStatus;
  snapshot: WorkflowSnapshot;
  /** The composed host-facing result (with terminal status), set once the run settles. */
  result?: WorkflowRunResult;
  error?: WorkflowError;
  controller: AbortController;
  /** Fires when a host asks this execution to pause; created lazily so an early request is kept. */
  pauseController?: AbortController;
  startedAt: Date;
  /** When this execution paused. Later saves keep it. */
  pausedAt?: string;
  /** The real script, kept so the run can be resumed. */
  script: string;
  scriptOrigin?: WorkflowScriptOrigin;
  scriptRevisions?: WorkflowScriptRevision[];
  args?: unknown;
  /** True when managed.args is a faithful strict-JSON pre-execution snapshot. */
  argsSnapshotOk: boolean;
  argsUnreplayable?: true;
  /** THIS run's working directory (ExecOptions.cwd), when it overrides the manager cwd.
   *  Persisted so a resume re-runs in the same directory (e.g. the same worktree). */
  cwd?: string;
  /** Parsed meta, kept so a terminal (paused/failed) result can still report it. */
  meta?: WorkflowMeta;
  /** The run's journal, call rows and resume seed: what a resume replays. */
  rows: RunRows;
  /** Result-only observability collected during this execution. */
  fallbacks: WorkflowRunFallback[];
  checkpointsTaken: WorkflowCheckpointTaken[];
  effectiveCwd: string;
  runtime: {
    engineVersion: string;
    node: string;
    v8: string;
    pathFormat: number;
    inputsFormat: number;
    checkpointInputsFormat?: number;
  };
  environment?: RunEnvironmentIdentity;
  continuation?: WorkflowContinuationResult;
  sameRunContinuation?: true;
  resume?: PersistedResumeFormat;
  resumeActivity?: number;
  resumeActivityInvalid?: true;
  resumeFilesystemTainted?: boolean;
  resumeTerminalFinalized?: boolean;
  executionSettled?: boolean;
  environmentKey?: string;
  callsAllocated?: number;
  limits?: NonNullable<WorkflowRunResult["effectiveLimits"]>;
  abortSignaled?: true;
  /** Host-pinned fallback for otherwise unmodelled agent calls in this execution. */
  defaultModel?: string;
  nestedWorkflows?: true;
  legacyResume?: true;
  /** Immediate resumeFromRunId ancestor, fixed when the new run is admitted. */
  readonly resumeSourceRunId?: string;
  /** The resume report, kept current as the engine decides each call. Only a resumed run has one. */
  resumeReporting?: ResumeReporting;
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  eventStreamId?: string;
  eventSeq?: number;
  eventLogIncomplete?: true;
}

/** What a publish needs from a run: its lease and its event watermark. A live run is one. */
type EventPublicationState = Pick<ManagedRun, "runId" | "lease" | "eventStreamId" | "eventSeq" | "eventLogIncomplete">;

interface RunEventPublicationActions {
  beforeLive?: () => void;
  afterLive?: () => void;
}

interface InitializedRun {
  managed: ManagedRun;
  resume?: WorkflowResume;
}

/** Durable acknowledgement for one host-cancelled agent call. */
export interface WorkflowAgentCallCancellation {
  runId: string;
  callIndex: number;
  label: string;
  scope: string;
  errorCode: WorkflowErrorCode.AGENT_CANCELLED;
}

export type WorkflowContinuationStart =
  | { accepted: false }
  | {
      accepted: true;
      runId: string;
      continuation: WorkflowContinuationResult;
      promise: Promise<WorkflowRunResult>;
    };

interface PendingAgentCancellation {
  promise: Promise<WorkflowAgentCallCancellation>;
  resolve: (result: WorkflowAgentCallCancellation) => void;
  reject: (error: WorkflowError) => void;
  settled: boolean;
}

interface RegisteredAgentAttempt extends WorkflowAgentAttemptControl {
  cancellation?: PendingAgentCancellation;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Caller-minted run id. Collision checks happen under the run lease. */
  runId?: string;
  /** Where the script came from; an inline origin gets a working copy in the run store. */
  scriptOrigin?: WorkflowScriptOrigin;
  /** Non-git environment label reported in replay provenance diagnostics only. */
  environmentKey?: string;
  /**
   * The agent backend for THIS run. Overrides the manager's constructor-injected
   * `agent`. Either this or the constructor `agent` must be set, or the run fails
   * with a clear AGENT_EXECUTION_ERROR (the engine never constructs an agent).
   */
  agent?: AgentRunner;
  /**
   * Working directory for THIS run, overriding the manager's constructor `cwd` —
   * the natural fit for hosts that run each workflow inside its own git worktree.
   * Every agent step runs here (unless worktree isolation or a per-agent
   * `agent({ cwd })` overrides it further). Persisted with the run so a resume
   * re-runs in the SAME directory. Run STATE stays keyed to the manager cwd, so
   * resuming a run is unaffected by the per-run directory's lifetime.
   */
  cwd?: string;
  /**
   * Same-run continuation only: the script text read back from the run's file. When it differs
   * from the persisted script, the continuation runs the revision with an identity-matched replay
   * of this run's own journal (unchanged calls replay, the rest run live). A revision must parse.
   */
  script?: string;
  /**
   * A journal with no call rows, by call index (resume). A call replays the row at its own index
   * when the hashes agree.
   */
  resumeJournal?: Map<number, JournalEntry>;
  /** Load this persisted run as the source for a new managed execution. */
  resumeFromRunId?: string;
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** A signal that aborts this run when it fires. orc's worker calls stop() instead. */
  externalSignal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Max concurrent agents for this execution. */
  concurrency?: number;
  /**
   * Host-pinned model/backend for agent calls with no authored model, agentType model or
   * phase/meta route. Persisted with the run and included in call identity.
   */
  defaultModel?: string;
  /** Retry attempts after recoverable agent failures for this execution. */
  agentRetries?: number;
  /** Answer a checkpoint() question with a person's reply. orc's worker asks it through the inbox. */
  confirm?: (
    promptText: string,
    options: CheckpointOptions,
    context?: CheckpointCallContext,
  ) => Promise<unknown>;
  /** Called synchronously when workflow() allocates a unique child-run ordinal. */
  onNestedWorkflow?: (ordinal: number, childRunId: string) => void;
  /** Per-run changes to steps, by label. Pass them again on resume. */
  stepOverrides?: Record<string, Record<string, unknown>>;
  /** The environment code steps run with. Pass it again on resume. */
  codeEnv?: CodeStepEnv;
}

/** Options every run of a manager gets. */
export interface OrchestratorOptions extends Pick<WorkflowRunOptions, "maxNestingDepth" | "listSavedWorkflows"> {
  /** The places of a run tree, from its root run's id. A run without them has none. */
  places?: (rootRunId: string) => RunPlaces;
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Options every run gets, such as the nesting limit and nested places. */
  orchestrator?: OrchestratorOptions;
  /**
   * The injected agent backend (the frozen AgentRunner seam). May be overridden
   * per-run via ExecOptions.agent. The engine depends on this injection and never
   * constructs an agent itself.
   */
  agent?: AgentRunner;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /**
   * Absolute workflow persistence root. Precedence is this explicit option >
   * ORCHESTRATOR_PERSISTENCE_ROOT > `~/.orchestrator/engine`.
   */
  persistenceRoot?: string;
  /**
   * Custom run persistence implementation. When omitted, the manager constructs
   * the default filesystem persistence for `cwd` and `persistenceRoot`. The manager keeps
   * a run's events only when the store has `appendEvent` and `readEvents`.
   */
  persistence?: RunPersistence;
  /** Default non-git environment label for replay provenance diagnostics. */
  environmentKey?: string;
}

type ArgsSnapshot = { ok: true; clone: unknown } | { ok: false };

function snapshotArgs(value: unknown): ArgsSnapshot {
  if (value === undefined) return { ok: true, clone: undefined };
  const captured = cloneStrictJsonValue(value);
  return captured.ok ? { ok: true, clone: captured.clone } : { ok: false };
}

function runtimeIdentity(): ManagedRun["runtime"] {
  return {
    engineVersion: ENGINE_VERSION,
    node: process.version,
    v8: process.versions.v8,
    pathFormat: CALL_PATH_FORMAT,
    inputsFormat: CALL_INPUTS_FORMAT,
    checkpointInputsFormat: CHECKPOINT_INPUTS_FORMAT,
  };
}

/** A saved run whose inputs hashes this build computes the same way pairs on them too. */
function pairingKey(saved: PersistedRunState["runtime"], current: ManagedRun["runtime"]): "inputs" | "hash" {
  return saved?.inputsFormat === current.inputsFormat &&
      saved?.checkpointInputsFormat === current.checkpointInputsFormat
    ? "inputs"
    : "hash";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function isContinuationSession(
  value: unknown,
): value is AgentSessionRecord & { cwd?: string } {
  if (!isRecord(value) || !isRecord(value.reopen)) return false;
  return (
    typeof value.sessionId === "string" &&
    typeof value.backendId === "string" &&
    (value.cwd === undefined || typeof value.cwd === "string") &&
    isOptionalString(value, "poolKey") &&
    isOptionalString(value, "model") &&
    (value.costGauge === undefined ||
      (typeof value.costGauge === "number" && Number.isFinite(value.costGauge) && value.costGauge >= 0)) &&
    typeof value.reopen.load === "boolean" &&
    typeof value.reopen.resume === "boolean" &&
    typeof value.reopen.list === "boolean" &&
    (value.reopen.fork === undefined || typeof value.reopen.fork === "boolean") &&
    isNonNegativeSafeInteger(value.callIndex) &&
    typeof value.label === "string" &&
    isOptionalString(value, "phase") &&
    typeof value.keptOpen === "boolean"
  );
}

function hashScriptText(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("hex");
}

/** Whether the run's signal was ever aborted. The result and the saved state both take it. */
function abortSignaledOf(managed: ManagedRun): boolean {
  return managed.abortSignaled === true || managed.controller.signal.aborted;
}

function runReason(status: RunStatus, error: WorkflowError | undefined): string | undefined {
  if (status === "completed" || status === "pending" || status === "running") return undefined;
  if (status !== "paused" || isStepFailedPause(error)) return error?.message;
  return pauseReasonOf(error) ?? error?.message;
}

/**
 * Why a run paused on this error, or undefined when the error does not pause a run. The state's
 * pauseReason, its reason and the paused event all take it, so they cannot disagree.
 */
function pauseReasonOf(error: WorkflowError | undefined): RunPauseReason | undefined {
  switch (error?.code) {
    case WorkflowErrorCode.PROVIDER_USAGE_LIMIT:
      return "usage_limit";
    case WorkflowErrorCode.AUTH_REQUIRED:
      return "auth_required";
    case WorkflowErrorCode.CHECKPOINT_REQUIRED:
      return "checkpoint_required";
    case WorkflowErrorCode.PAUSE_REQUESTED:
      return isStepFailedPause(error) ? stepPauseReason(error.details) : "requested";
    default:
      return undefined;
  }
}

/** What a stop writes over a paused run's saved state: the run is aborted, and nothing of its
 *  pause is left. */
const STOPPED_STATE = {
  status: "aborted",
  reason: undefined,
  errorCode: undefined,
  pauseReason: undefined,
  resetHint: undefined,
  resetAt: undefined,
  pausedAt: undefined,
  authContext: undefined,
  checkpointContext: undefined,
  abortSignaled: true,
} as const satisfies Partial<PersistedRunState>;

/** The paused event for a pause, with the context its reason carries. One case per reason, so a
 *  new reason fails to compile here until it has its own. */
function pausedPayload(runId: string, reason: RunPauseReason, error: WorkflowError): RunPausedPayload {
  const base = { runId, scope: runId, error, errorRecord: projectRecordedError(error) };
  switch (reason) {
    case "requested":
    case "step_failed":
    case "step_stopped":
    case "time_limit":
      return { ...base, reason };
    case "usage_limit":
      return { ...base, reason, resetHint: error.resetHint };
    case "auth_required":
      return { ...base, reason, authContext: error.authContext };
    case "checkpoint_required":
      return { ...base, reason, checkpointContext: error.checkpointContext };
    default: {
      const exhaustive: never = reason;
      throw new TypeError(`Unsupported pause reason ${String(exhaustive)}`);
    }
  }
}

function generateEventStreamId(): string {
  return randomBytes(16).toString("hex");
}

function isPersistableRunEvent(event: EngineRunEvent): event is PersistableEngineRunEvent {
  return event.type !== "agentHistory";
}

export interface PersistedRunStopResult {
  outcome: "stopped" | "already-terminal" | "owned-elsewhere" | "missing";
  state?: PersistedRunState;
}

export interface WorkflowManager {
  addListener<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  on<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  once<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  removeListener<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  off<Name extends EngineRunEventName>(
    eventName: Name,
    listener: (payload: EngineRunEventPayloadMap[Name]) => void,
  ): this;
  emit<Name extends EngineRunEventName>(
    eventName: Name,
    payload: EngineRunEventPayloadMap[Name],
  ): boolean;

  addListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  on(eventName: string | symbol, listener: (...args: any[]) => void): this;
  once(eventName: string | symbol, listener: (...args: any[]) => void): this;
  removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  off(eventName: string | symbol, listener: (...args: any[]) => void): this;
  emit(eventName: string | symbol, ...args: any[]): boolean;
}

/**
 * Stateful workflow run manager. Events are OBSERVABILITY ONLY: listeners are
 * best-effort observers, isolated from sibling listeners and from run execution. A
 * throwing host observer never fails, pauses, aborts, or masks cleanup for the run.
 */
export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private agentAttempts = new Map<string, Set<RegisteredAgentAttempt>>();
  private persistence: RunPersistence;
  /** The store's event log. A store without one, such as a test's in-memory store, keeps no events. */
  private eventLog?: RunEventLog;
  /** The manager's project directory — keys the persistence store and is the default run cwd. */
  readonly cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private orchestratorOptions: OrchestratorOptions;
  private agent?: AgentRunner;
  private defaultAgentRetries: number;
  private persistenceRoot: string;
  private environmentKey?: string;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.orchestratorOptions = options.orchestrator ?? {};
    this.agent = options.agent;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.persistenceRoot = workflowHomeDir({ persistenceRoot: options.persistenceRoot });
    this.environmentKey = options.environmentKey;
    this.persistence = options.persistence
      ?? createRunPersistence(this.cwd, undefined, { persistenceRoot: this.persistenceRoot });
    if (hasEventLog(this.persistence)) this.eventLog = this.persistence;
  }

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const listeners = this.rawListeners(eventName);
    for (const listener of listeners) {
      try {
        // rawListeners() returns EventEmitter's once-wrappers. Calling the wrapper
        // preserves once() self-removal while isolating each observer's throw.
        Reflect.apply(listener, this, args);
      } catch {
        // Manager events are live observability; bad listeners cannot perturb runs.
      }
    }
    return listeners.length > 0;
  }

  /**
   * Reconcile one persisted run whose owning process may have exited. The lease
   * acquisition preserves live/EPERM owners, removes stale or corrupt locks, and
   * the under-lease reload lets a concurrent completion win over recovery.
   */
  reconcileExternallyDeadRun(runId: string): PersistedRunState | undefined {
    const candidate = this.persistence.load(runId);
    if (!candidate) return undefined;
    if (
      this.getRun(runId) !== undefined ||
      (candidate.status !== "pending" && candidate.status !== "running")
    ) {
      return candidate;
    }
    let lease: RunLease | null;
    try {
      lease = this.persistence.acquireRunLease(runId);
    } catch {
      return candidate;
    }
    if (!lease) return candidate;

    try {
      const current = this.persistence.load(runId);
      if (!current) return undefined;
      if (
        this.getRun(runId) !== undefined ||
        (current.status !== "pending" && current.status !== "running")
      ) {
        return current;
      }
      if (!this.persistence.validateRunLease(lease)) return current;
      const reconciled: PersistedRunState = {
        ...current,
        status: "paused",
        pauseReason: "interrupted",
        reason: interruptedReason(lease.recoveredOwnerPid),
      };
      this.persistence.save(reconciled);
      return reconciled;
    } catch {
      return candidate;
    } finally {
      this.persistence.releaseRunLease(lease);
    }
  }

  /** Resolve the agent backend for a run: per-run override wins, else the
   * constructor-injected one. Throws when neither is set (the engine never
   * constructs an agent). */
  private resolveAgent(exec: ExecOptions): AgentRunner {
    const agent = exec.agent ?? this.agent;
    if (!agent) {
      throw new WorkflowError(
        "WorkflowManager requires an AgentRunner — inject one via `new WorkflowManager({ agent })` or pass `runSync(script, args, { agent })`.",
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        { recoverable: false },
      );
    }
    return agent;
  }

  private acquireNewRunIdentity(requestedRunId?: string): { runId: string; lease: RunLease } {
    for (;;) {
      const runId = requestedRunId ?? generateRunId();
      const lease = this.persistence.acquireRunLease(runId);
      if (!lease) {
        if (requestedRunId) {
          throw new WorkflowError(`run id already exists: ${runId}`, WorkflowErrorCode.PERSISTENCE_ERROR, {
            recoverable: false,
          });
        }
        continue;
      }
      let persistedExists: boolean;
      try {
        persistedExists = this.persistence.load(runId) !== null;
      } catch (error) {
        this.persistence.releaseRunLease(lease);
        throw error;
      }
      if (!this.runs.has(runId) && !persistedExists) return { runId, lease };
      this.persistence.releaseRunLease(lease);
      if (requestedRunId) {
        throw new WorkflowError(`run id already exists: ${runId}`, WorkflowErrorCode.PERSISTENCE_ERROR, {
          recoverable: false,
        });
      }
    }
  }

  private scriptValidationError(message: string): WorkflowError {
    return new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
  }

  private persistenceError(message: string, error?: unknown): WorkflowError {
    return new WorkflowError(message, WorkflowErrorCode.PERSISTENCE_ERROR, {
      recoverable: false,
      ...(error === undefined ? {} : { details: error }),
    });
  }

  private validateNewRunOptions(exec: ExecOptions): void {
    validateScriptOrigin(exec.scriptOrigin);
    const hasSource = exec.resumeFromRunId !== undefined;
    if (hasSource && (typeof exec.resumeFromRunId !== "string" || exec.resumeFromRunId.length === 0)) {
      throw this.scriptValidationError("resumeFromRunId must be a non-empty string");
    }
    if (exec.resumeJournal !== undefined && hasSource) {
      throw this.scriptValidationError("resumeJournal is mutually exclusive with resumeFromRunId");
    }
    if (hasSource && exec.runId === exec.resumeFromRunId) {
      throw this.scriptValidationError("runId must differ from resumeFromRunId");
    }
  }

  private acquireResumeSource(runId: string): { lease: RunLease; source: PersistedRunState } {
    let lease: RunLease | null;
    try {
      this.reconcileExternallyDeadRun(runId);
      lease = this.persistence.acquireRunLease(runId);
    } catch (error) {
      throw this.persistenceError(`failed to acquire resume source lease for ${runId}: ${errorMessage(error)}`, error);
    }
    if (!lease) {
      throw this.persistenceError(`resume source is currently leased: ${runId}`);
    }
    try {
      const source = this.persistence.load(runId);
      if (!source) throw this.persistenceError(`resume source does not exist: ${runId}`);
      return { lease, source };
    } catch (error) {
      this.persistence.releaseRunLease(lease);
      if (error instanceof WorkflowError) throw error;
      throw this.persistenceError(`failed to load resume source ${runId}: ${errorMessage(error)}`, error);
    }
  }

  private cloneResumeSourceValue<T>(value: T, runId: string): T {
    try {
      return structuredClone(value);
    } catch (error) {
      throw this.persistenceError(`failed to clone resume source ${runId}: ${errorMessage(error)}`, error);
    }
  }

  /** Build a defensive, snapshot-only continuation projection. Bad persistence can
   *  only remove candidates; it can never make resume throw. */
  private buildPreparedContinuation(
    persisted: PersistedRunState,
  ): PreparedContinuation | undefined {
    if (
      !isRecord(persisted) ||
      persisted.status !== "paused" ||
      (persisted.pauseReason !== "usage_limit" && persisted.pauseReason !== "auth_required") ||
      typeof persisted.runId !== "string"
    ) {
      return undefined;
    }

    const agents = Array.isArray(persisted.agents) ? persisted.agents : [];
    const joinedAgents = new Map<number, AgentSessionRecord & { cwd?: string }>();
    for (const value of agents) {
      if (!isRecord(value)) continue;
      if (value.scope !== undefined && value.scope !== persisted.runId) continue;
      if (value.status !== "error") continue;
      if (!Object.prototype.hasOwnProperty.call(value, "callIndex")) continue;
      if (!isNonNegativeSafeInteger(value.callIndex)) continue;
      if (!isContinuationSession(value.session)) continue;
      if (value.session.callIndex !== value.callIndex) continue;
      if (
        value.errorCode !== WorkflowErrorCode.PROVIDER_USAGE_LIMIT &&
        value.errorCode !== WorkflowErrorCode.AUTH_REQUIRED
      ) {
        continue;
      }
      joinedAgents.set(value.callIndex, value.session);
    }

    const calls = Array.isArray(persisted.calls) ? persisted.calls : [];
    const inputsFormat = isRecord(persisted.runtime) &&
        isNonNegativeSafeInteger(persisted.runtime.inputsFormat)
      ? persisted.runtime.inputsFormat
      : undefined;
    const rootCalls = new Map<number, Record<string, unknown>>();
    for (const value of calls) {
      if (!isRecord(value) || !isNonNegativeSafeInteger(value.index)) continue;
      if (value.scope !== undefined && value.scope !== persisted.runId) continue;
      rootCalls.set(value.index, value);
    }

    const candidatesByIndex = new Map<number, ContinuationCandidate>();
    for (const index of [...rootCalls.keys()].sort((left, right) => left - right)) {
      const record = rootCalls.get(index) as Record<string, unknown>;
      const joined = joinedAgents.get(index);
      if (!joined || record.kind !== "agent" || record.outcome !== "error") continue;
      if (typeof record.hash !== "string") continue;
      if (record.inputsHash !== undefined && typeof record.inputsHash !== "string") continue;
      if (typeof record.backendId !== "string" || joined.backendId !== record.backendId) continue;
      if (record.resolvedCwd !== undefined && typeof record.resolvedCwd !== "string") continue;
      if (
        joined.cwd !== undefined &&
        record.resolvedCwd !== undefined &&
        joined.cwd !== record.resolvedCwd
      ) {
        continue;
      }
      if (joined.reopen.resume !== true && joined.reopen.load !== true) continue;
      const recordedCwd = record.resolvedCwd ?? joined.cwd;
      if (typeof recordedCwd !== "string") continue;
      candidatesByIndex.set(index, {
        callIndex: index,
        hash: record.hash,
        ...(typeof record.inputsHash === "string" ? { inputsHash: record.inputsHash } : {}),
        ...(inputsFormat === undefined ? {} : { inputsFormat }),
        sessionRef: joined,
        recordedCwd,
      });
    }

    return candidatesByIndex.size === 0 ? undefined : { candidatesByIndex };
  }

  /**
   * A run saved by engine 0.23 can hold root rows under the id of the run it came from. Such a
   * row counts as a root row of the source while that run is still saved, and is dropped
   * otherwise. The saved runs are listed only when a row needs it.
   */
  private chainedRows(sourceRunId: string): <T extends { scope?: string }>(rows: T[]) => T[] {
    let saved: ReadonlySet<string> | undefined;
    return (rows) => rows.flatMap((row) => {
      if (row.scope === undefined || row.scope === sourceRunId || isNestedScope(row.scope, sourceRunId)) return [row];
      saved ??= new Set(this.persistence.list().map((state) => state.runId));
      return saved.has(row.scope) ? [{ ...row, scope: sourceRunId }] : [];
    });
  }

  private prepareManagedResume(
    managed: ManagedRun,
    source: PersistedRunState,
  ): WorkflowResume {
    const admission = admitResumeSource({ source, effectiveCwd: managed.effectiveCwd });
    if (source.resume === undefined || source.legacyResume === true) managed.legacyResume = true;
    const preparedContinuation = this.buildPreparedContinuation(source);
    if (admission.strategy === "live") {
      managed.rows = reuseRows(managed.runId).rows;
      managed.resumeReporting = startResumeReport({ plan: admission, source, run: managed, predictedReplayablePrefix: 0 });
      return { plan: admission, ...(preparedContinuation ? { continuation: preparedContinuation } : {}) };
    }

    const chained = this.chainedRows(source.runId);
    const started = reuseRows(managed.runId, {
      sourceRunId: source.runId,
      journal: chained(
        this.cloneResumeSourceValue([...(source.journal ?? []), ...(source.nestedJournal ?? [])], source.runId),
      ),
      calls: chained(this.cloneResumeSourceValue(source.calls ?? [], source.runId)),
      seed: source.resumeSeed,
      key: pairingKey(source.runtime, managed.runtime),
    });
    managed.rows = started.rows;
    managed.resumeReporting = startResumeReport({
      plan: admission,
      source,
      run: managed,
      predictedReplayablePrefix: started.prefix,
    });
    return { rows: started.resume, plan: admission, ...(preparedContinuation ? { continuation: preparedContinuation } : {}) };
  }

  private initializeRun(
    script: string,
    args: unknown | undefined,
    exec: ExecOptions,
  ): InitializedRun {
    this.validateNewRunOptions(exec);
    const source = exec.resumeFromRunId === undefined
      ? undefined
      : this.acquireResumeSource(exec.resumeFromRunId);
    let identity: { runId: string; lease: RunLease } | undefined;
    try {
      identity = this.acquireNewRunIdentity(exec.runId);
      const managed = this.createManaged(script, args, exec, identity);
      const resume = source
        ? this.prepareManagedResume(managed, source.source)
        : undefined;
      this.runs.set(managed.runId, managed);
      if (source || exec.resumeJournal) {
        this.persistRunOrThrow(managed);
      } else {
        this.persistRun(managed);
      }
      return { managed, resume };
    } catch (error) {
      if (identity) this.persistence.releaseRunLease(identity.lease);
      if (identity) this.runs.delete(identity.runId);
      throw error;
    } finally {
      if (source) this.persistence.releaseRunLease(source.lease);
    }
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   *
   * The run is admitted and persisted before this returns, but execution begins on the next
   * macrotask: the concurrency limiter dispatches an agent on the caller's stack when capacity
   * allows, so starting synchronously would let a checkpoint, or even the run's completion, fire
   * before the caller could register interest under the returned run ID.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const { managed, resume } = this.initializeRun(script, args, exec);

    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = new Promise<WorkflowRunResult>((resolve, reject) => {
      setImmediate(() => {
        this.executeRun(managed, script, exec, resume).then(resolve, reject);
      });
    });
    promise.catch(() => {});

    return { runId: managed.runId, promise };
  }

  /**
   * Run a workflow and wait for it to end. The run is tracked like a background run, and
   * `onProgress` fires with the current snapshot on every progress event.
   *
   * Unlike the background path, runSync resolves to a final WorkflowRunResult, with status
   * completed, paused, failed or aborted, even when the run does not complete. The worker reads
   * `run.status` with no try/catch.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const { managed, resume } = this.initializeRun(script, args, exec);
    try {
      return await this.executeRun(managed, script, exec, resume);
    } catch (error) {
      // executeRun settled the run, kept its result, saved it and released the lease before it
      // threw. Return that result, so it agrees with the saved state.
      if (managed.result) return managed.result;
      const wfError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(errorMessage(error), WorkflowErrorCode.UNKNOWN, {
              recoverable: false,
            });
      // A throw from before executeRun's own catch: settle a terminal status here too.
      if (managed.status === "running") {
        managed.status = managed.controller.signal.aborted ? "aborted" : "failed";
        managed.error = wfError;
        this.persistRun(managed);
        this.releaseRunLease(managed);
      }
      return this.composeResult(managed, wfError);
    }
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(
    script: string,
    args: unknown | undefined,
    exec: ExecOptions,
    identity: { runId: string; lease: RunLease },
  ): ManagedRun {
    const meta = parseWorkflowScript(script).meta;
    const capturedArgs = snapshotArgs(args);
    const effectiveCwd = exec.cwd ?? this.cwd;
    const startedAt = new Date();
    return {
      runId: identity.runId,
      cwd: exec.cwd,
      status: "running",
      snapshot: {
        name: meta.name,
        description: meta.description,
        phases: meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt,
      script,
      // Every run keeps an editable working copy of its script in the run store unless
      // the caller recorded the script's own path as its origin.
      scriptOrigin: exec.scriptOrigin ?? { kind: "inline" as const },
      args: capturedArgs.ok ? capturedArgs.clone : args,
      argsSnapshotOk: capturedArgs.ok,
      ...(!capturedArgs.ok ? { argsUnreplayable: true as const } : {}),
      meta,
      rows: exec.resumeJournal
        ? handedInRows(identity.runId, exec.resumeJournal)
        : newRows(identity.runId),
      fallbacks: [],
      checkpointsTaken: [],
      effectiveCwd,
      runtime: runtimeIdentity(),
      environment: captureRunEnvironment(effectiveCwd, exec.environmentKey ?? this.environmentKey),
      resume: { format: "identity-v1" as const },
      resumeActivity: 0,
      resumeFilesystemTainted: false,
      resumeTerminalFinalized: false,
      executionSettled: false,
      environmentKey: exec.environmentKey ?? this.environmentKey,
      callsAllocated: 0,
      limits: resolveWorkflowRunLimits({
        maxAgents: exec.maxAgents,
        concurrency: exec.concurrency ?? this.concurrency,
        agentRetries: exec.agentRetries ?? this.defaultAgentRetries,
      }),
      defaultModel: exec.defaultModel,
      ...(exec.resumeFromRunId ? { resumeSourceRunId: exec.resumeFromRunId } : {}),
      ...(exec.resumeJournal ? { legacyResume: true as const } : {}),
      lease: identity.lease,
      ...(this.eventLog ? { eventStreamId: generateEventStreamId(), eventSeq: 0 } : {}),
    };
  }

  private createRunEvent<Name extends EngineRunEventName>(
    type: Name,
    payload: EngineRunEventPayloadMap[Name],
  ): EngineRunEvent {
    return Object.assign({ type }, payload as object) as unknown as EngineRunEvent;
  }

  private reportPersistenceFailure(error: unknown): void {
    try {
      console.warn("[workflow-manager] Persist run failed:", error);
    } catch {
      // Persistence diagnostics are best-effort.
    }
  }

  private savePersistedState(state: PersistedRunState, publication: EventPublicationState): boolean {
    if (!publication.lease || !this.persistence.validateRunLease(publication.lease)) return false;
    try {
      this.persistence.save(state);
      return true;
    } catch (error) {
      this.reportPersistenceFailure(error);
      return false;
    }
  }

  private syncEventWatermark(state: EventPublicationState, snapshot: PersistedRunState): void {
    snapshot.eventStreamId = state.eventStreamId;
    snapshot.eventSeq = state.eventSeq;
    if (state.eventLogIncomplete) snapshot.eventLogIncomplete = true;
  }

  /** Save a run that is not live, with the watermark its publication reached. */
  private saveWithWatermark(snapshot: PersistedRunState, publication: EventPublicationState): void {
    this.syncEventWatermark(publication, snapshot);
    snapshot.updatedAt = new Date().toISOString();
    this.savePersistedState(snapshot, publication);
  }

  private prepareEventPublicationState(
    snapshot: PersistedRunState,
    lease: RunLease,
  ): EventPublicationState {
    const state: EventPublicationState = {
      runId: snapshot.runId,
      lease,
      eventStreamId: snapshot.eventStreamId,
      eventSeq: snapshot.eventSeq,
      eventLogIncomplete: snapshot.eventLogIncomplete,
    };
    const log = this.eventLog;
    if (!log) return state;

    if (snapshot.eventStreamId === undefined && snapshot.eventSeq === undefined) {
      state.eventStreamId = generateEventStreamId();
      state.eventSeq = 0;
      this.syncEventWatermark(state, snapshot);
      if (!this.savePersistedState(snapshot, state)) {
        state.eventLogIncomplete = true;
        snapshot.eventLogIncomplete = true;
        this.savePersistedState(snapshot, state);
        return state;
      }
    }

    if (state.eventLogIncomplete) return state;

    try {
      const tail = log.readEvents(snapshot.runId).endCursor;
      state.eventSeq = tail;
    } catch (error) {
      state.eventLogIncomplete = true;
      snapshot.eventLogIncomplete = true;
      this.reportPersistenceFailure(error);
      this.savePersistedState(snapshot, state);
    }
    return state;
  }

  private deliverRunEvent(event: EngineRunEvent): boolean {
    if (event.type === "error" && this.listenerCount("error") === 0) return false;
    const { type, ...payload } = event;
    return this.emit(type, payload);
  }

  /**
   * Append a persistable event to the run's log, when the store has one and the run holds its
   * lease, then deliver it to live listeners. A failed append marks the log incomplete, warns and
   * calls `saveIncompleteMarker`. No later event of the run goes to the log.
   */
  private publishRunEvent(
    state: EventPublicationState,
    event: EngineRunEvent,
    saveIncompleteMarker: () => void,
    actions: RunEventPublicationActions = {},
  ): boolean {
    const log = this.eventLog;
    if (
      log &&
      isPersistableRunEvent(event) &&
      state.lease &&
      !state.eventLogIncomplete
    ) {
      try {
        if (!this.persistence.validateRunLease(state.lease)) {
          throw new Error(`run ${state.runId} no longer owns its persistence lease`);
        }
        if (state.eventStreamId === undefined || state.eventSeq === undefined) {
          throw new Error(`run ${state.runId} has no event publication watermark`);
        }
        const candidate = state.eventSeq + 1;
        const record = log.appendEvent(state.runId, {
          seq: candidate,
          timestamp: new Date().toISOString(),
          event,
        });
        state.eventSeq = record.seq;
      } catch (error) {
        state.eventLogIncomplete = true;
        this.reportPersistenceFailure(error);
        saveIncompleteMarker();
      }
    }

    actions.beforeLive?.();
    const delivered = this.deliverRunEvent(event);
    actions.afterLive?.();
    return delivered;
  }

  /**
   * Compose the host-facing WorkflowRunResult (status trio included) from a managed
   * run plus the engine's bare result. status is already settled on `managed`; this
   * is a pure narrowing — the engine seam is never widened.
   */
  private composeResult(
    managed: ManagedRun,
    error: WorkflowError | undefined,
    engineResult?: EngineRunResult,
  ): WorkflowRunResult {
    const usageLimit = error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
    const authRequired = error?.code === WorkflowErrorCode.AUTH_REQUIRED;
    const checkpointRequired = error?.code === WorkflowErrorCode.CHECKPOINT_REQUIRED;
    const reason = runReason(managed.status, error);
    const snapshotUsage = managed.snapshot.tokenUsage;
    const tokenUsage: TokenUsage | undefined =
      engineResult?.tokenUsage ??
      (snapshotUsage
        ? {
            input: snapshotUsage.input,
            output: snapshotUsage.output,
            total: snapshotUsage.total,
            cost: snapshotUsage.cost ?? 0,
            cacheRead: snapshotUsage.cacheRead,
            cacheWrite: snapshotUsage.cacheWrite,
          }
        : undefined);
    const { fallbacks, checkpointsTaken } = managed;
    return {
      runId: managed.runId,
      status: managed.status,
      meta: managed.meta ?? {
        name: managed.snapshot.name,
        description: managed.snapshot.description ?? "",
        phases: managed.snapshot.phases.map((title) => ({ title })),
      },
      result: engineResult?.result,
      phases: engineResult?.phases ?? managed.snapshot.phases,
      agentCount: engineResult?.agentCount ?? managed.snapshot.agents.length,
      durationMs: engineResult?.durationMs ?? Date.now() - managed.startedAt.getTime(),
      tokenUsage,
      logs: engineResult?.logs ?? managed.snapshot.logs,
      ...(managed.status === "completed"
        ? {}
        : { logTail: createWorkflowLogTail(engineResult?.logs ?? managed.snapshot.logs, 20) }),
      reason,
      resetHint: usageLimit ? error?.resetHint : undefined,
      // Structured, NON-SECRET auth surface for an auth pause (§2.12) — hosts read this,
      // never the reason message. Absent on every other outcome.
      authContext: authRequired ? error?.authContext : undefined,
      // Structured, NON-SECRET pending durable checkpoint surface. Absent on every
      // other outcome. Hosts use it to ask the question and answer through confirm.
      checkpointContext: checkpointRequired ? error?.checkpointContext : undefined,
      // Fall back to the snapshot's per-agent records when the engine returned no result
      // (pause/failure mid-run) so re-attach handles survive an interrupted run.
      agentSessions:
        engineResult?.agentSessions ??
        managed.snapshot.agents.map((a) => a.session).filter((s): s is NonNullable<typeof s> => s != null),
      ...(fallbacks.length === 0 ? {} : { fallbacks }),
      ...(checkpointsTaken.length === 0 ? {} : { checkpointsTaken }),
      calls: engineResult?.calls ?? managed.rows.resultCalls(),
      callsAllocated: engineResult?.callsAllocated ?? managed.callsAllocated,
      ...(engineResult?.resumeReport ?? managed.resumeReporting
        ? { resumeReport: engineResult?.resumeReport ?? managed.resumeReporting?.report() }
        : {}),
      ...(managed.resumeReporting ? { replayEligibility: managed.resumeReporting.eligibility() } : {}),
      ...(managed.continuation ? { continuation: managed.continuation } : {}),
      effectiveLimits: engineResult?.effectiveLimits ?? managed.limits,
      ...(abortSignaledOf(managed) ? { abortSignaled: true as const } : {}),
      ...(engineResult?.nestedWorkflows || managed.nestedWorkflows ? { nestedWorkflows: true as const } : {}),
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    exec: ExecOptions = {},
    resume?: WorkflowResume,
  ): Promise<WorkflowRunResult> {
    const {
      maxAgents,
      externalSignal,
      onProgress,
      concurrency,
      agentRetries,
      confirm,
      onNestedWorkflow,
    } = exec;
    // A journal handed in pairs by index with the run's own calls.
    const runResume = resume ?? (exec.resumeJournal ? { rows: journalRows(managed.runId, exec.resumeJournal) } : undefined);
    const resolvedConcurrency = concurrency ?? this.concurrency;
    const resolvedAgentRetries = agentRetries ?? this.defaultAgentRetries;
    // Sync the derived counters (agentCount/runningCount/doneCount/errorCount) from the
    // agents array BEFORE every emission: the mutation sites below only push/patch
    // `snapshot.agents`, so without this the counters stay frozen at their initial 0s and
    // every onProgress consumer reads "0/0" forever.
    const progress = () => {
      Object.assign(managed.snapshot, recomputeWorkflowSnapshot(managed.snapshot));
      onProgress?.(managed.snapshot);
    };
    const publish = (event: EngineRunEvent, actions?: RunEventPublicationActions) =>
      this.publishRunEvent(managed, event, () => this.persistRun(managed), actions);
    // An external signal aborts this run too.
    if (externalSignal) {
      if (externalSignal.aborted) managed.controller.abort();
      else externalSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
    }
    try {
      // Resolve the injected agent backend (per-run override > constructor). The
      // engine REQUIRES an AgentRunner and never constructs one.
      const agent = this.resolveAgent(exec);
      const vmArgsSnapshot = managed.argsSnapshotOk ? snapshotArgs(managed.args) : { ok: false as const };
      const argsForVm = vmArgsSnapshot.ok ? vmArgsSnapshot.clone : managed.args;
      const { places, ...orchestrator } = this.orchestratorOptions;
      const engineResult = await runWorkflow(script, {
        cwd: managed.effectiveCwd,
        args: argsForVm,
        agent,
        defaultModel: managed.defaultModel,
        signal: managed.controller.signal,
        pauseSignal: (managed.pauseController ??= new AbortController()).signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        maxAgents,
        confirm,
        onNestedWorkflow: (ordinal, childRunId) => {
          managed.nestedWorkflows = true;
          onNestedWorkflow?.(ordinal, childRunId);
        },
        loadSavedWorkflow: this.loadSavedWorkflow,
        ...orchestrator,
        // This run is the root of its run tree, so its places are noted under its id.
        ...(places ? { places: places(managed.runId) } : {}),
        ...(exec.stepOverrides ? { stepOverrides: exec.stepOverrides } : {}),
        ...(exec.codeEnv ? { codeEnv: exec.codeEnv } : {}),
        persistenceRoot: this.persistenceRoot,
        ...(runResume ? { resume: runResume } : {}),
        tokenUsageBaseline: managed.sameRunContinuation
          ? {
              input: managed.snapshot.tokenUsage?.input ?? 0,
              output: managed.snapshot.tokenUsage?.output ?? 0,
              total: managed.snapshot.tokenUsage?.total ?? 0,
              cost: managed.snapshot.tokenUsage?.cost ?? 0,
              cacheRead: managed.snapshot.tokenUsage?.cacheRead ?? 0,
              cacheWrite: managed.snapshot.tokenUsage?.cacheWrite ?? 0,
            }
          : undefined,
        runId: managed.runId,
        onResumeFilesystemTainted: () => {
          managed.resumeFilesystemTainted = true;
        },
        onResumeActivity: (active) => {
          if (
            !Number.isSafeInteger(active) ||
            active < 0 ||
            Math.abs(active - (managed.resumeActivity ?? 0)) !== 1
          ) {
            managed.resumeActivityInvalid = true;
            return;
          }
          managed.resumeActivity = active;
        },
        onResumeCallAllocated: (allocated) => {
          if (!Number.isSafeInteger(allocated) || allocated !== (managed.callsAllocated ?? 0) + 1) {
            managed.resumeActivityInvalid = true;
            return;
          }
          managed.callsAllocated = allocated;
        },
        onResumeDecision: (decision) => {
          if (!managed.resumeReporting) return;
          managed.resumeReporting.decide(decision);
          this.persistRun(managed);
        },
        onAgentJournal: (entry) => this.recordJournalEntry(managed, entry),
        onFallback: (entry) => {
          managed.fallbacks.push(entry);
          this.persistRun(managed);
        },
        onCheckpointTaken: (entry) => {
          managed.checkpointsTaken.push(entry);
          this.persistRun(managed);
        },
        onCallRecord: (record) => this.recordCallRecord(managed, record),
        onAgentAttempt: (attempt) => this.registerAgentAttempt(managed, attempt),
        onLog: (message, context) => {
          managed.snapshot.logs.push(message);
          publish(this.createRunEvent("log", {
            runId: managed.runId,
            scope: context?.scope ?? managed.runId,
            message,
          }));
          progress();
        },
        onPhase: (title, context) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          publish(this.createRunEvent("phase", {
            runId: managed.runId,
            scope: context?.scope ?? managed.runId,
            title,
          }));
          progress();
        },
        onAgentStart: (event) => {
          if (this.dropPostTerminal(managed, "agentStart")) return;
          foldStep(managed.snapshot.agents, { type: "agentStart", ...event }, new Date().toISOString());
          publish(this.createRunEvent("agentStart", { runId: managed.runId, ...event }));
          progress();
        },
        onAgentEnd: (event) => {
          if (this.dropPostTerminal(managed, "agentEnd")) return;
          foldStep(managed.snapshot.agents, { type: "agentEnd", ...event, resultPreview: preview(event.result) }, new Date().toISOString());
          publish(this.createRunEvent("agentEnd", { runId: managed.runId, ...event }));
          this.completeAgentCancellation(managed, event);
          progress();
        },
        onAgentHistory: (event) => {
          if (this.dropPostTerminal(managed, "agentHistory")) return;
          const agentSnapshot = managed.snapshot.agents.find(
            (a) => a.scope === event.scope && a.callIndex === event.callIndex && a.status === "running",
          );
          if (agentSnapshot) agentSnapshot.history = event.history;
          publish(this.createRunEvent("agentHistory", { runId: managed.runId, ...event }));
          progress();
        },
        onTokenUsage: (usage, context) => {
          managed.snapshot.tokenUsage = usage;
          publish(this.createRunEvent("tokenUsage", {
            runId: managed.runId,
            scope: context?.scope ?? managed.runId,
            usage,
          }));
          progress();
        },
      });

      managed.executionSettled = true;
      managed.rows.completed(engineResult.calls ?? []);
      managed.callsAllocated = engineResult.callsAllocated;
      managed.limits = engineResult.effectiveLimits;
      if (engineResult.abortSignaled) managed.abortSignaled = true;
      if (engineResult.nestedWorkflows) managed.nestedWorkflows = true;
      managed.status = "completed";
      const result = this.composeResult(managed, undefined, engineResult);
      managed.result = result;
      publish(
        this.createRunEvent("complete", {
          runId: managed.runId,
          scope: managed.runId,
          result,
        }),
        {
          afterLive: () => {
            this.persistRun(managed);
            this.releaseRunLease(managed);
          },
        },
      );

      return result;
    } catch (error) {
      managed.executionSettled = true;
      // The engine wraps every fault that crosses the script boundary as a WorkflowError
      // (script crashes are SCRIPT_ERROR), so a bare error HERE is manager/host-level
      // (persistence, fs). Label it UNKNOWN — never WORKFLOW_ABORTED, which is reserved
      // for actual cancellation.
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(errorMessage(error), WorkflowErrorCode.UNKNOWN, { recoverable: false });
      // Four recoverable-by-external-action fault codes checkpoint the run as PAUSED (not failed),
      // so a resume replays the journaled prefix instead of restarting from scratch (§2.12):
      //  - PROVIDER_USAGE_LIMIT: a provider quota refills over time.
      //  - AUTH_REQUIRED: a host completes an auth step.
      //  - CHECKPOINT_REQUIRED: a host supplies the pending durable checkpoint decision.
      //  - PAUSE_REQUESTED: a host asked for the pause, or a step failed or was stopped, and
      //    the run resumes when the cause is fixed.
      // All are recoverable:false, so the retry ladder skips them.
      const pauseReason = managed.controller.signal.aborted ? undefined : pauseReasonOf(workflowError);
      if (managed.controller.signal.aborted) {
        // Intentional stop (host signal) — preserve the status set by stop()
        if (managed.status === "running") {
          managed.status = "aborted";
        }
      } else if (pauseReason !== undefined) {
        managed.status = "paused";
        managed.pausedAt = new Date().toISOString();
      } else {
        managed.status = "failed";
      }
      managed.error = workflowError;
      managed.result = this.composeResult(managed, workflowError);

      if (pauseReason !== undefined) {
        publish(this.createRunEvent("paused", pausedPayload(managed.runId, pauseReason, workflowError)), {
          beforeLive: () => {
            this.persistRun(managed);
            this.releaseRunLease(managed);
          },
        });
      } else {
        publish(
          this.createRunEvent("error", {
            runId: managed.runId,
            scope: managed.runId,
            error: workflowError,
            errorRecord: projectRecordedError(workflowError),
          }),
          {
            beforeLive: () => {
              this.persistRun(managed);
              this.releaseRunLease(managed);
            },
          },
        );
      }

      throw workflowError;
    }
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  private recordJournalEntry(managed: ManagedRun, entry: JournalEntry): void {
    if (this.dropPostTerminal(managed, "journal")) return;
    managed.rows.journal(entry);
    const rootScope = entry.scope === undefined || entry.scope === managed.runId;
    if (rootScope && entry.kind === "checkpoint") this.persistRunOrThrow(managed);
    this.publishRunEvent(
      managed,
      this.createRunEvent("journal", {
        runId: managed.runId,
        scope: entry.scope ?? managed.runId,
        entry,
      }),
      () => this.persistRun(managed),
      { beforeLive: () => this.persistRun(managed) },
    );
  }

  private recordCallRecord(managed: ManagedRun, record: WorkflowCallRecord): void {
    if (this.dropPostTerminal(managed, "callRecord")) return;
    managed.rows.call(record, managed.snapshot.currentPhase);
    const rootScope = record.scope === undefined || record.scope === managed.runId;
    this.publishRunEvent(
      managed,
      this.createRunEvent("callRecord", {
        runId: managed.runId,
        scope: record.scope ?? managed.runId,
        record,
      }),
      () => this.persistRun(managed),
      rootScope ? { beforeLive: () => this.persistRun(managed) } : undefined,
    );
  }

  private registerAgentAttempt(
    managed: ManagedRun,
    control: WorkflowAgentAttemptControl,
  ): () => void {
    const attempt: RegisteredAgentAttempt = { ...control };
    let attempts = this.agentAttempts.get(managed.runId);
    if (!attempts) {
      attempts = new Set();
      this.agentAttempts.set(managed.runId, attempts);
    }
    attempts.add(attempt);

    return () => {
      const current = this.agentAttempts.get(managed.runId);
      current?.delete(attempt);
      if (current?.size === 0) this.agentAttempts.delete(managed.runId);
      if (attempt.cancellation && !attempt.cancellation.settled) {
        this.rejectAgentCancellation(
          attempt.cancellation,
          new WorkflowError(
            `Agent call ${attempt.callIndex} ("${attempt.label}") settled before host cancellation won the race.`,
            WorkflowErrorCode.AGENT_EXECUTION_ERROR,
            { recoverable: false },
          ),
        );
      }
    };
  }

  private completeAgentCancellation(
    managed: ManagedRun,
    event: NonNullable<WorkflowRunOptions["onAgentEnd"]> extends (event: infer Event) => void
      ? Event
      : never,
  ): void {
    const matching = [...(this.agentAttempts.get(managed.runId) ?? [])].filter(
      (attempt) =>
        attempt.callIndex === event.callIndex &&
        attempt.scope === event.scope &&
        attempt.cancellation !== undefined &&
        !attempt.cancellation.settled,
    );
    if (matching.length === 0) return;

    let persistenceError: WorkflowError | undefined;
    try {
      this.persistRunOrThrow(managed);
      if (managed.eventLogIncomplete) {
        throw new WorkflowError(
          `Agent call ${event.callIndex} cancellation for run ${managed.runId} could not be durably acknowledged because its event log is incomplete.`,
          WorkflowErrorCode.PERSISTENCE_ERROR,
          { recoverable: false },
        );
      }
    } catch (error) {
      persistenceError = error instanceof WorkflowError
        ? error
        : new WorkflowError(
            `Agent call ${event.callIndex} cancellation for run ${managed.runId} could not be persisted: ${errorMessage(error)}`,
            WorkflowErrorCode.PERSISTENCE_ERROR,
            { recoverable: false },
          );
    }

    for (const attempt of matching) {
      const pending = attempt.cancellation!;
      if (persistenceError) {
        this.rejectAgentCancellation(pending, persistenceError);
      } else if (event.errorCode !== WorkflowErrorCode.AGENT_CANCELLED) {
        this.rejectAgentCancellation(
          pending,
          new WorkflowError(
            `Agent call ${event.callIndex} ("${attempt.label}") settled before host cancellation won the race.`,
            WorkflowErrorCode.AGENT_EXECUTION_ERROR,
            { recoverable: false },
          ),
        );
      } else {
        pending.settled = true;
        pending.resolve({
          runId: managed.runId,
          callIndex: attempt.callIndex,
          label: attempt.label,
          scope: attempt.scope,
          errorCode: WorkflowErrorCode.AGENT_CANCELLED,
        });
      }
    }
  }

  private rejectAgentCancellation(pending: PendingAgentCancellation, error: WorkflowError): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.reject(error);
  }

  private currentAgentAttempts(runId: string): RegisteredAgentAttempt[] {
    return [...(this.agentAttempts.get(runId) ?? [])]
      .filter((attempt) => !attempt.controller.signal.aborted || attempt.cancellation !== undefined)
      .sort((left, right) =>
        left.callIndex - right.callIndex ||
        left.label.localeCompare(right.label) ||
        left.scope.localeCompare(right.scope)
      );
  }

  private dropPostTerminal(managed: ManagedRun, event: string): boolean {
    if (managed.status === "running") return false;
    try {
      console.debug(`[workflow-manager] dropped post-terminal ${event} for ${managed.runId}`);
    } catch {
      // Debug reporting is best-effort.
    }
    return true;
  }

  /** At the first terminal save, record the folder's state, so a reuse can tell whether it changed. */
  private recordTerminalEnvironment(managed: ManagedRun): void {
    if (managed.status === "running" || managed.status === "pending") return;
    if (managed.resumeTerminalFinalized) return;
    managed.resumeTerminalFinalized = true;
    if (!managed.resume) return;
    managed.resume = { format: "identity-v1" };
    if (!managed.executionSettled || managed.resumeActivityInvalid || (managed.resumeActivity ?? 0) !== 0) return;
    const terminalEnvironment = captureRunEnvironment(managed.effectiveCwd, managed.environmentKey);
    if (terminalEnvironment?.git) {
      managed.resume = { format: "identity-v1", terminalEnvironment };
    } else if (terminalEnvironment?.key !== undefined && !managed.resumeFilesystemTainted) {
      managed.resume = { format: "identity-v1", terminalEnvironment };
    }
  }

  private persistedState(managed: ManagedRun): PersistedRunState {
    this.recordTerminalEnvironment(managed);
    const rows = managed.rows.saved(managed.status);
    return {
      runId: managed.runId,
      workflowName: managed.snapshot.name,
      // Persist the real script + journal so the run can be resumed. Runs live
      // in workflow run storage — protect via directory permissions, not blanking.
      script: managed.script,
      ...(managed.scriptOrigin ? { scriptOrigin: managed.scriptOrigin } : {}),
      ...(managed.scriptRevisions ? { scriptRevisions: managed.scriptRevisions } : {}),
      args: managed.args,
      argsUnreplayable: managed.argsUnreplayable,
      // The per-run working directory, so a resume re-runs in the SAME place.
      cwd: managed.cwd,
      effectiveCwd: managed.effectiveCwd,
      runtime: managed.runtime,
      environment: managed.environment,
      ...(managed.resume ? { resume: managed.resume } : {}),
      ...(managed.resumeSourceRunId ? { resumeSourceRunId: managed.resumeSourceRunId } : {}),
      ...(rows.resumeSeed ? { resumeSeed: rows.resumeSeed } : {}),
      ...(managed.resumeReporting
        ? { resumeReport: managed.resumeReporting.report(), replayEligibility: managed.resumeReporting.eligibility() }
        : {}),
      ...(managed.continuation ? { continuation: managed.continuation } : {}),
      defaultModel: managed.defaultModel,
      eventStreamId: managed.eventStreamId,
      eventSeq: managed.eventSeq,
      eventLogIncomplete: managed.eventLogIncomplete,
      nestedWorkflows: managed.nestedWorkflows,
      legacyResume: managed.legacyResume,
      journal: rows.journal,
      ...(rows.nestedJournal.length ? { nestedJournal: rows.nestedJournal } : {}),
      ...(managed.fallbacks.length === 0 ? {} : { fallbacks: managed.fallbacks }),
      ...(managed.checkpointsTaken.length === 0 ? {} : { checkpointsTaken: managed.checkpointsTaken }),
      calls: rows.calls,
      callsAllocated: managed.callsAllocated,
      limits: managed.limits,
      ...(abortSignaledOf(managed) ? { abortSignaled: true as const } : {}),
      status: managed.status,
      reason: runReason(managed.status, managed.error),
      errorCode: managed.error?.code,
      // Why a pause happened, so a later read can show it.
      // The paused event gives the same reason.
      pauseReason: managed.status === "paused" ? pauseReasonOf(managed.error) : undefined,
      // resetHint and resetAt stay usage-limit-only.
      resetHint:
        managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
          ? managed.error.resetHint
          : undefined,
      resetAt:
        managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
          ? managed.error.providerUsageLimitContext?.resetAt
          : undefined,
      pausedAt: managed.status === "paused" ? managed.pausedAt : undefined,
      // The NON-SECRET auth surface for an auth pause — backendId + advertised method
      // ids/types/names only (never authenticateMeta/envValues; Principle 9, §2.14). It
      // arms the cold re-check of a resume (§2.13).
      authContext:
        managed.status === "paused" && managed.error?.code === WorkflowErrorCode.AUTH_REQUIRED
          ? managed.error.authContext
          : undefined,
      // The NON-SECRET pending durable checkpoint surface. Its callIndex/hash pair arms
      // a resume to inject the host's decision as a deterministic journal entry.
      checkpointContext:
        managed.status === "paused" && managed.error?.code === WorkflowErrorCode.CHECKPOINT_REQUIRED
          ? managed.error.checkpointContext
          : undefined,
      phases: managed.snapshot.phases,
      currentPhase: managed.snapshot.currentPhase,
      // Each step keeps its own start and end time.
      agents: managed.snapshot.agents.map((a) => ({
        ...a,
        startedAt: a.startedAt ?? managed.startedAt.toISOString(),
        ...(a.endedAt ? { endedAt: a.endedAt } : {}),
      })),
      logs: managed.snapshot.logs,
      result: managed.result?.result,
      tokenUsage: managed.snapshot.tokenUsage
        ? {
            input: managed.snapshot.tokenUsage.input,
            output: managed.snapshot.tokenUsage.output,
            total: managed.snapshot.tokenUsage.total,
            cost: managed.snapshot.tokenUsage.cost,
            cacheRead: managed.snapshot.tokenUsage.cacheRead,
            cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
          }
        : undefined,
      startedAt: managed.startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
      durationMs: managed.result?.durationMs,
    };
  }

  private persistRun(managed: ManagedRun) {
    if (!managed.lease || !this.persistence.validateRunLease(managed.lease)) return;
    try {
      this.persistence.save(this.persistedState(managed));
    } catch (err) {
      this.reportPersistenceFailure(err);
    }
  }

  private persistRunOrThrow(managed: ManagedRun): void {
    const leaseFailure = !managed.lease
      ? "the lease is missing"
      : !this.persistence.validateRunLease(managed.lease)
        ? "the lease is no longer owned"
        : undefined;
    if (leaseFailure) {
      throw new WorkflowError(
        `run ${managed.runId} cannot be durably updated because ${leaseFailure}`,
        WorkflowErrorCode.PERSISTENCE_ERROR,
        { recoverable: false },
      );
    }
    try {
      this.persistence.save(this.persistedState(managed));
    } catch (error) {
      throw new WorkflowError(
        `failed to persist resume state for ${managed.runId}: ${errorMessage(error)}`,
        WorkflowErrorCode.PERSISTENCE_ERROR,
        { recoverable: false },
      );
    }
  }

  /**
   * Ask a running workflow to pause. Agent calls already executing finish and journal, nothing
   * new is admitted (queued calls settle as interrupted rows that run again on resume), and the
   * run then settles as `paused` with reason "requested" and a `paused` event. Returns true when
   * the request is registered with a run this manager is executing, including a repeat request
   * while one is pending; false when the run is not running here. `stop()` remains the immediate
   * interruption.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;
    (managed.pauseController ??= new AbortController()).abort();
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. A refused resume has no completion promise. An accepted
   * one keeps the same background result contract as startInBackground.
   */
  async resumeInBackground(
    runId: string,
    exec: ExecOptions = {},
  ): Promise<
    | { accepted: false; promise?: undefined }
    | { accepted: true; promise: Promise<WorkflowRunResult> }
  > {
    const started = await this.continueRunInternal(runId, exec);
    return started.accepted
      ? { accepted: true, promise: started.promise }
      : { accepted: false };
  }

  private async continueRunInternal(
    runId: string,
    exec: ExecOptions,
  ): Promise<WorkflowContinuationStart> {
    if (
      exec.resumeFromRunId !== undefined ||
      exec.resumeJournal !== undefined ||
      exec.cwd !== undefined ||
      exec.defaultModel !== undefined
    ) {
      throw this.scriptValidationError(
        "same-run continuation accepts only runtime controls; script, args, cwd, provider configuration, and replay inputs are immutable",
      );
    }
    const observed = this.persistence.load(runId);
    if (observed) {
      assertExplicitCheckpointProvenance(observed);
    }
    // Guard: refuse to resume a run that is already running. Paused, failed, and stopped
    // (aborted) runs can restart from their journal; only completed runs are final.
    const active = this.runs.get(runId);
    if (active?.status === "running") {
      return { accepted: false };
    }
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) {
      return { accepted: false };
    }
    // Every exit releases the lease here, except a run that starts. That run owns the lease
    // and releases it when it settles.
    const handOff = { started: false };
    try {
      return this.continueUnderLease(runId, exec, lease, handOff);
    } finally {
      if (!handOff.started) this.persistence.releaseRunLease(lease);
    }
  }

  /** A same-run continuation while the caller holds the run's lease. Sets `handOff.started` once the run owns it. */
  private continueUnderLease(
    runId: string,
    exec: ExecOptions,
    lease: RunLease,
    handOff: { started: boolean },
  ): WorkflowContinuationStart {
    const persisted = this.persistence.load(runId);
    if (!persisted) return { accepted: false };
    assertExplicitCheckpointProvenance(persisted);
    if (persisted.status === "completed") return { accepted: false };
    // Older engines marked isolation runs with executionMode. Such a run never resumes.
    if (!persisted.script || persisted.executionMode || persisted.argsUnreplayable) {
      return { accepted: false };
    }
    // Same-ID recovery keeps its explicit legacy marker.
    persisted.legacyResume = true;
    try {
      if (!this.persistence.validateRunLease(lease)) {
        throw new Error(`run ${runId} no longer owns its persistence lease`);
      }
      this.persistence.save(persisted);
    } catch (error) {
      throw new WorkflowError(
        `failed to persist legacy resume marker for ${runId}: ${errorMessage(error)}`,
        WorkflowErrorCode.PERSISTENCE_ERROR,
        { recoverable: false },
      );
    }
    const publication = this.prepareEventPublicationState(persisted, lease);

    // A revised script (the run's editable file changed since admission) continues through an
    // identity-matched replay of this run's own terminal state: unchanged calls replay, changed
    // calls and everything the revision reorders run live. Structure and backend approval are
    // checked before anything is persisted for the new generation.
    const revision = exec.script !== undefined && exec.script !== persisted.script ? exec.script : undefined;
    let revisionMeta: WorkflowMeta | undefined;
    if (revision !== undefined) {
      try {
        revisionMeta = parseWorkflowScript(revision).meta;
      } catch {
        return { accepted: false };
      }
    }

    const controller = new AbortController();
    let meta: WorkflowMeta | undefined;
    try {
      meta = revision !== undefined ? revisionMeta : parseWorkflowScript(persisted.script).meta;
    } catch {
      // A previously-valid script that no longer parses still resumes by journal;
      // the snapshot name carries the run identity.
      meta = undefined;
    }
    const capturedArgs = snapshotArgs(persisted.args);
    const effectiveCwd = persisted.effectiveCwd ?? persisted.cwd ?? this.cwd;
    const runtime = runtimeIdentity();
    // The run pairs with its own rows, then with the rows its seed still holds. Without a
    // revision the key is the kind and call hash.
    const revised = revision === undefined
      ? undefined
      : reviseRows(runId, persisted, pairingKey(persisted.runtime, runtime));
    const started = revised ?? continueRows(runId, persisted);
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
        ...(persisted.tokenUsage
          ? {
              tokenUsage: {
                input: persisted.tokenUsage.input,
                output: persisted.tokenUsage.output,
                total: persisted.tokenUsage.total,
                cost: persisted.tokenUsage.cost ?? 0,
                cacheRead: persisted.tokenUsage.cacheRead ?? 0,
                cacheWrite: persisted.tokenUsage.cacheWrite ?? 0,
              },
            }
          : {}),
      },
      controller,
      startedAt: new Date(persisted.startedAt),
      script: revision ?? persisted.script,
      ...(persisted.scriptOrigin ? { scriptOrigin: persisted.scriptOrigin } : {}),
      ...(persisted.scriptRevisions ? { scriptRevisions: persisted.scriptRevisions } : {}),
      args: capturedArgs.ok ? capturedArgs.clone : persisted.args,
      argsSnapshotOk: capturedArgs.ok,
      ...(persisted.argsUnreplayable || !capturedArgs.ok ? { argsUnreplayable: true as const } : {}),
      cwd: persisted.cwd,
      meta,
      rows: started.rows,
      fallbacks: persisted.fallbacks ?? [],
      checkpointsTaken: [],
      effectiveCwd,
      runtime,
      environment: persisted.environment,
      ...(persisted.legacyResume ? { legacyResume: true as const } : {}),
      ...(persisted.resume ? { resume: { format: "identity-v1" as const } } : {}),
      ...(persisted.resumeSourceRunId ? { resumeSourceRunId: persisted.resumeSourceRunId } : {}),
      resumeActivity: 0,
      resumeFilesystemTainted: false,
      resumeTerminalFinalized: false,
      executionSettled: false,
      environmentKey: this.environmentKey,
      callsAllocated: 0,
      limits: resolveWorkflowRunLimits({
        maxAgents: exec.maxAgents ?? persisted.limits?.maxAgents,
        concurrency: exec.concurrency ?? persisted.limits?.concurrency ?? this.concurrency,
        agentRetries: exec.agentRetries ?? persisted.limits?.agentRetries ?? this.defaultAgentRetries,
      }),
      defaultModel: persisted.defaultModel,
      sameRunContinuation: true,
      lease,
      eventStreamId: publication.eventStreamId,
      eventSeq: publication.eventSeq,
      eventLogIncomplete: publication.eventLogIncomplete,
    };
    const preparedContinuation = this.buildPreparedContinuation(persisted);
    const generation = (persisted.continuation?.generation ?? 0) + 1;

    let occurrenceResume: OccurrenceResume | undefined;
    if (revised && revision !== undefined) {
      managed.scriptRevisions = [
        ...(persisted.scriptRevisions ?? []),
        { generation, scriptHash: hashScriptText(revision), revisedAt: new Date().toISOString() },
      ];
      occurrenceResume = { strategy: "occurrence-v1", sourceRunId: runId, requestedPolicy: "auto" };
      managed.resumeReporting = startResumeReport({
        plan: occurrenceResume,
        source: persisted,
        run: managed,
        predictedReplayablePrefix: revised.prefix,
      });
    }
    const continuation: WorkflowContinuationResult = deepFreeze({
      generation,
      replayedPrefix: contiguousJournalPrefix(persisted.journal ?? [], runId),
      ...(revision === undefined ? {} : { scriptRevised: true as const }),
    });
    managed.continuation = continuation;
    this.persistRunOrThrow(managed);
    handOff.started = true;
    this.runs.set(runId, managed);
    this.publishRunEvent(
      managed,
      this.createRunEvent("resumed", { runId, scope: runId }),
      () => this.persistRun(managed),
    );
    // Run in the background; executeRun records status/errors on the managed run.
    // Preserve the original promise for callers while preventing an ignored resume
    // from becoming an unhandled rejection.
    const promise = this.executeRun(managed, managed.script, {
      agent: exec.agent,
      maxAgents: managed.limits?.maxAgents,
      concurrency: managed.limits?.concurrency,
      agentRetries: managed.limits?.agentRetries,
      externalSignal: exec.externalSignal,
      onProgress: exec.onProgress,
      confirm: exec.confirm,
      onNestedWorkflow: exec.onNestedWorkflow,
      ...(exec.stepOverrides ? { stepOverrides: exec.stepOverrides } : {}),
      ...(exec.codeEnv ? { codeEnv: exec.codeEnv } : {}),
    }, {
      rows: started.resume,
      ...(occurrenceResume ? { plan: occurrenceResume } : {}),
      ...(preparedContinuation ? { continuation: preparedContinuation } : {}),
    });
    promise.catch(() => {});
    return { accepted: true, runId, continuation, promise };
  }

  /**
   * Stop the in-flight steps of a run: all of them, or those that match each of `label`,
   * `scope` (the run itself or a nested run) and `callIndex` (one call in that scope). Returns how
   * many attempts it stopped. The run then pauses on them, and resume runs them again. `pauseReason`
   * replaces the paused run's "step_stopped", and `message` says why in the run's reason.
   */
  cancelAgentSteps(
    runId: string,
    select: { label?: string; scope?: string; callIndex?: number; pauseReason?: "time_limit"; message?: string } = {},
  ): number {
    const managed = this.runs.get(runId);
    if (!managed || managed.status !== "running") return 0;
    const matching = this.currentAgentAttempts(runId).filter(
      (attempt) =>
        (select.label === undefined || attempt.label === select.label) &&
        (select.scope === undefined || attempt.scope === select.scope) &&
        (select.callIndex === undefined || attempt.callIndex === select.callIndex),
    );
    for (const attempt of matching) {
      this.requestAgentCancellation(attempt, select.message, select.pauseReason).catch(() => {});
    }
    return matching.length;
  }

  private requestAgentCancellation(
    attempt: RegisteredAgentAttempt,
    message?: string,
    pauseReason?: "time_limit",
  ): Promise<WorkflowAgentCallCancellation> {
    if (!attempt.cancellation) {
      let resolve!: (result: WorkflowAgentCallCancellation) => void;
      let reject!: (error: WorkflowError) => void;
      const promise = new Promise<WorkflowAgentCallCancellation>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      attempt.cancellation = { promise, resolve, reject, settled: false };
      attempt.controller.abort(
        new WorkflowError(
          message ?? "agent call cancelled by host",
          WorkflowErrorCode.AGENT_CANCELLED,
          { recoverable: true, ...(pauseReason ? { details: { pauseReason } } : {}) },
        ),
      );
    }
    return attempt.cancellation.promise;
  }

  /**
   * Stop a running workflow.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (!managed || (managed.status !== "running" && managed.status !== "paused")) return false;

    let pausedSnapshot: PersistedRunState | undefined;
    if (managed.status === "paused" && !managed.lease) {
      const lease = this.persistence.acquireRunLease(runId);
      if (!lease) return false;
      managed.lease = lease;
      let current: PersistedRunState | null;
      try {
        current = this.persistence.load(runId);
      } catch (error) {
        this.reportPersistenceFailure(error);
        this.releaseRunLease(managed);
        return false;
      }
      if (current?.status !== "paused") {
        this.releaseRunLease(managed);
        return false;
      }
      pausedSnapshot = current;
      const publication = this.prepareEventPublicationState(current, lease);
      managed.eventStreamId = publication.eventStreamId;
      managed.eventSeq = publication.eventSeq;
      managed.eventLogIncomplete = publication.eventLogIncomplete;
    }

    managed.controller.abort();
    managed.status = "aborted";
    if (pausedSnapshot) {
      Object.assign(pausedSnapshot, STOPPED_STATE);
    }
    const saveStopped = () => {
      if (!managed.lease) return;
      if (!pausedSnapshot) {
        this.persistRun(managed);
        return;
      }
      this.saveWithWatermark(pausedSnapshot, managed);
    };
    this.publishRunEvent(
      managed,
      this.createRunEvent("stopped", { runId, scope: runId }),
      saveStopped,
      {
        afterLive: () => {
          saveStopped();
          this.releaseRunLease(managed);
        },
      },
    );
    return true;
  }

  /**
   * Stop a persisted run while holding its cross-process lease. This is the location-
   * independent counterpart to stop(): it never steals a live owner's lease and lets a
   * concurrently terminal snapshot win after the under-lease reload.
   */
  stopPersistedRun(runId: string): PersistedRunStopResult {
    const managed = this.runs.get(runId);
    if (managed) {
      const current = this.persistence.load(runId);
      if (current && (current.status === "completed" || current.status === "failed" || current.status === "aborted")) {
        return { outcome: "already-terminal", state: current };
      }
      if (managed.status === "running" || managed.status === "paused") {
        if (!this.stop(runId)) return { outcome: "owned-elsewhere", ...(current ? { state: current } : {}) };
        return { outcome: "stopped", state: this.persistence.load(runId) ?? undefined };
      }
      // The in-memory execution already settled but its final snapshot did not. Fall through
      // to the lease-safe cold path; stop() has released its lease and cannot repair it.
    }

    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return { outcome: "owned-elsewhere", state: this.persistence.load(runId) ?? undefined };
    try {
      const current = this.persistence.load(runId);
      if (!current) return { outcome: "missing" };
      if (current.status === "completed" || current.status === "failed" || current.status === "aborted") {
        return { outcome: "already-terminal", state: current };
      }

      const publication = this.prepareEventPublicationState(current, lease);
      let stoppedEventAlreadyDurable = false;
      const log = this.eventLog;
      if (
        log &&
        publication.eventStreamId !== undefined &&
        publication.eventSeq !== undefined &&
        publication.eventSeq > 0
      ) {
        try {
          const tail = log.readEvents(runId, {
            streamId: publication.eventStreamId,
            after: publication.eventSeq - 1,
            limit: 1,
          });
          stoppedEventAlreadyDurable = tail.events.some(
            (record) => record.seq === publication.eventSeq && record.event.type === "stopped",
          );
        } catch {
          stoppedEventAlreadyDurable = false;
        }
      }
      Object.assign(current, STOPPED_STATE);

      const saveStopped = () => this.saveWithWatermark(current, publication);
      if (stoppedEventAlreadyDurable) {
        saveStopped();
      } else {
        this.publishRunEvent(
          publication,
          this.createRunEvent("stopped", { runId, scope: runId }),
          saveStopped,
          { afterLive: saveStopped },
        );
      }
      return { outcome: "stopped", state: this.persistence.load(runId) ?? current };
    } finally {
      this.persistence.releaseRunLease(lease);
    }
  }

  /**
   * Get this manager's current run, retaining settled SDK history until another owner
   * changes its durable generation or status. Cached history is not execution ownership.
   */
  getRun(runId: string): ManagedRun | undefined {
    const managed = this.runs.get(runId);
    if (!managed) return managed;
    if (managed.lease && this.persistence.validateRunLease(managed.lease)) return managed;
    const persisted = this.persistence.load(runId);
    if (!persisted) return managed;
    // A failed terminal save leaves this generation's earlier active snapshot on disk.
    // It is not evidence of another owner: preserve the settled in-memory outcome while
    // exact-result resources remain gated on a successful durable completion. A new
    // continuation generation or a durable foreign stop still supersedes this cache.
    if (
      managed.executionSettled &&
      (persisted.status === "pending" || persisted.status === "running") &&
      (persisted.continuation?.generation ?? 0) === (managed.continuation?.generation ?? 0)
    ) return managed;
    if (
      persisted.status !== managed.status ||
      (persisted.continuation?.generation ?? 0) !== (managed.continuation?.generation ?? 0)
    ) return undefined;
    return managed;
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}

function validateScriptOrigin(origin: WorkflowScriptOrigin | undefined): void {
  if (origin === undefined) return;
  const invalid = () => new WorkflowError(
    'scriptOrigin must be { kind: "inline" } or { kind: "path", path: <absolute path> }',
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false },
  );
  if (origin === null || typeof origin !== "object") throw invalid();
  if (origin.kind === "inline") {
    if (Object.keys(origin).length !== 1) throw invalid();
    return;
  }
  if (origin.kind !== "path" || typeof origin.path !== "string" || !isAbsolute(origin.path) || Object.keys(origin).length !== 2) {
    throw invalid();
  }
}

function contiguousJournalPrefix(entries: readonly JournalEntry[], runId: string): number {
  const indexes = new Set(
    entries
      .filter((entry) => entry.scope === undefined || entry.scope === runId)
      .map((entry) => entry.index),
  );
  let index = 0;
  while (indexes.has(index)) index++;
  return index;
}

/** The pause reason of a step that failed or was stopped. */
function stepPauseReason(details: unknown): Exclude<RequestedPauseReason, "requested"> {
  const { code, pauseReason } = (details ?? {}) as { code?: unknown; pauseReason?: unknown };
  if (pauseReason === "time_limit") return pauseReason;
  return code === WorkflowErrorCode.AGENT_CANCELLED ? "step_stopped" : "step_failed";
}

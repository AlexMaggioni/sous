import { createHash } from "node:crypto";
import { assertExplicitCheckpointProvenance } from "./checkpoint-provenance.js";
import {
  checkpointCall,
  type CheckpointCallContext,
  type CheckpointConfirm,
  type CheckpointOptions,
  type CheckpointRun,
} from "./checkpoint-call.js";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import vm from "node:vm";
import type { TSchema } from "typebox";
import type { AgentHistoryEntry } from "./steps/agent-history.js";
import type {
  AgentResultProvenance,
  ContinuationSkipReason,
  AgentUsage,
  PromptImage,
} from "./steps/agent-run.js";
import type { AgentRunner, StepAsk, StepRoute } from "./steps/agent-runner.js";
import type {
  AgentSessionRecord,
  AgentSessionRef,
  JournalEntry,
  WorkflowCallRecord,
  WorkflowCheckpointTaken,
  WorkflowResumeCallDecision,
  WorkflowRunFallback,
  WorkflowRunLimits,
  WorkflowRunResult,
} from "./workflow-result.js";
import type { McpServerConfig } from "./steps/mcp-config.js";
import type { WorkflowRecordedError } from "./errors.js";
import {
  MAX_AGENT_RETRIES,
  MAX_AGENTS_PER_RUN,
  MAX_CONCURRENCY,
} from "./config.js";
import {
  errorMessage,
  isAuthRequired,
  isProviderUsageLimit,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "./errors.js";
import { afterFailedAttempt } from "./failed-attempt.js";
import { createWorkflowLogger } from "./runs/persistence/logger.js";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import { projectRecordedError } from "./recorded-error.js";
import { registerRunTripwire } from "./rejection-tripwire.js";
import type { LiveResume, OccurrenceResume, PreparedContinuation } from "./resume.js";
import { buildResumeReport } from "./resume-report.js";
import { nestedRunId } from "./resume-identity.js";
import { createPairing, type RecordedScope } from "./resume-pairing.js";
import type { ResumeRow, ResumeRows } from "./resume-rows.js";
import {
  createDecisionLog,
  createStepLedger,
  type LedgerCall,
  type Pairing,
  type SourceRow,
  type SourceScope,
  type StepSlot,
} from "./step-ledger.js";
import {
  cloneTelemetry,
  deepFreeze,
  hashCanonicalStrictJson,
  strictSnapshot,
} from "./strict-json.js";
import { captureCallPath } from "./call-path.js";
import { isPlace, NO_PLACES, type RunPlaces, type Worktree } from "./places/places.js";
import { nestedArgs } from "./workflows/meta.js";
import { parseWorkflowScript } from "./workflows/script.js";
import {
  createSousGlobals,
  DEFAULT_MAX_NESTING_DEPTH,
  type CodeStepOptions,
} from "./sous-globals.js";
import { parseDurationSeconds } from "./duration.js";
import { EXEC_MODEL, EXEC_RESULT_SCHEMA, runCodeStep, type CodeStepEnv, type ExecSpec } from "./code-steps.js";

// WorkflowMeta / WorkflowMetaPhase / JournalEntry / WorkflowRunResult are the
// host-facing types (defined once in workflow-result.ts). The bare engine
// returns the result MINUS the run-manager's terminal status trio; the manager stamps
// status/reason/resetHint on top (the engine seam is never widened).
export type { WorkflowMeta, WorkflowMetaPhase, JournalEntry } from "./workflow-result.js";

/** A step's worktree, or why the step works without one. */
interface StepWorktree {
  isolated: boolean;
  cwd: string;
  tree?: Worktree;
  reason?: string;
}

/** Bare engine return: the host-facing WorkflowRunResult MINUS the manager's terminal
 *  status trio (status/reason/resetHint). The WorkflowManager composes those on top. */
export type EngineRunResult<T = unknown> = Omit<WorkflowRunResult<T>, "status" | "reason" | "resetHint">;

/**
 * Base run options the engine shares with its callers. The engine builds no agent of
 * its own, so these are plain fields it passes on.
 */
export interface WorkflowAgentOptions {
  /** Base working directory for the run (e.g. the project root). */
  cwd?: string;
  /**
   * Host-pinned model/backend for calls that author no model and have no agentType model or
   * phase/meta route. Unlike a runner's ambient default, this participates in the call
   * identity hash and therefore stays deterministic throughout the run and its nested workflows.
   */
  defaultModel?: string;
}

/** The message as a sentence, with one period at its end. */
const sentence = (message: string) => (/[.!?]$/.test(message.trimEnd()) ? message.trimEnd() : `${message}.`);

/** The pause a failed or stopped step causes. The manager reads its code and pauseReason. */
function stepFailedPause(
  label: string,
  message: string,
  details: { code: WorkflowErrorCode; pauseReason?: string; details?: unknown },
): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.PAUSE_REQUESTED, {
    recoverable: false,
    agentLabel: label,
    details: { stepFailed: true, ...details },
  });
}

/** True for the pause a failed or stopped step causes. */
export function isStepFailedPause(error: { code?: unknown; details?: unknown } | undefined): boolean {
  return (
    error?.code === WorkflowErrorCode.PAUSE_REQUESTED &&
    typeof error.details === "object" &&
    error.details !== null &&
    (error.details as { stepFailed?: unknown }).stepFailed === true
  );
}

/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps hold across nesting instead of each
 * level getting its own limiter and counters.
 */
export interface SharedRuntime {
  /** Host selections address agent() occurrences only; checkpoints still consume the run call limit. */
  agentOccurrenceCount?: number;
  /** An unanswered checkpoint cannot be converted into approval by catching its signal. */
  pendingCheckpoint?: WorkflowError;
  /** The root run's host pause request, visible to every nested workflow() engine. */
  pauseSignal?: AbortSignal;
  /** Set once a pause request refused an admission; catching it cannot keep the run going. */
  pendingPause?: WorkflowError;
  /** Root-wide count of allocated calls that have not settled, so a pause can drain them. */
  liveCalls?: { count: number; waiters: Set<() => void> };
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  tokenUsage: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
  /** Root-run-wide workflow() invocation ordinal. Monotonic and never decremented. */
  nestedSeq: number;
  /** Root-execution activity shared by nested workflow engines. */
  resumeActivity?: {
    active: number;
    invalid: boolean;
    retired?: boolean;
    onChange?: (active: number) => void;
  };
}

/** What a nested workflow() run gets from the run that calls it. A root run has none. */
interface NestedRun {
  /** The root run's shared runtime. */
  runtime: SharedRuntime;
  /** How many workflow() levels sit above this run. The root is 0, so a nested run is 1 or more. */
  depth: number;
}

export interface WorkflowCallbackContext {
  /** The runWorkflow invocation that produced this callback. */
  scope: string;
}

/** Narrow host-control seam for one live runner attempt. */
export interface WorkflowAgentAttemptControl {
  callIndex: number;
  label: string;
  scope: string;
  controller: AbortController;
}

/**
 * What a resumed run starts from. Rows go with no plan or an "occurrence-v1" one. A "live" plan
 * goes with no rows.
 */
export type WorkflowResume = {
  /** The interrupted calls a live call can go on from, by call index. */
  continuation?: PreparedContinuation;
} & (
  | {
      /**
       * The recorded rows of the run and of its nested runs, by scope. A call takes the next row
       * with its key.
       */
      rows: ResumeRows;
      /** The manager's plan. With one, the run reports a decision for each call. */
      plan?: OccurrenceResume;
    }
  | {
      rows?: undefined;
      /** The manager's plan: every call runs live, and the run reports each decision. */
      plan?: LiveResume;
    }
);

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  /**
   * REQUIRED. The runner for agent steps: the steps module, or a test's fake. The engine
   * calls only its run() method and builds no runner of its own.
   */
  agent: AgentRunner;
  concurrency?: number;
  /** Retry attempts after a recoverable agent failure. Default 0. */
  agentRetries?: number;
  signal?: AbortSignal;
  /**
   * Host pause request. Once it fires, agent calls already executing finish and journal, no new
   * agent()/checkpoint() is admitted (queued calls settle as interrupted rows), and the run
   * settles with PAUSE_REQUESTED instead of a result. Ignored while `signal` is aborted.
   */
  pauseSignal?: AbortSignal;
  /** Maximum number of agents allowed in this run. Default: 1000 */
  maxAgents?: number;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Absolute workflow persistence root for log persistence. */
  persistenceRoot?: string;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /**
   * Internal (manager): what the run resumes from. A live call goes on only in a session of the
   * plan's source run, or of this run when there is no plan.
   */
  resume?: WorkflowResume;
  /** Manager-owned absolute root-execution activity count. The engine reports
   *  every transition; it includes logical primitives and raw runner promises. */
  onResumeActivity?: (active: number) => void;
  /** Manager-owned absolute root agent/checkpoint allocation count. */
  onResumeCallAllocated?: (allocated: number) => void;
  /** Manager-owned incremental report sink. Invoked once per terminal root call
   *  decision so paused/failed executions do not need an EngineRunResult. */
  onResumeDecision?: (decision: WorkflowResumeCallDecision) => void;
  /** Called after each live agent/checkpoint completes so the caller can persist the journal. */
  onAgentJournal?: (entry: JournalEntry) => void;
  /** Observability callbacks; neither participates in journal identity. */
  onFallback?: (entry: WorkflowRunFallback) => void;
  onCheckpointTaken?: (entry: WorkflowCheckpointTaken) => void;
  /** Called at each call's terminal transition after the authoritative manifest append. */
  onCallRecord?: (record: WorkflowCallRecord) => void;
  /**
   * Registers one live runner attempt for host-directed per-call cancellation. The optional
   * cleanup returned by the host is called exactly once when that attempt settles.
   */
  onAgentAttempt?: (attempt: WorkflowAgentAttemptControl) => void | (() => void);
  /** Called synchronously when workflow() allocates a unique child-run ordinal. */
  onNestedWorkflow?: (ordinal: number, childRunId: string) => void;
  /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Per-run changes to steps, by label, such as { reviewer: { model: "haiku" } }. */
  stepOverrides?: Record<string, Record<string, unknown>>;
  /** The environment code steps run with. Nested runs get the same. */
  codeEnv?: CodeStepEnv;
  /** How deep workflow() may nest. Default 5. */
  maxNestingDepth?: number;
  /** Names of the saved workflows an agent may pick with choose({ any: true }). */
  listSavedWorkflows?: () => Array<{ name: string; description?: string }>;
  /**
   * The places of the run tree: where nested runs and steps with `isolation: "worktree"` get their
   * worktrees, and where those are noted. Nested runs get the same object. Without it, a step works
   * in the run's folder and a nested run can only ask for place "folder".
   */
  places?: RunPlaces;
  /**
   * Ask the human a checkpoint() question and resolve to their explicit reply.
   * Missing, rejected, timed-out, or unanswered interactions durably pause the run.
   */
  confirm?: CheckpointConfirm;
  /** Internal cumulative usage seed restored before a same-run continuation executes. */
  tokenUsageBaseline?: Readonly<SharedRuntime["tokenUsage"]>;
  onLog?: (message: string, context?: WorkflowCallbackContext) => void;
  onPhase?: (title: string, context?: WorkflowCallbackContext) => void;
  onAgentStart?: (event: {
    label: string;
    phase?: string;
    prompt: string;
    model?: string;
    configOptions?: Record<string, string | boolean>;
    callIndex: number;
    /** The structural call-path key (same value as WorkflowCallRecord.path), when captured. */
    path?: string;
    scope: string;
  }) => void;
  onAgentEnd?: (event: {
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    worktree?: string;
    model?: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
    /** The call's session record (live or journal-replayed), when one exists. */
    session?: AgentSessionRecord;
    callIndex: number;
    scope: string;
    usage?: AgentUsage;
    modelResolved?: string;
    backendId?: string;
    provenance?: AgentResultProvenance;
    errorRecord?: WorkflowRecordedError;
  }) => void;
  onAgentHistory?: (event: {
    label: string;
    phase?: string;
    history: AgentHistoryEntry[];
    callIndex: number;
    scope: string;
  }) => void;
  onTokenUsage?: (
    usage: {
      input: number;
      output: number;
      total: number;
      cost: number;
      cacheRead?: number;
      cacheWrite?: number;
    },
    context?: WorkflowCallbackContext,
  ) => void;
}

const AGENT_OPTION_KEYS = [
  "label",
  "phase",
  "schema",
  "model",
  "mode",
  "configOptions",
  "isolation",
  "agentType",
  "retries",
  "cwd",
  "mcpServers",
  "images",
  "keepSession",
  // sous additions
  "timeout",
  "effort",
  "skills",
  "mcp",
  "continue",
] as const;
const AGENT_OPTION_KEY_SET = new Set<string>(AGENT_OPTION_KEYS);
// Options a step once took. A step that sets one is refused with a message that names it.
const REMOVED_AGENT_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  // tier read a model table from the old home folder, and dropped the run's model when set.
  ["tier", 'tier is gone. Set the model with model, such as "claude/haiku", or name an agent with agentType.'],
  // The three below changed nothing a step did.
  ["meta", "meta is gone. No harness read it. Remove it from the step."],
  ["promptMeta", "promptMeta is gone. No harness read it. Remove it from the step."],
  ["resume", "resume is gone. A resume replays the calls that match the recorded ones. Remove it from the step."],
];

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Run this agent with a model spec. `claude`, `codex`, or a registered custom
   * name may prefix an id and is stripped once; the remainder is sent byte-for-byte. A backend
   * name alone preserves its harness default. Unregistered prefixes go intact to the default.
   */
  model?: string;
  /**
   * The harness mode for this step. Claude Code: a permission mode. Codex: read-only,
   * workspace-write, agent or agent-full-access. A mode the harness lacks leaves its
   * default and adds a note. A set mode is part of the journal identity hash.
   */
  mode?: string;
  /**
   * Accepted for older scripts. No harness reads it. The reserved `model` id is still
   * rejected (use `model`), and a non-empty map still enters the journal identity hash,
   * in ascending option-id order, so old journals keep replaying.
   */
  configOptions?: Record<string, string | boolean>;
  isolation?: "worktree";
  /**
   * Name of an agent. The runner's route() finds it and binds its tools, model and prompt. An
   * explicit `model` overrides the agent's model, and the agent's model overrides the run's.
   * A runner with no route() gets the name as a prose hint in the instructions.
   */
  agentType?: string;
  /** Retry attempts after a recoverable failure for this specific agent. */
  retries?: number;
  /**
   * Working directory for this agent's step. A relative path resolves against the
   * run's base cwd (WorkflowRunOptions.cwd). Worktree isolation overrides it (the worktree
   * IS the agent's cwd). ADDITIVE like mcpServers: it wires the agent's environment, not
   * the logical call, so it is intentionally NOT part of the resume identity hash
   * (hashAgentCall).
   */
  cwd?: string;
  /**
   * Client-provided MCP servers for this agent's step. The harness gets each one in place of
   * a configured server of the same name. ADDITIVE: it wires tools, not the logical call,
   * so it is intentionally NOT part of the resume identity hash (hashAgentCall).
   */
  mcpServers?: McpServerConfig[];
  /**
   * Base64 image attachments sent to the harness with the prompt.
   * ADDITIVE: it shapes the agent input, not the logical call identity, so it is intentionally
   * NOT part of the resume identity hash (hashAgentCall).
   */
  images?: readonly PromptImage[];
  /**
   * Marks the agent's session record `keptOpen` and changes nothing else. It stays in
   * the call's input fingerprint (hashCallInputs), not in the resume identity hash
   * (hashAgentCall).
   */
  keepSession?: boolean;
  /**
   * Time limit for one attempt, in seconds or as "90s", "10m", "1h". When it
   * runs out the attempt fails with a recoverable error, so the step's retries apply.
   */
  timeout?: number | string;
  /** Reasoning effort for this step ("low" | "medium" | "high" | "xhigh" | "max"). Replaces the agent definition's. */
  effort?: string;
  /** Skill names for this step. Replaces the agent definition's list. */
  skills?: string[];
  /** MCP server names (from the host's servers file). Replaces the agent definition's list. */
  mcp?: string[];
  /**
   * Continue the session of an earlier step with this label instead of a fresh
   * session. Falls back to fresh when the session cannot be reopened.
   */
  continue?: string;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /** Session records for every session the run observed (live via onSessionOpen,
   *  replayed via JournalEntry.session), in completion order -> result.agentSessions. */
  agentSessions: AgentSessionRecord[];
  fallbacks: WorkflowRunFallback[];
  checkpointsTaken: WorkflowCheckpointTaken[];
  /** Engine-owned terminal-call manifest for this run's local index space. */
  calls: WorkflowCallRecord[];
  /** Run-local terminal transition ordinal. */
  settlementSeq: number;
}

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

/** Observable call-input fingerprint format. Bump when its inputs or encoding change. */
export const CALL_INPUTS_FORMAT = 2;

export interface WorkflowRunLimitOptions {
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
}

/** Resolve the run limits once so admission, persistence, and execution report the same values. */
export function resolveWorkflowRunLimits(options: WorkflowRunLimitOptions): WorkflowRunLimits {
  return {
    maxAgents: options.maxAgents ?? MAX_AGENTS_PER_RUN,
    concurrency: normalizeConcurrency(
      options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
    ),
    agentRetries: normalizeAgentRetries(options.agentRetries ?? 0),
  };
}

/** Convert a workflow name into the path-free base used for its vm filename. */
export function sanitizeVmName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return sanitized || "workflow";
}

export function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<EngineRunResult<T>> {
  return runLevel<T>(script, options, undefined);
}

/** Runs one level of a run tree. `runWorkflow` starts the root, and workflow() starts each nested level. */
async function runLevel<T>(
  script: string,
  options: WorkflowRunOptions,
  nested: NestedRun | undefined,
): Promise<EngineRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  // Per-phase model routing from meta.phases[].model, with meta.model as the default.
  const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
  const effectiveLimits = resolveWorkflowRunLimits(options);
  const {
    maxAgents,
    concurrency,
    agentRetries: runAgentRetries,
  } = effectiveLimits;
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const resumeRows = options.resume?.rows;
  assertExplicitCheckpointProvenance({
    journal: resumeRows
      ? [...resumeRows.values()].flatMap((scope) => scope.rows.flatMap((row) => (row.entry ? [row.entry] : [])))
      : undefined,
  });
  const callbackContext: WorkflowCallbackContext = { scope: runId };
  const baseCwd = options.cwd ?? process.cwd();
  const places = options.places ?? NO_PLACES;
  const vmFilename = `${sanitizeVmName(meta.name)}.js`;
  const preludeLines = DETERMINISM_PRELUDE.split("\n").length;

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persistenceRoot: options.persistenceRoot,
    persist: options.persistLogs ?? true,
    onLog: (message) => options.onLog?.(message, callbackContext),
  });

  const state: RuntimeState = {
    logs: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    callSeq: 0,
    agentSessions: [],
    fallbacks: [],
    checkpointsTaken: [],
    calls: [],
    settlementSeq: 0,
  };

  // The latest session of the step with this label, for agent({ continue }).
  const sessionForLabel = (label: string | undefined): AgentSessionRef | undefined => {
    if (typeof label !== "string" || label === "") return undefined;
    for (let i = state.agentSessions.length - 1; i >= 0; i--) {
      const record = state.agentSessions[i]!;
      if (record.label !== label) continue;
      const { callIndex: _callIndex, label: _label, phase: _phase, keptOpen: _keptOpen, ...ref } = record;
      return ref as AgentSessionRef;
    }
    return undefined;
  };

  const agentRunner = options.agent;
  // Global caps are shared with any nested workflow() so they hold across nesting.
  const shared: SharedRuntime = nested?.runtime ?? {
    limiter: createLimiter(concurrency),
    agentCount: 0,
    tokenUsage: copyTokenUsageBaseline(options.tokenUsageBaseline),
    nestedSeq: 0,
    ...(options.pauseSignal ? { pauseSignal: options.pauseSignal } : {}),
  };
  const pauseSignal = shared.pauseSignal;
  const liveCalls = (shared.liveCalls ??= { count: 0, waiters: new Set() });
  const resumeActivity = shared.resumeActivity ?? {
    active: 0,
    invalid: false,
    onChange: options.onResumeActivity,
  };
  shared.resumeActivity = resumeActivity;
  const limiter = shared.limiter;
  // A step with isolation "worktree" works in a worktree of its own, which places makes and removes.
  const openStepWorktree = (callIndex: number, label: string): StepWorktree => {
    const made = places.makeStepWorktree(baseCwd, { runId, index: callIndex, label });
    return "tree" in made ? { isolated: true, cwd: made.tree.dir, tree: made.tree } : { isolated: false, cwd: baseCwd, reason: made.reason };
  };
  const closeStepWorktree = (worktree: StepWorktree | undefined): void => {
    if (worktree?.tree) places.removeStepWorktree(baseCwd, worktree.tree);
  };
  let nestedWorkflows = false;
  // This run's own workflow() count, taken in call order.
  let nestedLocalSeq = 0;
  let abortSignaled = false;
  let rootCallsAllocated = 0;
  let realmObjectPrototype: object | undefined;

  const transitionResumeActivity = (delta: 1 | -1) => {
    const next = resumeActivity.active + delta;
    if (!Number.isSafeInteger(next) || next < 0) {
      resumeActivity.invalid = true;
      return;
    }
    resumeActivity.active = next;
    try {
      resumeActivity.onChange?.(next);
    } catch {
      resumeActivity.invalid = true;
    }
  };

  const beginResumeActivity = () => transitionResumeActivity(1);
  const observeResumeActivity = <T>(promise: Promise<T>): Promise<T> => {
    let observed = false;
    const settleActivity = () => {
      if (observed) return;
      observed = true;
      if (resumeActivity.retired) return;
      transitionResumeActivity(-1);
    };
    void promise.then(settleActivity, settleActivity);
    return promise;
  };

  const reportRootCallAllocated = (callIndex: number) => {
    if (nested) return;
    const allocated = callIndex + 1;
    if (allocated !== rootCallsAllocated + 1) {
      resumeActivity.invalid = true;
      return;
    }
    rootCallsAllocated = allocated;
    try {
      options.onResumeCallAllocated?.(allocated);
    } catch {
      resumeActivity.invalid = true;
    }
  };

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  const phase = (title: string, ...deletedOptions: unknown[]) => {
    if (deletedOptions.length > 0) {
      // §7: the per-phase budget option is deleted — phase takes NO
      // options. An unknown second argument (the budget surface's
      // `{ budget }` included) is a script error naming the deleted
      // surface, exactly like an unknown agent option key.
      throw new WorkflowError(
        "phase() takes no options — the per-phase budget option was deleted with the budget surface (§7); call phase(title) with only the title",
        WorkflowErrorCode.SCRIPT_ERROR,
        { recoverable: false },
      );
    }
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    options.onPhase?.(title, callbackContext);
  };

  // Run-scoped fault channel: when the rejection tripwire fires (a promise the SCRIPT
  // floated rejected with nobody listening), the run is already failing with SCRIPT_ERROR —
  // this controller cancels the run's in-flight agents so the zombie script stops spending
  // tokens. Combined with the caller's signal so both channels cancel the same work.
  const faults = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, faults.signal]) : faults.signal;
  if (signal.aborted) abortSignaled = true;
  signal.addEventListener(
    "abort",
    () => {
      abortSignaled = true;
    },
    { once: true },
  );

  // A pause request is a gate, not a cancellation: nothing already executing is interrupted, but
  // every later admission (and every queued attempt) refuses with PAUSE_REQUESTED. Like a pending
  // checkpoint, the refusal is remembered so a script that catches it cannot keep the run going.
  // A failed or stopped step sets pendingPause, which gates admissions the same way.
  const pauseRequested = () => (pauseSignal?.aborted === true || shared.pendingPause !== undefined) && !signal.aborted;
  const pauseError = () =>
    (shared.pendingPause ??= new WorkflowError(
      "workflow paused by host request: executing agent calls finished, nothing new was admitted",
      WorkflowErrorCode.PAUSE_REQUESTED,
      { recoverable: false },
    ));
  // Resolves once every allocated call in the root run and its nested engines has settled.
  const drainLiveCalls = (): Promise<void> =>
    liveCalls.count === 0 ? Promise.resolve() : new Promise((resolve) => liveCalls.waiters.add(resolve));
  const noteCallUnsettled = () => {
    liveCalls.count += 1;
  };
  const noteCallSettled = () => {
    liveCalls.count -= 1;
    if (liveCalls.count > 0) return;
    const waiters = [...liveCalls.waiters];
    liveCalls.waiters.clear();
    for (const resolve of waiters) resolve();
  };

  // Halt gate for work that already produced a value: a stop or a pending checkpoint discards
  // it, a pause request does not (the finished call is exactly what a pause preserves).
  const throwIfHalted = () => {
    if (signal.aborted) {
      abortSignaled = true;
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
    if (shared.pendingCheckpoint) throw shared.pendingCheckpoint;
  };
  // Admission gate: additionally refuses to start anything new once a pause is requested.
  const throwIfAborted = () => {
    throwIfHalted();
    if (pauseRequested()) throw pauseError();
  };

  const reportTerminalObserverError = (observer: string, error: unknown) => {
    try {
      logger.error(`${observer} terminal observer failed: ${errorMessage(error)}`);
    } catch {
      // Terminal observer reporting is itself best-effort.
    }
  };

  const guardTerminal = (observer: string, callback: (() => void) | undefined) => {
    if (!callback) return;
    try {
      callback();
    } catch (error) {
      reportTerminalObserverError(observer, error);
    }
  };

  const resumePlan = options.resume?.plan;
  const preparedContinuation = options.resume?.continuation;
  // A resume plan reports a decision for each call, in the order calls were opened.
  const decisionLog = createDecisionLog({
    reports: resumePlan !== undefined,
    onDecision: (decision) => guardTerminal("onResumeDecision", () => options.onResumeDecision?.(decision)),
  });
  const appendCallRecord = (
    input: Omit<WorkflowCallRecord, "settlementOrdinal" | "scope">,
  ): WorkflowCallRecord => {
    const record = deepFreeze({
      ...input,
      settlementOrdinal: ++state.settlementSeq,
      scope: runId,
    } satisfies WorkflowCallRecord);
    state.calls.push(record);
    guardTerminal("onCallRecord", () => options.onCallRecord?.(record));
    return record;
  };

  // A resume that pairs by occurrence: the n-th call with a key takes the n-th recorded row with
  // it, from the scope's own rows first and then its seed's. An agent's empty text runs live. A
  // live call that took a failed row of this run can go on in that row's session.
  const occurrenceSource = (scope: RecordedScope<ResumeRow> | undefined): SourceScope => {
    const pairNext = createPairing(scope ?? { rows: [], key: "hash" });
    return {
      pair(call, accept) {
        const paired = pairNext(call);
        if (paired.action === "live" || !paired.row.entry) {
          const failed = paired.row;
          return {
            action: "live",
            reason: "not-recorded",
            ...(failed ? { failed: { sourceRunId: failed.sourceRunId, recordedIndex: failed.index } } : {}),
          };
        }
        const { row } = paired;
        if (call.kind === "agent" && isEmptyTextAgentResult(row.entry!.result, call.hasSchema)) {
          return { action: "live", reason: "empty-output" };
        }
        const sourceRow: SourceRow = {
          sourceRunId: row.sourceRunId,
          recordedIndex: row.index,
          entry: row.entry!,
          ...(row.call ? { call: row.call } : {}),
          ...(row.injected ? { injected: true as const } : {}),
        };
        return {
          action: "replay",
          row: sourceRow,
          value: accept(sourceRow),
          match: "occurrence",
          journaled: row.own === true && row.index === call.index,
        };
      },
    };
  };

  const ledger = createStepLedger({
    source: resumeRows
      ? occurrenceSource(resumeRows.get(runId))
      : resumePlan?.strategy === "live"
        ? { pair: () => ({ action: "live", reason: "strategy-live" }) }
        : undefined,
    log: decisionLog,
    counter: { next: () => state.callSeq++ },
    sink: {
      call: appendCallRecord,
      journal: (entry) => guardTerminal("onAgentJournal", () => options.onAgentJournal?.(entry)),
    },
    unsettled: { armed: noteCallUnsettled, settled: noteCallSettled },
  });

  // Allocation happens before limiter admission, so a run can halt while calls are
  // either executing or still queued. Each call arms its ledger slot with the function
  // that settles it, and the ledger synchronously turns every remaining allocation into an
  // aborted engine row when the run stops. This preserves the dense manifest without
  // waiting for a backend that may ignore cancellation during wind-down. No agent or
  // checkpoint call is terminal-safe, so a root run retires its pending activity only when
  // no call was unsettled. Any other halt keeps the quiescence barrier.
  const interruptUnsettledCalls = () => {
    const terminalSafe = ledger.interruptUnsettled();
    if (nested === undefined && terminalSafe && !nestedWorkflows && !resumeActivity.retired) {
      resumeActivity.retired = true;
      while (resumeActivity.active > 0) transitionResumeActivity(-1);
    }
  };
  signal.addEventListener("abort", interruptUnsettledCalls, { once: true });

  // The start every agent, code and checkpoint call shares. `run` is the kind. Its `open`
  // takes the call's index from the ledger, counts the call as resume activity until the
  // call's promise settles, and reports the index to the manager. A call that fails before it
  // opens counts nothing.
  const startCall = (run: (open: (call: LedgerCall) => StepSlot) => Promise<unknown>): Promise<unknown> => {
    let opened = false;
    let promise: Promise<unknown>;
    try {
      promise = run((call) => {
        const slot = ledger.open(call);
        opened = true;
        beginResumeActivity();
        reportRootCallAllocated(slot.index);
        return slot;
      });
    } catch (error) {
      promise = Promise.reject(error);
    }
    return opened ? observeResumeActivity(promise) : promise;
  };
  // The cap counts agent, code and checkpoint calls, across nested runs.
  const checkAgentLimit = () => {
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
  };
  // A call opened while the run is halting settles as interrupted at once.
  const interruptIfHalting = (slot: StepSlot) => {
    if (signal.aborted || pauseRequested()) {
      slot.interrupt();
      throwIfAborted();
    }
  };

  // One step. An agent step goes to the agent runner. A code step brings its spec and the
  // engine runs it here; its prompt is the spec as JSON and its model is "exec", so it keeps
  // the identity it had when code steps went through the agent runner.
  const agentImplementation = (
    prompt: string,
    agentOptions: AgentOptions,
    open: (call: LedgerCall) => StepSlot,
    codeSpec?: ExecSpec,
  ): Promise<unknown> => {
    validateAgentOptions(agentOptions, realmObjectPrototype);
    throwIfAborted();

    checkAgentLimit();

    const assignedPhase = agentOptions.phase ?? state.currentPhase;
    const agentOrdinal = shared.agentOccurrenceCount ?? 0;

    const requestedLabel = agentOptions.label?.trim();
    const pendingLabel = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount + 1);

    // The step as the engine knows it. The runner routes it, and the route gives the model the
    // step asked for, its agent's part of the call hash, its isolation and its agent's prompt.
    // Model order: the step's own model, its agent's, then the run's model for this step. The
    // run's model is the phase's route, else meta.model, else the run's default.
    const ask: StepAsk = {
      label: pendingLabel,
      agentType: agentOptions.agentType,
      model: agentOptions.model,
      effort: agentOptions.effort,
      skills: agentOptions.skills,
      mcp: agentOptions.mcp,
      timeout: agentOptions.timeout,
      isolation: agentOptions.isolation,
      runModel: resolveModelForPhase(assignedPhase, routingConfig) ?? options.defaultModel,
    };
    // A code step, and a runner with no route of its own, get the engine's route, which has no agent.
    const route = !codeSpec && agentRunner.route ? agentRunner.route(ask) : unroutedStep(ask);
    const modelSpec = route.requested;
    if (modelSpec?.endsWith("/*")) {
      throw new WorkflowError(
        `agent ${JSON.stringify(pendingLabel)} model ${JSON.stringify(modelSpec)} is a discovery selector. Expand that provider with workflow action:"config" and modelFilter, then use an exact model route.`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false, agentLabel: pendingLabel },
      );
    }
    const effectiveMode = agentOptions.mode;
    const effectiveConfigOptions = agentOptions.configOptions === undefined ? undefined : { ...agentOptions.configOptions };
    const effectiveAgentOptions = { ...agentOptions, configOptions: effectiveConfigOptions };
    // For display in /workflows: the model this agent runs on, its explicit/phase/default
    // spec. The real resolved id overrides this via onModelResolved once the subagent
    // session is created.
    let displayModel = modelSpec;
    if (hasModelConfigOption(effectiveConfigOptions)) {
      // Surface the rejected effective call to validation/observability without invoking the
      // AgentRunner. The following assertion is the pre-session authority.
      options.onAgentStart?.({
        label: pendingLabel,
        phase: assignedPhase,
        prompt,
        model: displayModel,
        configOptions: effectiveConfigOptions,
        callIndex: state.callSeq,
        scope: runId,
      });
    }
    assertNoModelConfigOption(effectiveConfigOptions, pendingLabel);

    const resolvedIsolation = route.isolation;
    const retryAttempts =
      agentOptions.retries !== undefined ? normalizeAgentRetries(agentOptions.retries) : runAgentRetries;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount + 1);

    // Every identity component is computed before the index is allocated. A hash
    // serialization failure therefore consumes no index and leaves no journal gap.
    const callHash = hashAgentCall(
      prompt,
      modelSpec,
      effectiveMode,
      assignedPhase,
      effectiveAgentOptions,
      route.agentKey,
    );
    const callPath = captureCallPath(vmFilename, preludeLines);
    const callInputs = {
      cwd: agentOptions.cwd ?? null,
      isolation: resolvedIsolation ?? null,
      keepSession: agentOptions.keepSession === true,
      images: agentOptions.images ?? null,
      mcpServers: agentOptions.mcpServers ?? null,
      // meta, promptMeta and backends are gone. Their keys stay, always null, so the inputs
      // format does not change.
      meta: null,
      promptMeta: null,
      label,
      backends: null,
    };
    const callInputsHash = hashCallInputs(callInputs);

    // Deterministic resume key: assigned at lexical call time, before the limiter,
    // so parallel()/pipeline() fan-out is reproducible for a fixed script.
    const stepSlot = open({
      kind: "agent",
      hash: callHash,
      ...(callPath !== undefined ? { path: callPath } : {}),
      ...(callInputsHash !== undefined ? { inputsHash: callInputsHash } : {}),
      hasSchema: agentOptions.schema !== undefined,
      fields: {
        label,
        ...(modelSpec !== undefined ? { modelRequested: modelSpec } : {}),
        ...(effectiveMode === undefined ? {} : { modeRequested: effectiveMode }),
        ...(effectiveConfigOptions === undefined ? {} : { configOptionsRequested: { ...effectiveConfigOptions } }),
        ...(resolvedIsolation !== undefined ? { isolation: resolvedIsolation } : {}),
      },
    });
    const callIndex = stepSlot.index;

    const emitAgentEnd = (
      event: Omit<NonNullable<WorkflowRunOptions["onAgentEnd"]> extends (event: infer E) => void ? E : never, "callIndex" | "scope">,
    ) => {
      const terminalEvent = deepFreeze({ ...event, callIndex, scope: runId });
      guardTerminal("onAgentEnd", () => options.onAgentEnd?.(terminalEvent));
    };

    // Reserve the agent slot synchronously — atomic with the limit gate above
    // (no await in between) — so a parallel() fan-out can't all observe the
    // same agentCount and overshoot maxAgents.
    shared.agentCount++;
    shared.agentOccurrenceCount = agentOrdinal + 1;

    let precreatedWorktree: StepWorktree | undefined;
    let preparedRunCwd: string | undefined;
    let worktreePrepared = false;
    let agentStartEmitted = false;

    const emitAgentStart = () => {
      if (agentStartEmitted) return;
      agentStartEmitted = true;
      options.onAgentStart?.(deepFreeze({
        label,
        phase: assignedPhase,
        prompt,
        model: displayModel,
        configOptions: effectiveConfigOptions,
        callIndex,
        path: callPath,
        scope: runId,
      }));
    };

    // A halt settles the call as interrupted, and ends it when it has started.
    stepSlot.arm(() => {
      const error = pauseRequested()
        ? new WorkflowError(
            `agent "${label}" was not started because the workflow paused by host request`,
            WorkflowErrorCode.PAUSE_REQUESTED,
            { recoverable: false, agentLabel: label },
          )
        : new WorkflowError(
            `agent "${label}" interrupted because workflow execution halted`,
            WorkflowErrorCode.WORKFLOW_ABORTED,
            { recoverable: true, agentLabel: label },
          );
      const errorRecord = projectRecordedError(error);
      stepSlot.settle({
        outcome: "error",
        origin: "engine",
        error: errorRecord,
        aborted: true,
      });
      if (agentStartEmitted) {
        emitAgentEnd({
          label,
          phase: assignedPhase,
          result: null,
          tokens: 0,
          model: displayModel,
          error: error.message,
          errorCode: error.code,
          recoverable: error.recoverable,
          errorRecord,
        });
      }
    }, false);
    interruptIfHalting(stepSlot);

    // options.cwd, when given, must be a string.
    const checkCwdOption = () => {
      if (agentOptions.cwd !== undefined && typeof agentOptions.cwd !== "string") {
        throw new WorkflowError(
          `agent "${label}": options.cwd must be a string`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false, agentLabel: label },
        );
      }
    };
    // Opens the step's worktree.
    const openWorktree = (): StepWorktree => {
      const opened = openStepWorktree(callIndex, label);
      if (!opened.isolated) log(`isolation ignored for "${label}" (${opened.reason})`);
      return opened;
    };
    // The cwd the runner gets: the worktree when it is isolated, else options.cwd under the base.
    const stepCwd = (worktree: StepWorktree | undefined): string =>
      worktree?.isolated ? worktree.cwd : resolvePath(baseCwd, agentOptions.cwd ?? ".");

    // The recorded call whose session a live call can go on in: the one at its own index.
    let continuationIndex: number | undefined = callIndex;
    const runLive = () => limiter(async () => {
      const maxAttempts = retryAttempts + 1;
      let worktree = precreatedWorktree;
      let runCwd = preparedRunCwd;
      let attemptsRan = 0;
      let observedTokens = 0;
      const sealedUsage: AgentUsage[] = [];
      const continuationCandidate = continuationIndex === undefined
        ? undefined
        : preparedContinuation?.candidatesByIndex.get(continuationIndex);

      interface AttemptSlots {
        sealed: boolean;
        usage?: AgentUsage;
        sessionRef?: AgentSessionRef;
        /** The session's cumulative cost gauge at release; folded into the recorded ref. */
        sessionCostGauge?: number;
        modelResolved?: string;
        provenance?: AgentResultProvenance;
        history?: AgentHistoryEntry[];
      }

      const recordTokens = (value: unknown, usage: AgentUsage | undefined): number => {
        // A code step uses no model, so it counts no tokens.
        const tokens = codeSpec ? 0 : usage && usage.total > 0 ? usage.total : estimateTokens(value) + estimateTokens(prompt);
        if (usage) {
          shared.tokenUsage.input += usage.input;
          shared.tokenUsage.output += usage.output;
          shared.tokenUsage.cost += usage.cost;
          shared.tokenUsage.cacheRead += usage.cacheRead;
          shared.tokenUsage.cacheWrite += usage.cacheWrite;
        }
        shared.tokenUsage.total += tokens;
        observedTokens += tokens;
        options.onTokenUsage?.({ ...shared.tokenUsage }, callbackContext);
        return tokens;
      };

      const sealAttempt = (slot: AttemptSlots) => {
        if (slot.sealed) return;
        slot.sealed = true;
        if (slot.usage) sealedUsage.push(slot.usage);
      };

      const sessionRecord = (slot: AttemptSlots, keptOpen: boolean): AgentSessionRecord | undefined =>
        slot.sessionRef
          ? deepFreeze({
              ...slot.sessionRef,
              // `onSessionOpen` fires before the first prompt; the release-time gauge is what a
              // later continuation must baseline.
              ...(slot.sessionCostGauge === undefined ? {} : { costGauge: slot.sessionCostGauge }),
              callIndex,
              label,
              phase: assignedPhase,
              keptOpen,
            })
          : undefined;

      const emitContinuationNotice = (
        continuation: NonNullable<WorkflowRunFallback["continuation"]>,
      ) => {
        const message = continuation.outcome === "reattached"
          ? `continuation: reattached via session/${continuation.method}`
          : `continuation skipped (${continuation.reason}) — running fresh`;
        const fallback: WorkflowRunFallback = deepFreeze({
          callIndex,
          label,
          ...(assignedPhase === undefined ? {} : { phase: assignedPhase }),
          requestedSpec: modelSpec ?? "(default)",
          ...(continuationCandidate?.sessionRef.backendId === undefined
            ? {}
            : { backendId: continuationCandidate.sessionRef.backendId }),
          kind: "continuation",
          continuation,
          message,
        });
        if (state.fallbacks.some((entry) => sameFallback(entry, fallback))) return;
        state.fallbacks.push(fallback);
        guardTerminal("onFallback", () => options.onFallback?.(fallback));
      };

      const terminalUsage = (): AgentUsage | undefined => sumUsage(sealedUsage);

      // What a live step settles with after its outcome and error. Success and failure both use it.
      const liveFields = (origin: "runner" | "engine", slot: AttemptSlots | undefined, usage: AgentUsage | undefined) => ({
        ...(origin === "runner" ? { attempts: attemptsRan } : {}),
        ...(usage ? { usage } : {}),
        ...(slot?.modelResolved ? { modelResolved: slot.modelResolved } : {}),
        ...(slot?.sessionRef?.backendId ? { backendId: slot.sessionRef.backendId } : {}),
        ...(worktree?.isolated ? { worktree: true } : {}),
        ...(runCwd !== undefined && origin === "runner" ? { resolvedCwd: runCwd } : {}),
        ...(slot?.provenance ? { provenance: slot.provenance } : {}),
      });

      const emitFailure = (
        thrown: unknown,
        origin: "runner" | "engine",
        outcome: "null" | "error",
        slot: AttemptSlots | undefined,
        aborted: boolean,
      ) => {
        if (stepSlot.settled) return;
        const errorRecord = projectRecordedError(thrown);
        const workflowError = wrapError(thrown, { agentLabel: label });
        const usage = terminalUsage();
        const session = slot
          ? sessionRecord(
              slot,
              agentOptions.keepSession === true ||
                isProviderUsageLimit(workflowError) ||
                isAuthRequired(workflowError),
            )
          : undefined;
        if (session) state.agentSessions.push(session);
        stepSlot.settle({
          outcome,
          origin,
          error: errorRecord,
          ...(aborted ? { aborted: true as const } : {}),
          ...liveFields(origin, slot, usage),
        });
        emitAgentEnd({
          label,
          phase: assignedPhase,
          result: null,
          tokens: observedTokens,
          worktree: runCwd,
          model: slot?.modelResolved ?? displayModel,
          error: workflowError.message,
          errorCode: workflowError.code,
          recoverable: workflowError.recoverable,
          session,
          usage,
          modelResolved: slot?.modelResolved,
          backendId: slot?.sessionRef?.backendId,
          provenance: slot?.provenance,
          errorRecord,
        });
      };

      try {
        emitAgentStart();

        checkCwdOption();
        if (resolvedIsolation === "worktree" && !worktreePrepared) worktree = openWorktree();
        runCwd = stepCwd(worktree);

        let continuationSkipReason: ContinuationSkipReason | undefined;
        if (continuationCandidate) {
          if (continuationCandidate.hash !== callHash) {
            continuationSkipReason = "hash-mismatch";
          } else if (
            continuationCandidate.inputsHash === undefined ||
            continuationCandidate.inputsHash !== callInputsHash
          ) {
            continuationSkipReason = "inputs-mismatch";
          } else if (resolvedIsolation === "worktree") {
            continuationSkipReason = "worktree-isolated";
          } else if (continuationCandidate.recordedCwd !== runCwd) {
            continuationSkipReason = "cwd-mismatch";
          } else if (!existsSync(runCwd)) {
            continuationSkipReason = "cwd-missing";
          }
          if (continuationSkipReason) {
            emitContinuationNotice({ outcome: "skipped", reason: continuationSkipReason });
          }
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const slot: AttemptSlots = { sealed: false };
          const resumingTurn = attempt === 1 && continuationCandidate !== undefined && !continuationSkipReason;
          const continueFromSession = (resumingTurn ? continuationCandidate.sessionRef : undefined)
            ?? sessionForLabel(agentOptions.continue);
          let attemptController: AbortController | undefined;
          let unregisterAttempt: (() => void) | undefined;
          let hostAttemptRegistered = false;
          try {
            throwIfAborted();
            attemptController = new AbortController();
            const attemptSignal = AbortSignal.any([signal, attemptController.signal]);
            attemptsRan++;
            const registerAttempt = options.onAgentAttempt;
            if (registerAttempt) {
              hostAttemptRegistered = true;
              try {
                const cleanup = registerAttempt({
                  callIndex,
                  label,
                  scope: runId,
                  controller: attemptController,
                });
                if (typeof cleanup === "function") unregisterAttempt = cleanup;
              } catch (error) {
                bestEffortDebug(`agent ${label}: host attempt registration failed: ${errorMessage(error)}`);
              }
            }
            let result: unknown;
            try {
              let rawRunnerPromise: Promise<unknown>;
              beginResumeActivity();
              try {
                rawRunnerPromise = codeSpec ? runCodeStep(codeSpec, {
                  ...options.codeEnv, step: { scope: runId, callIndex, label },
                  cwd: runCwd,
                  signal: attemptSignal,
                  timeoutMs: millis(agentOptions.timeout),
                }) : agentRunner.run(prompt, {
                  label,
                  schema: agentOptions.schema,
                  signal: attemptSignal,
                  instructions: buildAgentInstructions(
                    assignedPhase,
                    agentOptions,
                    route.prompt,
                    resolvedIsolation,
                  ),
                  model: modelSpec,
                  mode: effectiveMode,
                  route,
                  cwd: runCwd,
                  mcpServers: agentOptions.mcpServers,
                  images: agentOptions.images,
                  runId,
                  ...(continueFromSession === undefined ? {} : { continueFromSession }),
                  // Agent({ continue }) sends this step's prompt into the earlier
                  // session. Only a resumed, interrupted turn gets the runner's resume instruction.
                  ...(continueFromSession !== undefined && !resumingTurn ? { continueWithPrompt: true } : {}),
                  callIndex,
                  callHash,
                  callPath,
                  callInputsHash,
                  onSessionOpen: (ref: AgentSessionRef) => {
                    if (slot.sealed) return;
                    const copied = cloneTelemetry(ref);
                    if (copied) slot.sessionRef = copied;
                  },
                  onSessionCostGauge: (amount: number) => {
                    if (slot.sealed) return;
                    if (Number.isFinite(amount) && amount >= 0) slot.sessionCostGauge = amount;
                  },
                  onModelResolved: (id: string) => {
                    if (slot.sealed) return;
                    slot.modelResolved = id;
                    displayModel = id;
                  },
                  onUsage: (reported: AgentUsage) => {
                    if (slot.sealed) return;
                    const copied = copyValidUsage(reported);
                    if (copied) slot.usage = copied;
                    else bestEffortDebug(`agent ${label}: dropped invalid usage report`);
                  },
                  onResultProvenance: (reported: AgentResultProvenance) => {
                    if (slot.sealed) return;
                    const copied = cloneTelemetry(reported);
                    if (copied) slot.provenance = copied;
                  },
                  onHistory: (history: AgentHistoryEntry[]) => {
                    if (slot.sealed) return;
                    const copied = cloneTelemetry(history);
                    if (!copied) {
                      bestEffortDebug(`agent ${label}: dropped uncopyable history report`);
                      return;
                    }
                    slot.history = copied;
                    options.onAgentHistory?.(deepFreeze({
                      label,
                      phase: assignedPhase,
                      history: copied,
                      callIndex,
                      scope: runId,
                    }));
                  },
                });
              } catch (error) {
                transitionResumeActivity(-1);
                throw error;
              }
              observeResumeActivity(rawRunnerPromise);
              result = hostAttemptRegistered
                ? await withAgentCancellation(rawRunnerPromise, attemptController.signal)
                : await rawRunnerPromise;
            } finally {
              sealAttempt(slot);
              if (continueFromSession !== undefined && !signal.aborted) {
                const continuation = slot.provenance?.source === "live"
                  ? slot.provenance.continuation
                  : undefined;
                if (continuation?.reattached === true) {
                  emitContinuationNotice({
                    outcome: "reattached",
                    method: continuation.method,
                  });
                } else {
                  emitContinuationNotice({
                    outcome: "skipped",
                    reason: continuation?.reattached === false
                      ? continuation.reason
                      : "runner-declined",
                  });
                }
              }
            }

            throwIfHalted();
            if (isEmptyTextAgentResult(result, agentOptions.schema !== undefined)) {
              throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                recoverable: true,
                agentLabel: label,
              });
            }
            const resultSnapshot = strictSnapshot(result, `agent "${label}" result`, label);
            recordTokens(result, slot.usage);
            const usage = terminalUsage();
            const session = sessionRecord(slot, agentOptions.keepSession === true);
            if (session) state.agentSessions.push(session);
            const entry = deepFreeze({
              index: callIndex,
              hash: callHash,
              result: resultSnapshot,
              kind: "agent" as const,
              scope: runId,
              ...(session ? { session } : {}),
              ...(usage ? { usage } : {}),
              call: {
                kind: "agent" as const,
                label,
                phase: assignedPhase,
                model: slot.modelResolved ?? displayModel,
                backendId: session?.backendId,
                ...(slot.provenance?.source === "live" &&
                  slot.provenance.continuation?.reattached === true
                  ? { continuation: { method: slot.provenance.continuation.method } }
                  : {}),
              },
            });
            const terminalRecord = stepSlot.settle({
              outcome: "result",
              origin: "runner",
              ...liveFields("runner", slot, usage),
            }, entry);
            if (terminalRecord.outcome !== "result") return result;
            emitAgentEnd({
              label,
              phase: assignedPhase,
              result: resultSnapshot,
              tokens: observedTokens,
              worktree: runCwd,
              model: slot.modelResolved ?? displayModel,
              session,
              usage,
              modelResolved: slot.modelResolved,
              backendId: slot.sessionRef?.backendId,
              provenance: slot.provenance,
            });
            return result;
          } catch (error) {
            if (!slot.sealed) sealAttempt(slot);
            const failed = afterFailedAttempt({
              hostStop: attemptController ? agentCancellationReason(attemptController.signal) : undefined,
              runStopped: signal.aborted,
              pausePending: pauseRequested(),
              thrown: error,
              label,
              attempt,
              maxAttempts,
            });
            if (failed.next === "host-stopped") {
              const cancellationReason = failed.reason;
              logger.error(
                `agent ${label} attempt ${attempt}/${maxAttempts} cancelled by host: ${cancellationReason.message}`,
              );
              recordTokens(null, slot.usage);
              // A step the user stopped pauses the run on it, like a failed step.
              const why = (cancellationReason.details as { pauseReason?: unknown } | undefined)?.pauseReason;
              const message = `step "${label}" was stopped${typeof why === "string" ? `: ${cancellationReason.message}` : ""}`;
              log(`${sentence(message)} The run pauses: resume it to run the step again.`);
              emitFailure(cancellationReason, "engine", "error", slot, false);
              throw (shared.pendingPause ??= stepFailedPause(label, message, {
                code: WorkflowErrorCode.AGENT_CANCELLED,
                ...(typeof why === "string" ? { pauseReason: why } : {}),
              }));
            }
            if (failed.next === "run-stopped") {
              emitFailure(error, attemptsRan > 0 ? "runner" : "engine", "error", slot, true);
              throw error;
            }
            if (failed.next === "pause-pending") {
              // Either the attempt was refused at its start, or it failed while a pause was
              // pending and must not retry now. Both are interrupted rows that run again on resume.
              emitFailure(error, attemptsRan > 0 ? "runner" : "engine", "error", slot, true);
              throw pauseError();
            }

            const workflowError = failed.error;
            logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
            recordTokens(null, slot.usage);

            if (failed.next === "retry") {
              log(
                `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
              );
              continue;
            }

            // A step that fails on its last try, or in a way a retry cannot fix, pauses the whole
            // run. Steps already running finish and journal, and nothing new starts. The user fixes
            // the cause and resumes: the finished steps replay and this one runs again.
            if (failed.next === "pause-run") {
              const tries = workflowError.recoverable ? `after ${maxAttempts} tr${maxAttempts === 1 ? "y" : "ies"}` : "and a retry cannot fix it";
              const message = `step "${label}" failed ${tries}: ${workflowError.message}`;
              log(`${sentence(message)} The run pauses: fix the cause and resume it.`);
              emitFailure(workflowError, "runner", "error", slot, false);
              throw (shared.pendingPause ??= stepFailedPause(label, message, {
                code: workflowError.code,
                ...(workflowError.details !== undefined ? { details: workflowError.details } : {}),
              }));
            }
            if (failed.next === "return-null") {
              log(
                `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
              );
              emitFailure(workflowError, "runner", "null", slot, false);
              return null;
            }
            emitFailure(workflowError, "runner", "error", slot, false);
            throw workflowError;
          } finally {
            if (unregisterAttempt) {
              try {
                unregisterAttempt();
              } catch (error) {
                bestEffortDebug(`agent ${label}: host attempt cleanup failed: ${errorMessage(error)}`);
              }
            }
          }
        }
        return null;
      } catch (error) {
        if (!stepSlot.settled) {
          emitFailure(error, attemptsRan > 0 ? "runner" : "engine", "error", undefined, signal.aborted || pauseRequested());
        }
        throw error;
      } finally {
        closeStepWorktree(worktree);
      }
    });

    const replayAgent = async (pairing: Extract<Pairing<unknown>, { action: "replay" }>): Promise<unknown> => {
      const { row, value: resultSnapshot } = pairing;
      await Promise.resolve();
      // A halt that lands here must still settle this allocation: nothing downstream will.
      if (signal.aborted || pauseRequested()) stepSlot.interrupt();
      throwIfAborted();
      emitAgentStart();
      // The recorded session, moved to this call's index, label and phase.
      let cachedSession: AgentSessionRecord | undefined;
      const recordedSession = cloneTelemetry(row.entry.session);
      if (recordedSession) {
        const { phase: _recordedPhase, ...session } = recordedSession;
        cachedSession = deepFreeze({
          ...session,
          callIndex,
          label,
          ...(assignedPhase === undefined ? {} : { phase: assignedPhase }),
        });
      }
      const cachedUsage = row.entry.usage ? copyValidUsage(row.entry.usage) : undefined;
      if (cachedSession) state.agentSessions.push(cachedSession);
      const entry = deepFreeze({
        index: callIndex,
        hash: callHash,
        result: resultSnapshot,
        kind: "agent" as const,
        scope: runId,
        ...(cachedSession ? { session: cachedSession } : {}),
        ...(cachedUsage ? { usage: cachedUsage } : {}),
        call: {
          kind: "agent" as const,
          label,
          phase: assignedPhase,
          model: displayModel,
          backendId: cachedSession?.backendId,
          ...(row.entry.call?.kind === "agent" && row.entry.call.continuation
            ? { continuation: row.entry.call.continuation }
            : {}),
        },
      });
      const terminalRecord = stepSlot.settle({
        outcome: "result",
        origin: "journal-replay",
        ...(cachedUsage ? { usage: cachedUsage } : {}),
        replay: {
          sourceRunId: row.sourceRunId,
          recordedIndex: row.recordedIndex,
          match: pairing.match,
        },
      }, pairing.journaled ? undefined : entry);
      if (terminalRecord.outcome !== "result") return resultSnapshot;
      emitAgentEnd({
        label,
        phase: assignedPhase,
        result: resultSnapshot,
        tokens: 0,
        model: displayModel,
        session: cachedSession,
        usage: cachedUsage,
      });
      return resultSnapshot;
    };

    const runPaired = (pairing: Pairing<unknown>): Promise<unknown> => {
      if (pairing.action === "replay") return replayAgent(pairing);
      // Pairing by occurrence goes on only in the session of the failed row this call took. The
      // sessions are those of the run this one resumes from.
      if (options.resume?.rows) {
        continuationIndex = pairing.failed?.sourceRunId === (resumePlan?.sourceRunId ?? runId)
          ? pairing.failed.recordedIndex
          : undefined;
      }
      let reason = pairing.reason;
      // A run that reports decisions opens the step's worktree before it decides, so the
      // decision can say when the worktree is not isolated.
      if (resumePlan && resolvedIsolation === "worktree") {
        emitAgentStart();
        try {
          checkCwdOption();
        } catch (error) {
          stepSlot.live(reason);
          throw error;
        }
        worktreePrepared = true;
        try {
          precreatedWorktree = openWorktree();
        } catch (error) {
          stepSlot.live("worktree-degraded");
          throw error;
        }
        if (!precreatedWorktree.isolated) reason = "worktree-degraded";
        preparedRunCwd = stepCwd(precreatedWorktree);
      }
      stepSlot.live(reason);
      return runLive();
    };

    // A call that fails before it runs or replays settles as an engine error.
    const failUnpaired = (error: unknown): never => {
      closeStepWorktree(precreatedWorktree);
      if (!stepSlot.settled) {
        const errorRecord = projectRecordedError(error);
        const workflowError = wrapError(error, { agentLabel: label });
        stepSlot.settle({ outcome: "error", origin: "engine", error: errorRecord });
        // A same-ID resume reports the end even before the start, as it always has.
        if (agentStartEmitted || !resumePlan) {
          emitAgentEnd({
            label,
            phase: assignedPhase,
            result: null,
            tokens: 0,
            model: displayModel,
            error: workflowError.message,
            errorCode: workflowError.code,
            recoverable: workflowError.recoverable,
            errorRecord,
          });
        }
      }
      throw error;
    };

    const accept = (row: SourceRow) => strictSnapshot(row.entry.result, `agent "${label}" replayed result`, label);
    try {
      return runPaired(stepSlot.pair(accept));
    } catch (error) {
      return failUnpaired(error);
    }
  };

  const step = (prompt: string, agentOptions: AgentOptions, codeSpec?: ExecSpec): Promise<unknown> =>
    startCall((open) => agentImplementation(prompt, agentOptions, open, codeSpec));
  const agent = (prompt: string, agentOptions: AgentOptions = {}): Promise<unknown> => step(prompt, agentOptions);
  // A code step: the same fields as before go into its identity.
  const code = (spec: ExecSpec, codeOptions: CodeStepOptions): Promise<unknown> =>
    step(JSON.stringify(spec), { ...codeOptions, model: EXEC_MODEL, schema: EXEC_RESULT_SCHEMA as TSchema }, spec);

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (signal.aborted) throw error;
          const workflowError = wrapError(error);
          // Non-recoverable failures (agent limit exhausted) must halt the whole
          // run, exactly like a directly-awaited agent() — not be swallowed into a
          // null in the result array.
          if (!workflowError.recoverable) throw workflowError;
          log(`parallel[${index}] failed: ${workflowError.message}`);
          return null;
        }
      }),
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (signal.aborted) throw error;
            const workflowError = wrapError(error);
            // Non-recoverable failures halt the whole run (see parallel()).
            if (!workflowError.recoverable) throw workflowError;
            log(`pipeline[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }
        return value;
      }),
    );
  };

  // Nested workflow(): run a saved workflow (or a raw script) inline, sharing this
  // run's limiter/counters so the global caps hold. Five levels deep by default.
  const workflowImplementation = async (
    nameOrScript: string,
    childArgs: unknown,
    nestedOptions: { place?: string; label?: string } | undefined,
    localOrdinal: number,
  ) => {
    throwIfAborted();
    const maxNestingDepth = options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH;
    // Depth is this run's own level, so parallel siblings don't add up.
    const ownDepth = nested?.depth ?? 0;
    if (ownDepth >= maxNestingDepth) {
      throw new WorkflowError(
        `workflow() can nest at most ${maxNestingDepth} levels deep`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    const ordinal = ++shared.nestedSeq;
    // The one place a child run id is made. A resume finds a nested run's call rows by this id.
    const childRunId = nestedRunId(runId, localOrdinal);
    nestedWorkflows = true;
    options.onNestedWorkflow?.(ordinal, childRunId);
    const resolved = options.loadSavedWorkflow?.(String(nameOrScript));
    const childScript = resolved ?? String(nameOrScript);
    const childName = resolved ? String(nameOrScript) : "inline";
    const label = typeof nestedOptions?.label === "string" ? nestedOptions.label : undefined;
    places.noteNested(childRunId, { parent: runId, workflow: childName, ...(label ? { label } : {}) });
    // The child gets its declared defaults, as it would started on its own.
    const args = nestedArgs(childName, parseWorkflowScript(childScript).meta, childArgs);
    // A nested workflow can ask for its own place (a worktree, a folder, none).
    const place = nestedOptions?.place;
    if (place !== undefined && !isPlace(place)) throw new Error(`place must be worktree, folder or none, got "${String(place)}"`);
    const childCwd = place !== undefined ? places.nestedPlace(childRunId, place, baseCwd) : options.cwd;
    const child = await runLevel(childScript, {
      ...options,
      args,
      cwd: childCwd,
      // The COMBINED signal, so a parent-side fault/abort cancels the child's agents too
      // (the child layers its own fault controller on top of this).
      signal,
      // A nested run finds its rows in the same resume rows by its run id. It has no plan and no
      // interrupted calls.
      resume: options.resume?.rows ? { rows: options.resume.rows } : undefined,
      onResumeCallAllocated: undefined,
      onResumeDecision: undefined,
      runId: childRunId,
      persistLogs: false,
    }, { runtime: shared, depth: ownDepth + 1 });
    state.fallbacks.push(...(child.fallbacks ?? []));
    state.checkpointsTaken.push(...(child.checkpointsTaken ?? []));
    return child.result;
  };

  const workflowFn = (nameOrScript: string, childArgs?: unknown, nestedOptions?: { place?: string; label?: string }): Promise<unknown> => {
    beginResumeActivity();
    let promise: Promise<unknown>;
    try {
      promise = workflowImplementation(nameOrScript, childArgs, nestedOptions, ++nestedLocalSeq);
    } catch (error) {
      promise = Promise.reject(error);
    }
    return observeResumeActivity(promise);
  };

  // Thin bounded-retry / validation-gate combinators. Sugar over the for-loop +
  // agent() pattern, but each attempt is a real agent() call so it auto-journals
  // under a stable callSeq (resume-safe). No backoff: there is no timer in the vm
  // and a delay has no resume value. NOTE: attempt N+1's call hash depends on N's
  // live result, so a retry/gate chain cache-miss-cascades on resume (correct).
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i);
      if (!opts.until || opts.until(last)) return last;
    }
    return last; // attempts exhausted — return the last result (caller inspects it)
  };
  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<unknown> | unknown,
    opts: { attempts?: number } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let feedback: string | undefined;
    let last: unknown;
    let lastVerdict: unknown = null;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(feedback, i);
      lastVerdict = await validator(last);
      const accepted =
        typeof lastVerdict === "boolean"
          ? lastVerdict
          : Boolean((lastVerdict as { ok?: unknown } | null)?.ok);
      if (accepted) return { ok: true, value: last, verdict: lastVerdict ?? null, attempts: i + 1 };
      feedback =
        typeof lastVerdict === "boolean"
          ? undefined
          : (lastVerdict as { feedback?: string } | null)?.feedback; // fed into the next attempt
    }
    return { ok: false, value: last, verdict: lastVerdict ?? null, attempts };
  };

  // What a checkpoint() call needs from this run.
  const checkpointRun: CheckpointRun = {
    runId,
    signal,
    pauseSignal,
    shared,
    gates: { throwIfAborted, throwIfHalted, pauseRequested, pauseError, checkAgentLimit, interruptIfHalting },
    host: options,
    resuming: resumePlan !== undefined,
    phase: () => state.currentPhase,
    realmObjectPrototype: () => realmObjectPrototype,
    vmFilename,
    preludeLines,
    taken: (checkpointTaken) => {
      state.checkpointsTaken.push(checkpointTaken);
      guardTerminal("onCheckpointTaken", () => options.onCheckpointTaken?.(checkpointTaken));
    },
  };
  const askCheckpoint = (promptText: string, checkpointOptions: CheckpointOptions, purpose: CheckpointCallContext["purpose"]): Promise<unknown> =>
    startCall((open) => checkpointCall(checkpointRun, promptText, checkpointOptions, open, purpose));
  // The script's checkpoint() takes two arguments, so it never marks a question a breakpoint.
  const checkpoint = (promptText: string, checkpointOptions: CheckpointOptions = {}): Promise<unknown> =>
    askCheckpoint(promptText, checkpointOptions, undefined);
  const breakpointCheckpoint = (promptText: string, checkpointOptions: CheckpointOptions = {}): Promise<unknown> =>
    askCheckpoint(promptText, checkpointOptions, "breakpoint");

  // Adopt every engine-returned promise into the SCRIPT's realm at the context boundary.
  // This is what makes the rejection tripwire's realm-identity attribution complete: the
  // script can only float (a) promises it created itself — natively realm-owned — or
  // (b) promises these globals returned, plus .then() chains off either — realm-owned via
  // this adoption (species lookup follows the receiver's realm constructor). Bonus: inside
  // the script, `agent(...) instanceof Promise` is now true (host promises weren't).
  // `realmPromiseCtor` is assigned right after createContext(), before any script runs.
  let realmPromiseCtor: PromiseConstructor | undefined;
  const tracked = <F extends (...args: never[]) => unknown>(fn: F): F =>
    ((...args: never[]) => {
      const out = fn(...args);
      return out instanceof Promise && realmPromiseCtor ? realmPromiseCtor.resolve(out) : out;
    }) as F;

  // Code steps, questions, breakpoints and choose(), built on agent() and checkpoint().
  const sous = createSousGlobals({
    agent: agent as (prompt: string, options?: Record<string, unknown>) => Promise<unknown>,
    code,
    checkpoint: checkpoint as (prompt: string, options?: Record<string, unknown>) => Promise<unknown>,
    breakpointCheckpoint: breakpointCheckpoint as (prompt: string, options?: Record<string, unknown>) => Promise<unknown>,
    workflow: workflowFn,
    log,
    listSavedWorkflows: options.listSavedWorkflows,
    stepOverrides: options.stepOverrides,
  });

  const context = vm.createContext({
    agent: tracked(sous.agent),
    sh: tracked(sous.sh),
    js: tracked(sous.js),
    py: tracked(sous.py),
    run: tracked(sous.run),
    waitUntil: tracked(sous.waitUntil),
    ask: tracked(sous.ask),
    breakpoint: tracked(sous.breakpoint),
    choose: tracked(sous.choose),
    parallel: tracked(parallel),
    pipeline: tracked(pipeline),
    workflow: tracked(workflowFn),
    retry: tracked(retry),
    gate: tracked(gate),
    checkpoint: tracked(checkpoint),
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });

  realmPromiseCtor = new vm.Script("Promise").runInContext(context) as PromiseConstructor;
  realmObjectPrototype = new vm.Script("Object.prototype").runInContext(context) as object;
  const tripwire = registerRunTripwire({
    realmPromise: realmPromiseCtor,
    // Cancel in-flight agents so a zombie script (still unwinding after the run already
    // failed with SCRIPT_ERROR) stops spending tokens. This is the FAULT channel, not the
    // caller's abort — the manager still classifies the run by the error it receives.
    onTrip: () => faults.abort(),
  });

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  let result: unknown;
  let scriptFailed = false;
  try {
    const scriptPromise = new vm.Script(wrapped, { filename: vmFilename }).runInContext(context) as Promise<unknown>;
    // If the tripwire fires while the script is still running, the run fails NOW with
    // SCRIPT_ERROR; the losing scriptPromise keeps its race handlers, so its own eventual
    // rejection (e.g. WORKFLOW_ABORTED from the fault-channel cancel) never floats.
    result = await Promise.race([scriptPromise, tripwire.tripped]);
    await tripwire.drain();
    if (shared.pendingCheckpoint) throw shared.pendingCheckpoint;
    if (shared.pendingPause) throw shared.pendingPause;
  } catch (error) {
    scriptFailed = true;
    if (shared.pendingPause && !signal.aborted) {
      // A pause unwind: let every executing call finish and journal before settling. Late floats
      // from the already-unwound script are swallowed rather than tripping a second failure.
      tripwire.retire();
      await drainLiveCalls();
      throw shared.pendingPause;
    }
    // A WorkflowError crossing the script boundary keeps its classification (abort,
    // usage limit, tripwire). Anything else IS the script crashing — label it SCRIPT_ERROR,
    // never WORKFLOW_ABORTED (nobody cancelled anything).
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(errorMessage(error), WorkflowErrorCode.SCRIPT_ERROR, { recoverable: false });
  } finally {
    if (ledger.unsettled() > 0 && !signal.aborted) {
      if (scriptFailed) faults.abort();
      else interruptUnsettledCalls();
    }
    tripwire.retire();
  }

  // Persist logs
  const logFile = logger.persist();
  if (logFile) {
    log(`Logs persisted to ${logFile}`);
  }

  // Emit final token usage
  options.onTokenUsage?.(shared.tokenUsage, callbackContext);

  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: shared.agentOccurrenceCount ?? 0,
    durationMs: Date.now() - started,
    runId,
    tokenUsage: shared.tokenUsage,
    agentSessions: state.agentSessions,
    ...(state.fallbacks.length === 0 ? {} : { fallbacks: state.fallbacks }),
    ...(state.checkpointsTaken.length === 0 ? {} : { checkpointsTaken: state.checkpointsTaken }),
    calls: Object.freeze([...state.calls]) as WorkflowCallRecord[],
    callsAllocated: state.callSeq,
    ...(resumePlan
      ? { resumeReport: buildResumeReport(resumePlan, decisionLog.decisions()) }
      : {}),
    effectiveLimits,
    ...(abortSignaled ? { abortSignaled: true as const } : {}),
    ...(nestedWorkflows ? { nestedWorkflows: true as const } : {}),
  };
}

function sameFallback(left: WorkflowRunFallback, right: WorkflowRunFallback): boolean {
  return (
    left.callIndex === right.callIndex &&
    ((left.continuation?.outcome === "reattached" &&
      right.continuation?.outcome === "reattached" &&
      left.continuation.method === right.continuation.method) ||
      (left.continuation?.outcome === "skipped" &&
        right.continuation?.outcome === "skipped" &&
        left.continuation.reason === right.continuation.reason))
  );
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function copyTokenUsageBaseline(
  value: Readonly<SharedRuntime["tokenUsage"]> | undefined,
): SharedRuntime["tokenUsage"] {
  if (value === undefined) {
    return { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const fields = ["input", "output", "total", "cost", "cacheRead", "cacheWrite"] as const;
  for (const field of fields) {
    if (!Number.isFinite(value[field]) || value[field] < 0) {
      throw new WorkflowError(
        `tokenUsageBaseline.${field} must be a finite non-negative number`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
  }
  return { ...value };
}

function hashCallInputs(inputs: {
  cwd: unknown;
  isolation: unknown;
  keepSession: unknown;
  images: unknown;
  mcpServers: unknown;
  meta: unknown;
  promptMeta: unknown;
  label: unknown;
  backends: unknown;
}): string | undefined {
  return hashCanonicalStrictJson(inputs);
}

function validateAgentOptions(
  options: AgentOptions,
  realmObjectPrototype: object | undefined,
): void {
  try {
    // The public bridge supplies script-realm objects while engine-owned helpers and
    // the omitted-options default use host-realm objects. Accept exactly those plain
    // prototypes (plus null), so inherited foreign option dialects cannot be ignored.
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("not an object");
    }
    const prototype = Reflect.getPrototypeOf(options);
    if (prototype !== null && prototype !== Object.prototype && prototype !== realmObjectPrototype) {
      throw new Error("wrong prototype");
    }
    const labelDescriptor = Reflect.getOwnPropertyDescriptor(options, "label");
    const label = labelDescriptor && "value" in labelDescriptor && typeof labelDescriptor.value === "string"
      ? labelDescriptor.value.trim()
      : "";
    for (const [key, message] of REMOVED_AGENT_OPTIONS) {
      if (Reflect.getOwnPropertyDescriptor(options, key) === undefined) continue;
      throw new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
        ...(label ? { agentLabel: label } : {}),
      });
    }
    const unknown = Reflect.ownKeys(options).filter(
      (key): boolean => typeof key !== "string" || !AGENT_OPTION_KEY_SET.has(key),
    );
    if (unknown.length === 0) return;
    const rendered = unknown.map((key) => typeof key === "symbol" ? key.toString() : JSON.stringify(key)).join(", ");
    throw new WorkflowError(
      `agent${label ? ` ${JSON.stringify(label)}` : ""} options contain unknown ${unknown.length === 1 ? "key" : "keys"} ${rendered}; ` +
        `valid keys: ${AGENT_OPTION_KEYS.join(", ")}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false, ...(label ? { agentLabel: label } : {}) },
    );
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(
      "agent options must be a plain object with only documented keys",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
}

/** The route of a code step, or of a step whose runner has no route() of its own. It has no agent. */
function unroutedStep(ask: StepAsk): StepRoute {
  const requested = ask.model ?? ask.runModel;
  return {
    ...(requested === undefined ? {} : { requested }),
    agentKey: null,
    ...(ask.isolation === undefined ? {} : { isolation: ask.isolation }),
  };
}

/** A step's time limit in milliseconds, from "90s", "10m" or a number of seconds. */
function millis(value: number | string | undefined): number | undefined {
  const seconds = parseDurationSeconds(value);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

function hashAgentCall(
  prompt: string,
  model: string | undefined,
  mode: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  agentDefKey: string | null,
): string {
  const configOptions = sortedConfigOptions(options.configOptions);
  const identity = JSON.stringify({
    prompt,
    model: model ?? null,
    // Included only when SET: a mode changes agent behavior (must invalidate resume),
    // but journals written before modes existed must keep replaying for mode-less
    // calls — an unconditional `mode: null` key would cache-miss every old journal.
    ...(mode !== undefined ? { mode } : {}),
    ...(configOptions ? { configOptions } : {}),
    // tier is gone, and a step that sets it is refused. The key stays, always null, so every
    // call keeps the hash it had.
    tier: null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    // Resolved definition (tools/model/prompt) so editing an agent .md invalidates
    // this call's cached result on a later resume.
    agentDef: agentDefKey,
    schema: options.schema ?? null,
    // Included only when set, so older journals keep replaying.
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.skills !== undefined ? { skills: options.skills } : {}),
  });
  return createHash("sha256").update(identity).digest("hex");
}

function sortedConfigOptions(
  configOptions: Record<string, string | boolean> | undefined,
): Record<string, string | boolean> | undefined {
  if (!configOptions || Object.keys(configOptions).length === 0) return undefined;
  const ids = Object.keys(configOptions).sort();
  const sorted = Object.fromEntries(ids.map((id) => [id, configOptions[id]]));
  // JSON.stringify normally hoists integer-like object keys into numeric order. Option ids
  // are unrestricted strings, so expose the already-sorted key list through [[OwnPropertyKeys]]
  // and keep the contract lexicographic for ids such as "10" and "2" as well.
  return new Proxy(sorted, { ownKeys: () => ids });
}

function assertNoModelConfigOption(
  configOptions: Record<string, string | boolean> | undefined,
  label: string,
): void {
  if (!configOptions || !("model" in configOptions)) return;
  throw new WorkflowError(
    `agent "${label}": configOptions option "model" with authored value ${JSON.stringify(configOptions.model)} is reserved; use the model field instead`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false, agentLabel: label },
  );
}

function hasModelConfigOption(configOptions: Record<string, string | boolean> | undefined): boolean {
  return Boolean(configOptions && "model" in configOptions);
}

function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions,
  agentPrompt: string | undefined,
  resolvedIsolation?: "worktree",
): string | undefined {
  const lines: string[] = [];
  // A found agent gives its own prompt, the route's. Only fall back to the prose hint when the
  // agentType named no known agent.
  if (agentPrompt) lines.push(agentPrompt);
  else if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (phase) lines.push(`Workflow phase: ${phase}`);
  // Use resolvedIsolation so the annotation fires whether isolation came from
  // the call site or from the agentDef's isolation field.
  if (resolvedIsolation) lines.push(`Requested isolation: ${resolvedIsolation}`);
  // Note: options.model is applied for real via the session, not injected as prose.
  return lines.length ? lines.join("\n\n") : undefined;
}

function isEmptyTextAgentResult(result: unknown, hasSchema: boolean | undefined): boolean {
  return hasSchema !== true && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

function copyValidUsage(value: AgentUsage): AgentUsage | undefined {
  try {
    const copy: AgentUsage = {
      input: value.input,
      output: value.output,
      cacheRead: value.cacheRead,
      cacheWrite: value.cacheWrite,
      total: value.total,
      cost: value.cost,
    };
    return Object.values(copy).every((field) => Number.isFinite(field) && field >= 0)
      ? deepFreeze(copy)
      : undefined;
  } catch {
    return undefined;
  }
}

function sumUsage(values: AgentUsage[]): AgentUsage | undefined {
  if (values.length === 0) return undefined;
  return deepFreeze(
    values.reduce<AgentUsage>(
      (sum, usage) => ({
        input: sum.input + usage.input,
        output: sum.output + usage.output,
        cacheRead: sum.cacheRead + usage.cacheRead,
        cacheWrite: sum.cacheWrite + usage.cacheWrite,
        total: sum.total + usage.total,
        cost: sum.cost + usage.cost,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
    ),
  );
}

function bestEffortDebug(message: string): void {
  try {
    console.debug(`[engine] ${message}`);
  } catch {
    // Debug reporting never changes execution.
  }
}

function agentCancellationReason(signal: AbortSignal): WorkflowError | undefined {
  if (!signal.aborted) return undefined;
  const reason = signal.reason;
  return reason instanceof WorkflowError && reason.code === WorkflowErrorCode.AGENT_CANCELLED
    ? reason
    : undefined;
}

/** Settle a selected attempt even when its runner ignores the abort signal. */
async function withAgentCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const alreadyCancelled = agentCancellationReason(signal);
  if (alreadyCancelled) throw alreadyCancelled;

  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason = agentCancellationReason(signal);
      if (reason) reject(reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

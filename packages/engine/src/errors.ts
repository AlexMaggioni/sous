/**
 * The engine's errors. WorkflowError, its codes and its guards are the contract: the steps
 * module throws them and the engine reads .code and .recoverable.
 *
 * wrapError, errorMessage and isAbortError are the engine's own classification and
 * formatting of the failures it sees when it runs a step or the workflow code.
 */

export enum WorkflowErrorCode {
  /** A host cancelled one in-flight agent call without aborting the owning workflow run. */
  AGENT_CANCELLED = "AGENT_CANCELLED",
  WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
  AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
  /** Provider subscription/usage/quota/rate limit. Non-recoverable => engine PAUSES (resumable), not failed. */
  PROVIDER_USAGE_LIMIT = "PROVIDER_USAGE_LIMIT",
  /** The agent requires authentication. Non-recoverable: retrying cannot succeed until the host
   *  completes an auth flow. The machine-readable surface is `WorkflowError.authContext`
   *  (`AuthErrorContext`: advertised method ids/types/names + backendId) — hosts read that, never
   *  the human message. The enriched `.message` is retained for readability only. */
  AUTH_REQUIRED = "AUTH_REQUIRED",
  /** A durable checkpoint needs a human reply. The manager pauses the run and persists the
   *  non-secret `checkpointContext` so a host can collect and journal the decision on resume. */
  CHECKPOINT_REQUIRED = "CHECKPOINT_REQUIRED",
  /** A host requested a pause. Agent calls already executing finish and journal, nothing new is
   *  admitted, and the run settles as paused with `reason: "requested"`. Non-recoverable: resume
   *  the same journal. Catching it inside the script cannot keep the run going. */
  PAUSE_REQUESTED = "PAUSE_REQUESTED",
  SCRIPT_VALIDATION_ERROR = "SCRIPT_VALIDATION_ERROR",
  /** A step asks for something that cannot run: a removed harness, an unknown agent type or
   *  MCP server, a program that is missing, or an unknown code step kind. Non-recoverable: the
   *  same step fails the same way. A bad option in the script stays SCRIPT_VALIDATION_ERROR. */
  INVALID_ARGUMENT = "INVALID_ARGUMENT",
  /** The workflow SCRIPT crashed at runtime: an uncaught throw or an unhandled promise
   *  rejection inside the script body. Distinct from WORKFLOW_ABORTED (someone cancelled the
   *  run) and SCRIPT_VALIDATION_ERROR (invalid syntax or agent configuration). Non-recoverable: rerunning
   *  the same deterministic script crashes the same way. */
  SCRIPT_ERROR = "SCRIPT_ERROR",
  /** A schema agent never produced valid structured output (after repair + extraction). Non-recoverable. */
  SCHEMA_NONCOMPLIANCE = "SCHEMA_NONCOMPLIANCE",
  /** A non-schema agent completed with no assistant text. Recoverable. */
  AGENT_EMPTY_OUTPUT = "AGENT_EMPTY_OUTPUT",
  AGENT_EXECUTION_ERROR = "AGENT_EXECUTION_ERROR",
  PERSISTENCE_ERROR = "PERSISTENCE_ERROR",
  UNKNOWN = "UNKNOWN",
}

/**
 * The machine-readable auth surface carried on an `AUTH_REQUIRED` `WorkflowError`. Sources ONLY
 * agent-advertised `AuthMethod` fields (ids/types/names) and the backend id — never our sent
 * `_meta`, env values, or any credential material (Principle 9). Every downstream host (engine
 * pause path, MCP `auth_required` summary, SDK `isAuthRequired` helper) reads this structurally
 * rather than parsing the enriched human message.
 */
export type AuthErrorContext = {
  backendId?: string;
  /** The login methods the program named. The steps module names none, so a new run holds an
   *  empty list. A run file written before may hold some. */
  methods: { id: string; type: "agent" | "terminal"; name?: string }[];
};

/** Machine-readable provider-limit metadata carried by a `PROVIDER_USAGE_LIMIT` error.
 *  `resetAt` is an RFC 3339 instant derived from provider-owned numeric metadata, never prose. */
export interface ProviderUsageLimitContext {
  backendId: string;
  source: "provider" | "adapter_fallback";
  providerCode?: string;
  resetAt?: string;
}

/**
 * The structured, NON-SECRET surface of a pending durable checkpoint — persisted with a paused
 * run and shown to the host so it can collect a decision; `hash`/`callIndex` let resume inject
 * the reply as a journal entry.
 */
export interface CheckpointContext {
  callIndex: number;
  hash: string;
  prompt: string;
  kind: "confirm" | "input" | "select";
  choices?: string[];
  /** Optional host deadline for a pending checkpoint interaction. */
  timeoutMs?: number;
}

/** Strict-JSON projection of a thrown value recorded in a run's call manifest. */
export interface WorkflowRecordedError {
  /** "workflow-error" — instanceof WorkflowError; "error" — any other Error;
   *  "value" — a non-Error thrown value. */
  form: "workflow-error" | "error" | "value";
  /** Form "error": the error's name (guarded read). */
  name?: string;
  /** REQUIRED for forms "workflow-error" and "error". A guarded read that fails or
   *  yields a non-string sets lossy instead of omitting silently. */
  message?: string;
  /** Form "workflow-error": every public WorkflowError field. */
  code?: WorkflowErrorCode;
  recoverable?: boolean;
  agentLabel?: string;
  /** Strict-JSON projected. */
  details?: unknown;
  resetHint?: string;
  providerUsageLimitContext?: ProviderUsageLimitContext;
  authContext?: AuthErrorContext;
  checkpointContext?: CheckpointContext;
  /** Form "error": JSON-safe own enumerable data properties of the Error. */
  props?: Record<string, unknown>;
  /** Form "value": the thrown value, strict-JSON projected. */
  value?: unknown;
  /** True when any consumed part failed strict-JSON projection or a property read
   *  threw. Lossy rows make a recording unusable as a baseline. */
  lossy?: boolean;
}

export interface WorkflowErrorOptions {
  recoverable?: boolean;
  agentLabel?: string;
  details?: unknown;
  /** For PROVIDER_USAGE_LIMIT: a human hint synthesized from structured reset metadata. */
  resetHint?: string;
  /** For PROVIDER_USAGE_LIMIT: backend/code plus a provider-derived reset instant when available. */
  providerUsageLimitContext?: ProviderUsageLimitContext;
  /** For AUTH_REQUIRED: the structured, non-secret auth surface (advertised method ids/types/names). */
  authContext?: AuthErrorContext;
  /** For CHECKPOINT_REQUIRED: the structured, non-secret pending checkpoint surface. */
  checkpointContext?: CheckpointContext;
}

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly recoverable: boolean;
  readonly agentLabel?: string;
  readonly details?: unknown;
  readonly resetHint?: string;
  readonly providerUsageLimitContext?: ProviderUsageLimitContext;
  readonly authContext?: AuthErrorContext;
  readonly checkpointContext?: CheckpointContext;

  constructor(message: string, code: WorkflowErrorCode, options: WorkflowErrorOptions = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.agentLabel = options.agentLabel;
    this.details = options.details;
    this.resetHint = options.resetHint;
    this.providerUsageLimitContext = options.providerUsageLimitContext;
    this.authContext = options.authContext;
    this.checkpointContext = options.checkpointContext;
  }
}

export function isWorkflowError(error: unknown): error is WorkflowError {
  return error instanceof WorkflowError;
}

export function isProviderUsageLimit(error: unknown): error is WorkflowError {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
}

export function isAuthRequired(error: unknown): error is WorkflowError {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.AUTH_REQUIRED;
}

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return readName(error) === "AbortError";
}

/**
 * Wrap an unknown error into a WorkflowError with appropriate classification.
 */
export function wrapError(error: unknown, context?: { agentLabel?: string }): WorkflowError {
  if (error instanceof WorkflowError) return error;

  if (isAbortError(error)) {
    return new WorkflowError(
      errorMessage(error),
      WorkflowErrorCode.WORKFLOW_ABORTED,
      { recoverable: true },
    );
  }

  return new WorkflowError(
    errorMessage(error),
    WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    { recoverable: true, agentLabel: context?.agentLabel, details: error },
  );
}

/**
 * Best-effort text for arbitrary thrown values. All property/stringification reads are
 * guarded because workflow code can throw exotic objects (throwing getters, circular
 * structures, hostile toString) and containment must not leak leases or rejections.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = readMessage(error);
    if (message) return message;
  }
  if (error && typeof error === "object") {
    const message = readMessage(error);
    if (message) return message;
    try {
      const json = JSON.stringify(error);
      if (json) return json;
    } catch {
      // Fall through to String() for cyclic objects or exotic throwables.
    }
  }
  try {
    return String(error);
  } catch {
    return "Unknown thrown value";
  }
}

function readMessage(error: object): string | undefined {
  try {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  } catch {
    // Fall back to JSON/String formatting for objects with hostile message getters.
  }
  return undefined;
}

function readName(error: object): string | undefined {
  try {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  } catch {
    // A hostile name getter should not escape timeout classification.
  }
  return undefined;
}

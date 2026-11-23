import {
  closeSync,
  openSync,
  readFileSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  RUN_EVENT_LOG_VERSION,
  isRequestedPauseReason,
  type PersistableEngineRunEvent,
  type RunEventLogRecord,
} from "../../run-events.js";
import { WorkflowError, WorkflowErrorCode } from "../../errors.js";
import { MAX_OBSERVABILITY_SCALAR_BYTES, projectRunEventForPersistence } from "../../run-observability.js";
import type { FsLayer, PersistedRunState, RunLease, RunPersistence } from "./run-persistence.js";

export const RUN_EVENT_MAX_RECORD_BYTES = 65_536;
export const RUN_EVENT_READ_LIMIT_DEFAULT = 100 as const;
export const RUN_EVENT_READ_LIMIT_MAX = 1_000 as const;

const STREAM_ID_PATTERN = /^[0-9a-f]{32}$/;
const RUN_EVENT_WRAPPER = Symbol("orchestrator.runEventPersistence");
// Soft cap on distinct runs held in the read cache. Writer-owned caches are released with their run
// lease and are never evicted; this bounds only the read-seeded caches a long-lived daemon accrues
// by reading many foreign/terminal runs, evicting least-recently-used ones first.
const MAX_CACHED_RUNS = 512;
const EVENT_TYPES = new Set([
  "log",
  "phase",
  "agentStart",
  "agentEnd",
  "tokenUsage",
  "complete",
  "journal",
  "callRecord",
  "paused",
  "error",
  "stopped",
  "resumed",
]);
// Retired errors stay readable in old event logs: the execution budget's, and the isolation
// runs'. No run makes them now, and the error enum leaves them out.
const WORKFLOW_ERROR_CODES = new Set<string>([
  ...Object.values(WorkflowErrorCode),
  "AGENT_TIMEOUT",
  "AGENT_IDLE_TIMEOUT",
  "RECORDING_UNUSABLE",
  "REPLAY_TARGET_INVALID",
]);
const CONTINUATION_SKIP_REASONS = new Set([
  "hash-mismatch",
  "inputs-mismatch",
  "worktree-isolated",
  "cwd-mismatch",
  "cwd-missing",
  "backend-mismatch",
  "capability-missing",
  "reattach-failed",
  "runner-declined",
]);

export interface ReadRunEventsOptions {
  /** Greatest seq already consumed. Default 0. */
  after?: number;
  /** Maximum records returned. Default 100; valid range 1..1000. */
  limit?: number;
  /** Expected generation from a snapshot or prior read. */
  streamId?: string;
}

export interface ReadRunEventsResult {
  events: RunEventLogRecord[];
  streamId: string;
  cursor: number;
  endCursor: number;
  hasMore: boolean;
}

export type RunEventLogErrorCode =
  | "RUN_NOT_FOUND"
  | "EVENT_LOG_UNAVAILABLE"
  | "INVALID_CURSOR"
  | "INVALID_LIMIT"
  | "INVALID_STREAM_ID"
  | "CURSOR_AHEAD"
  | "ORPHANED_LOG"
  | "WATERMARK_MISSING"
  | "STREAM_ID_MISSING"
  | "STREAM_MISMATCH"
  | "CORRUPT_LOG"
  | "UNSUPPORTED_VERSION"
  | "SNAPSHOT_AHEAD"
  | "EVENT_LOG_INCOMPLETE"
  | "SEQUENCE_MISMATCH"
  | "PROJECTION_ERROR"
  | "RECORD_TOO_LARGE"
  | "IO_ERROR";

export class RunEventLogError extends Error {
  override readonly name = "RunEventLogError" as const;
  readonly code: RunEventLogErrorCode;
  readonly runId: string;
  readonly seq?: number;
  readonly path?: string;

  constructor(
    message: string,
    code: RunEventLogErrorCode,
    options: { runId: string; seq?: number; path?: string; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.runId = options.runId;
    this.seq = options.seq;
    this.path = options.path;
  }
}

export interface AppendRunEventInput {
  seq: number;
  timestamp: string;
  /** Full-fidelity live event; appendEvent always applies the persistence projection. */
  event: PersistableEngineRunEvent;
}

export interface RunEventPersistence extends RunPersistence {
  appendEvent(runId: string, input: AppendRunEventInput): RunEventLogRecord;
  readEvents(runId: string, options?: ReadRunEventsOptions): ReadRunEventsResult;
}

interface ResolvedEventFs {
  readFileSync: typeof readFileSync;
  unlinkSync: typeof unlinkSync;
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  closeSync: typeof closeSync;
  truncateSync: typeof truncateSync;
}

interface ParsedSuffix {
  records: RunEventLogRecord[];
  completeBytes: number;
}

/**
 * FNV-1a fingerprint of a validated record prefix, kept as two independent 32-bit lanes
 * (folded with Math.imul) so it can be advanced incrementally on append and recomputed cheaply
 * on read. Its only job is to detect that the on-disk prefix still matches what we validated
 * — accidental corruption / an external rewrite, never an adversary — so 64 combined bits are
 * ample, and folding lets appendEvent update it in O(bytes-written) instead of O(journal).
 */
interface PrefixHash {
  h1: number;
  h2: number;
}

const FNV_OFFSET_1 = 0x811c9dc5 | 0;
const FNV_OFFSET_2 = 0x9dc5811c | 0;
const FNV_PRIME_1 = 0x01000193;
const FNV_PRIME_2 = 0x01000197;

function newPrefixHash(): PrefixHash {
  return { h1: FNV_OFFSET_1, h2: FNV_OFFSET_2 };
}

function foldPrefixHash(hash: PrefixHash, bytes: Buffer, start: number, end: number): void {
  let h1 = hash.h1;
  let h2 = hash.h2;
  for (let i = start; i < end; i++) {
    const byte = bytes[i]!;
    h1 = Math.imul(h1 ^ byte, FNV_PRIME_1);
    h2 = Math.imul(h2 ^ byte, FNV_PRIME_2);
  }
  hash.h1 = h1 | 0;
  hash.h2 = h2 | 0;
}

function prefixHashOf(bytes: Buffer, end: number): PrefixHash {
  const hash = newPrefixHash();
  foldPrefixHash(hash, bytes, 0, end);
  return hash;
}

function prefixHashEquals(left: PrefixHash, right: PrefixHash): boolean {
  return left.h1 === right.h1 && left.h2 === right.h2;
}

/**
 * Per-run, in-memory validated view of the event log, keyed by runId inside one
 * RunEventPersistence wrapper. The daemon is the journal's writer, so appendEvent maintains
 * this view directly and readEvents serves from it — parsing only the never-before
 * -seen suffix — instead of re-parsing the whole file for every read and every record yielded.
 */
interface RunEventCache {
  streamId: string;
  /** Fully validated records in dense seq order (`records[i].seq === i + 1`). */
  records: RunEventLogRecord[];
  /** Byte length of the complete-record prefix `records` covers. */
  completeBytes: number;
  /** FNV fingerprint of bytes `[0, completeBytes)`; folded on append, recomputed on read to verify. */
  prefixHash: PrefixHash;
  /** This process has repaired the torn tail and owns the writer epoch for this run. */
  writerRepaired: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function hasRequired(value: Record<string, unknown>, key: string, predicate: (candidate: unknown) => boolean): boolean {
  return hasOwn(value, key) && predicate(value[key]);
}

function hasOptional(value: Record<string, unknown>, key: string, predicate: (candidate: unknown) => boolean): boolean {
  return !hasOwn(value, key) || value[key] === undefined || predicate(value[key]);
}

function hasNone(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => !hasOwn(value, key));
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isProjectedText(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_OBSERVABILITY_SCALAR_BYTES;
}

function isProjectionValue(value: unknown): boolean {
  return (
    isObject(value) &&
    hasRequired(value, "preview", isProjectedText) &&
    hasRequired(value, "redacted", isBoolean) &&
    hasRequired(value, "truncated", isBoolean)
  );
}

function isAgentUsage(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    hasRequired(value, "input", isNonNegativeSafeInteger) &&
    hasRequired(value, "output", isNonNegativeSafeInteger) &&
    hasRequired(value, "cacheRead", isNonNegativeSafeInteger) &&
    hasRequired(value, "cacheWrite", isNonNegativeSafeInteger) &&
    hasRequired(value, "total", isNonNegativeSafeInteger) &&
    hasRequired(value, "cost", isNonNegativeFinite)
  );
}

function isTokenUsage(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    hasRequired(value, "input", isNonNegativeSafeInteger) &&
    hasRequired(value, "output", isNonNegativeSafeInteger) &&
    hasRequired(value, "total", isNonNegativeSafeInteger) &&
    hasRequired(value, "cost", isNonNegativeFinite) &&
    hasOptional(value, "cacheRead", isNonNegativeSafeInteger) &&
    hasOptional(value, "cacheWrite", isNonNegativeSafeInteger)
  );
}

function isContinuationAttempt(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.reattached === true) return value.method === "resume" || value.method === "load";
  return value.reattached === false &&
    typeof value.reason === "string" &&
    CONTINUATION_SKIP_REASONS.has(value.reason);
}

function isContinuationMarker(value: unknown): boolean {
  return isObject(value) && (value.method === "resume" || value.method === "load");
}

function isProvenance(value: unknown, projected: boolean): boolean {
  if (!isObject(value)) return false;
  const text = projected ? isProjectedText : isString;
  if (value.source === "live") {
    return hasOptional(value, "overrideModel", text) &&
      hasOptional(value, "continuation", isContinuationAttempt);
  }
  if (value.source !== "replay") return false;
  return (
    hasOptional(value, "recordedRunId", text) &&
    hasOptional(value, "recordedIndex", isNonNegativeSafeInteger) &&
    hasOptional(value, "hashMatched", isBoolean)
  );
}

function isAuthContext(value: unknown, projected: boolean): boolean {
  if (!isObject(value) || !Array.isArray(value.methods) || (projected && value.methods.length > 20)) return false;
  const text = projected ? isProjectedText : isString;
  if (!hasOptional(value, "backendId", text)) return false;
  return value.methods.every(
    (method) =>
      isObject(method) &&
      hasRequired(method, "id", text) &&
      (method.type === "agent" || method.type === "terminal") &&
      hasOptional(method, "name", text),
  );
}

function isCheckpointContext(value: unknown, projected: boolean): boolean {
  if (!isObject(value)) return false;
  const text = projected ? isProjectedText : isString;
  if (
    !hasRequired(value, "callIndex", isNonNegativeSafeInteger) ||
    !hasRequired(value, "hash", isString) ||
    !hasRequired(value, "prompt", text) ||
    !(value.kind === "confirm" || value.kind === "input" || value.kind === "select")
  ) {
    return false;
  }
  if (hasOwn(value, "choices") && value.choices !== undefined) {
    if (!Array.isArray(value.choices) || (projected && value.choices.length > 20) || !value.choices.every(text)) return false;
  }
  if (!hasOptional(value, "timeoutMs", isNonNegativeFinite)) return false;
  return !projected || !hasOwn(value, "default") || value.default === undefined || isProjectionValue(value.default);
}

function isProviderUsageContext(value: unknown, projected: boolean): boolean {
  if (!isObject(value)) return false;
  const text = projected ? isProjectedText : isString;
  return (
    hasRequired(value, "backendId", text) &&
    (value.source === "provider" || value.source === "adapter_fallback") &&
    hasOptional(value, "providerCode", text) &&
    hasOptional(value, "resetAt", text)
  );
}

function isRecordedError(value: unknown, projected: boolean): boolean {
  if (!isObject(value) || !(value.form === "workflow-error" || value.form === "error" || value.form === "value")) {
    return false;
  }
  const text = projected ? isProjectedText : isString;
  if (
    !hasOptional(value, "name", text) ||
    !hasOptional(value, "message", text) ||
    !hasOptional(value, "code", (candidate) => typeof candidate === "string" && WORKFLOW_ERROR_CODES.has(candidate as WorkflowErrorCode)) ||
    !hasOptional(value, "recoverable", isBoolean) ||
    !hasOptional(value, "agentLabel", text) ||
    !hasOptional(value, "resetHint", text) ||
    !hasOptional(value, "providerUsageLimitContext", (candidate) => isProviderUsageContext(candidate, projected)) ||
    !hasOptional(value, "authContext", (candidate) => isAuthContext(candidate, projected)) ||
    !hasOptional(value, "checkpointContext", (candidate) => isCheckpointContext(candidate, projected)) ||
    !hasOptional(value, "lossy", isBoolean)
  ) {
    return false;
  }
  if ((value.form === "workflow-error" || value.form === "error") && !hasRequired(value, "message", text)) return false;
  if (projected) {
    return (
      hasOptional(value, "details", isProjectionValue) &&
      hasOptional(value, "props", isProjectionValue) &&
      hasOptional(value, "value", isProjectionValue)
    );
  }
  return hasOptional(value, "props", isObject);
}

function isJournalCall(value: unknown, projected: boolean): boolean {
  if (!isObject(value)) return false;
  const text = projected ? isProjectedText : isString;
  if (value.kind === "agent") {
    return (
      hasRequired(value, "label", text) &&
      hasOptional(value, "phase", text) &&
      hasOptional(value, "model", text) &&
      hasOptional(value, "backendId", text) &&
      hasOptional(value, "continuation", isContinuationMarker)
    );
  }
  return value.kind === "checkpoint" && value.label === "checkpoint" && hasOptional(value, "phase", text);
}

function isSession(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.reopen)) return false;
  return (
    hasRequired(value, "sessionId", isString) &&
    hasRequired(value, "backendId", isString) &&
    hasRequired(value, "cwd", isString) &&
    hasRequired(value.reopen, "load", isBoolean) &&
    hasRequired(value.reopen, "resume", isBoolean) &&
    hasRequired(value.reopen, "list", isBoolean) &&
    hasOptional(value.reopen, "fork", isBoolean) &&
    hasRequired(value, "callIndex", isNonNegativeSafeInteger) &&
    hasRequired(value, "label", isString) &&
    hasOptional(value, "phase", isString) &&
    hasRequired(value, "keptOpen", isBoolean)
  );
}

function isJournalEntry(value: unknown, projected: boolean): boolean {
  if (!isObject(value)) return false;
  const text = projected ? isProjectedText : isString;
  return (
    hasRequired(value, "index", isNonNegativeSafeInteger) &&
    hasRequired(value, "hash", isString) &&
    (!projected || hasRequired(value, "result", isProjectionValue)) &&
    (projected || hasOwn(value, "result")) &&
    hasOptional(value, "session", isSession) &&
    hasOptional(value, "call", (candidate) => isJournalCall(candidate, projected)) &&
    hasOptional(value, "kind", (candidate) => candidate === "agent" || candidate === "checkpoint") &&
    hasOptional(value, "usage", isAgentUsage) &&
    hasOptional(value, "scope", text)
  );
}

function isCallRecord(value: unknown, projected: boolean): boolean {
  // Historical event observation remains readable, including the retired "headless"
  // origin. Execution reuse is separately gated by explicit checkpoint provenance.
  if (!isObject(value)) return false;
  const text = projected ? isProjectedText : isString;
  if (
    !hasRequired(value, "index", isNonNegativeSafeInteger) ||
    !(value.kind === "agent" || value.kind === "checkpoint") ||
    !hasRequired(value, "hash", isString) ||
    !(value.outcome === "result" || value.outcome === "null" || value.outcome === "error") ||
    !(value.origin === "runner" || value.origin === "journal-replay" || value.origin === "confirm" || value.origin === "headless" || value.origin === "engine") ||
    !hasOptional(value, "path", text) ||
    !hasOptional(value, "inputsHash", isString) ||
    !hasOptional(value, "label", text) ||
    !hasOptional(value, "error", (candidate) => isRecordedError(candidate, projected)) ||
    !hasOptional(value, "aborted", isBoolean) ||
    !hasOptional(value, "attempts", isPositiveSafeInteger) ||
    !hasOptional(value, "usage", isAgentUsage) ||
    !hasOptional(value, "modelRequested", text) ||
    !hasOptional(value, "modelResolved", text) ||
    !hasOptional(value, "backendId", text) ||
    !hasOptional(value, "worktree", isBoolean) ||
    !hasOptional(value, "isolation", (candidate) => candidate === "worktree") ||
    !hasOptional(value, "resolvedCwd", text) ||
    !hasOptional(value, "settlementOrdinal", isPositiveSafeInteger) ||
    !hasOptional(value, "provenance", (candidate) => isProvenance(candidate, projected)) ||
    !hasOptional(value, "scope", text)
  ) {
    return false;
  }
  return value.outcome === "result" ? !hasOwn(value, "error") : hasRequired(value, "error", (error) => isRecordedError(error, projected));
}

function isOrigin(value: Record<string, unknown>, projected: boolean): boolean {
  const text = projected ? isProjectedText : isString;
  return hasRequired(value, "runId", text) && hasRequired(value, "scope", text);
}

function isConfigOptions(value: unknown, projected: boolean): boolean {
  if (!isObject(value) || (projected && Object.keys(value).length > 20)) return false;
  return Object.entries(value).every(
    ([key, option]) => (!projected || isProjectedText(key)) && (typeof option === "string" || typeof option === "boolean") && (!projected || typeof option !== "string" || isProjectedText(option)),
  );
}

function isCompleteResult(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.meta)) return false;
  return (
    hasRequired(value, "runId", isString) &&
    value.status === "completed" &&
    hasRequired(value.meta, "name", isString) &&
    hasRequired(value.meta, "description", isString) &&
    hasOwn(value, "result") &&
    Array.isArray(value.phases) &&
    value.phases.every(isString) &&
    hasRequired(value, "agentCount", isNonNegativeSafeInteger) &&
    hasRequired(value, "durationMs", isNonNegativeFinite) &&
    Array.isArray(value.logs) &&
    value.logs.every(isString) &&
    hasOptional(value, "tokenUsage", isTokenUsage) &&
    hasOptional(value, "calls", (candidate) => Array.isArray(candidate) && candidate.every((record) => isCallRecord(record, false)))
  );
}

function isPersistableInputEvent(value: unknown): value is PersistableEngineRunEvent {
  if (!isObject(value) || !isString(value.type) || !EVENT_TYPES.has(value.type) || !isOrigin(value, false)) return false;
  switch (value.type) {
    case "log":
      return hasRequired(value, "message", isString);
    case "phase":
      return hasRequired(value, "title", isString);
    case "agentStart":
      return (
        hasRequired(value, "label", isString) &&
        hasOptional(value, "phase", isString) &&
        hasRequired(value, "prompt", isString) &&
        hasOptional(value, "model", isString) &&
        hasOptional(value, "configOptions", (candidate) => isConfigOptions(candidate, false)) &&
        hasOptional(value, "timeoutMs", (candidate) => candidate === null || isNonNegativeFinite(candidate)) &&
        hasOptional(value, "idleTimeoutMs", (candidate) => candidate === null || isNonNegativeFinite(candidate)) &&
        hasRequired(value, "callIndex", isNonNegativeSafeInteger) &&
        hasOptional(value, "path", isString)
      );
    case "agentEnd":
      return (
        hasRequired(value, "label", isString) &&
        hasOptional(value, "phase", isString) &&
        hasOwn(value, "result") &&
        hasOptional(value, "tokens", isNonNegativeSafeInteger) &&
        hasOptional(value, "worktree", isString) &&
        hasOptional(value, "model", isString) &&
        hasOptional(value, "error", isString) &&
        hasOptional(value, "errorCode", (candidate) => typeof candidate === "string" && WORKFLOW_ERROR_CODES.has(candidate as WorkflowErrorCode)) &&
        hasOptional(value, "recoverable", isBoolean) &&
        hasOptional(value, "session", isSession) &&
        hasRequired(value, "callIndex", isNonNegativeSafeInteger) &&
        hasOptional(value, "usage", isAgentUsage) &&
        hasOptional(value, "modelResolved", isString) &&
        hasOptional(value, "backendId", isString) &&
        hasOptional(value, "provenance", (candidate) => isProvenance(candidate, false)) &&
        hasOptional(value, "errorRecord", (candidate) => isRecordedError(candidate, false))
      );
    case "tokenUsage":
      return hasRequired(value, "usage", isTokenUsage);
    case "complete":
      return hasRequired(value, "result", isCompleteResult);
    case "journal":
      return hasRequired(value, "entry", (candidate) => isJournalEntry(candidate, false));
    case "callRecord":
      return hasRequired(value, "record", (candidate) => isCallRecord(candidate, false));
    case "paused":
      if (!hasOwn(value, "reason")) {
        return hasNone(value, ["error", "errorRecord", "resetHint", "authContext", "checkpointContext"]);
      }
      if (isRequestedPauseReason(value.reason)) {
        return value.error instanceof WorkflowError && hasRequired(value, "errorRecord", (candidate) => isRecordedError(candidate, false)) && hasNone(value, ["resetHint", "authContext", "checkpointContext"]);
      }
      if (value.reason === "usage_limit") {
        return value.error instanceof WorkflowError && hasRequired(value, "errorRecord", (candidate) => isRecordedError(candidate, false)) && hasOptional(value, "resetHint", isString) && hasNone(value, ["authContext", "checkpointContext"]);
      }
      if (value.reason === "auth_required") {
        return value.error instanceof WorkflowError && hasRequired(value, "errorRecord", (candidate) => isRecordedError(candidate, false)) && hasOptional(value, "authContext", (candidate) => isAuthContext(candidate, false)) && hasNone(value, ["resetHint", "checkpointContext"]);
      }
      if (value.reason === "checkpoint_required") {
        return value.error instanceof WorkflowError && hasRequired(value, "errorRecord", (candidate) => isRecordedError(candidate, false)) && hasOptional(value, "checkpointContext", (candidate) => isCheckpointContext(candidate, false)) && hasNone(value, ["resetHint", "authContext"]);
      }
      return false;
    case "error":
      return value.error instanceof WorkflowError && hasRequired(value, "errorRecord", (candidate) => isRecordedError(candidate, false));
    case "stopped":
    case "resumed":
      return true;
    default:
      return false;
  }
}

function isPersistedEvent(value: unknown): boolean {
  if (!isObject(value) || !isString(value.type) || !EVENT_TYPES.has(value.type) || !isOrigin(value, true)) return false;
  switch (value.type) {
    case "log":
      return hasRequired(value, "message", isProjectedText);
    case "phase":
      return hasRequired(value, "title", isProjectedText);
    case "agentStart":
      return (
        hasRequired(value, "label", isProjectedText) &&
        hasOptional(value, "phase", isProjectedText) &&
        hasRequired(value, "prompt", isProjectedText) &&
        hasOptional(value, "model", isProjectedText) &&
        hasOptional(value, "configOptions", (candidate) => isConfigOptions(candidate, true)) &&
        hasOptional(value, "timeoutMs", (candidate) => candidate === null || isNonNegativeFinite(candidate)) &&
        hasOptional(value, "idleTimeoutMs", (candidate) => candidate === null || isNonNegativeFinite(candidate)) &&
        hasRequired(value, "callIndex", isNonNegativeSafeInteger) &&
        hasOptional(value, "path", isProjectedText)
      );
    case "agentEnd":
      return (
        hasRequired(value, "label", isProjectedText) &&
        hasOptional(value, "phase", isProjectedText) &&
        hasRequired(value, "result", isProjectionValue) &&
        hasOptional(value, "tokens", isNonNegativeSafeInteger) &&
        hasOptional(value, "worktree", isProjectedText) &&
        hasOptional(value, "model", isProjectedText) &&
        hasOptional(value, "error", isProjectedText) &&
        hasOptional(value, "errorCode", (candidate) => typeof candidate === "string" && WORKFLOW_ERROR_CODES.has(candidate as WorkflowErrorCode)) &&
        hasOptional(value, "recoverable", isBoolean) &&
        hasRequired(value, "callIndex", isNonNegativeSafeInteger) &&
        hasOptional(value, "usage", isAgentUsage) &&
        hasOptional(value, "modelResolved", isProjectedText) &&
        hasOptional(value, "backendId", isProjectedText) &&
        hasOptional(value, "provenance", (candidate) => isProvenance(candidate, true)) &&
        hasOptional(value, "errorRecord", (candidate) => isRecordedError(candidate, true)) &&
        !hasOwn(value, "session")
      );
    case "tokenUsage":
      return hasRequired(value, "usage", isTokenUsage);
    case "complete": {
      if (!isObject(value.summary)) return false;
      return (
        value.summary.status === "completed" &&
        hasRequired(value.summary, "workflowName", isProjectedText) &&
        hasRequired(value.summary, "agentCount", isNonNegativeSafeInteger) &&
        hasRequired(value.summary, "durationMs", isNonNegativeFinite) &&
        hasRequired(value.summary, "phaseCount", isNonNegativeSafeInteger) &&
        hasRequired(value.summary, "callCount", isNonNegativeSafeInteger) &&
        hasOptional(value.summary, "tokenUsage", isTokenUsage) &&
        hasRequired(value.summary, "result", isProjectionValue) &&
        !hasOwn(value, "result")
      );
    }
    case "journal":
      return hasRequired(value, "entry", (candidate) => isJournalEntry(candidate, true)) && !hasOwn(value.entry as Record<string, unknown>, "session");
    case "callRecord":
      return hasRequired(value, "record", (candidate) => isCallRecord(candidate, true));
    case "paused":
      if (hasOwn(value, "error")) return false;
      if (!hasOwn(value, "reason")) {
        return hasNone(value, ["errorRecord", "resetHint", "authContext", "checkpointContext"]);
      }
      if (isRequestedPauseReason(value.reason)) {
        return hasRequired(value, "errorRecord", (candidate) => isRecordedError(candidate, true)) && hasNone(value, ["resetHint", "authContext", "checkpointContext"]);
      }
      if (value.reason === "usage_limit") {
        return hasRequired(value, "errorRecord", (candidate) => isRecordedError(candidate, true)) && hasOptional(value, "resetHint", isProjectedText) && hasNone(value, ["authContext", "checkpointContext"]);
      }
      if (value.reason === "auth_required") {
        return hasRequired(value, "errorRecord", (candidate) => isRecordedError(candidate, true)) && hasOptional(value, "authContext", (candidate) => isAuthContext(candidate, true)) && hasNone(value, ["resetHint", "checkpointContext"]);
      }
      if (value.reason === "checkpoint_required") {
        return hasRequired(value, "errorRecord", (candidate) => isRecordedError(candidate, true)) && hasOptional(value, "checkpointContext", (candidate) => isCheckpointContext(candidate, true)) && hasNone(value, ["resetHint", "authContext"]);
      }
      return false;
    case "error":
      return !hasOwn(value, "error") && hasRequired(value, "errorRecord", (candidate) => isRecordedError(candidate, true));
    case "stopped":
    case "resumed":
      return true;
    default:
      return false;
  }
}

function recordShapeIsValid(value: unknown, requestedRunId: string): value is RunEventLogRecord {
  if (!isObject(value) || !isObject(value.projection)) return false;
  const sanitizedRunId = projectRunEventForPersistence({
    type: "stopped",
    runId: requestedRunId,
    scope: requestedRunId,
  }).runId;
  return (
    value.version === RUN_EVENT_LOG_VERSION &&
    hasRequired(value, "streamId", (candidate) => typeof candidate === "string" && STREAM_ID_PATTERN.test(candidate)) &&
    value.runId === sanitizedRunId &&
    hasRequired(value, "seq", isPositiveSafeInteger) &&
    hasRequired(value, "timestamp", isCanonicalTimestamp) &&
    isPersistedEvent(value.event) &&
    (value.event as Record<string, unknown>).runId === sanitizedRunId &&
    hasRequired(value.projection, "redacted", isBoolean) &&
    hasRequired(value.projection, "truncated", isBoolean)
  );
}

function stripLegacyBudgetFields(record: RunEventLogRecord): RunEventLogRecord {
  if (record.event.type !== "callRecord") return record;
  const { budgetDebit: _budgetDebit, ...currentCall } = record.event.record as
    typeof record.event.record & { budgetDebit?: unknown };
  return {
    ...record,
    event: { ...record.event, record: currentCall },
  };
}

function isEnoent(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function eventError(
  message: string,
  code: RunEventLogErrorCode,
  runId: string,
  path?: string,
  seq?: number,
  cause?: unknown,
): RunEventLogError {
  return new RunEventLogError(message, code, {
    runId,
    ...(path === undefined ? {} : { path }),
    ...(seq === undefined ? {} : { seq }),
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Parse and fully validate the complete records in `buffer` starting at byte `startOffset`,
 * whose first record must have sequence `startSeq + 1`. A trailing
 * partial line (no terminating LF) is left unparsed — the torn-tail contract. Every record it
 * returns has passed the identical UTF-8 / canonical-JSON / shape / density / stream
 * checks the whole-file parser applied, so the caller may cache and trust them without re-parsing.
 */
function parseLogFrom(
  buffer: Buffer,
  runId: string,
  path: string,
  expectedStreamId: string,
  startOffset: number,
  startSeq: number,
): ParsedSuffix {
  const records: RunEventLogRecord[] = [];
  let offset = startOffset;
  let completeBytes = startOffset;
  let expectedSeq = startSeq + 1;
  while (offset < buffer.length) {
    const lf = buffer.indexOf(0x0a, offset);
    if (lf === -1) break;
    const lineBytes = lf - offset + 1;
    if (lineBytes > RUN_EVENT_MAX_RECORD_BYTES) {
      throw eventError(`Terminated event record ${expectedSeq} exceeds the byte limit`, "RECORD_TOO_LARGE", runId, path, expectedSeq);
    }
    const bytes = buffer.subarray(offset, lf);
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw eventError(`Event record ${expectedSeq} is not valid UTF-8`, "CORRUPT_LOG", runId, path, expectedSeq);
    }
    let value: unknown;
    try {
      if (line.length === 0) throw new SyntaxError("blank line");
      value = JSON.parse(line) as unknown;
    } catch {
      throw eventError(`Event record ${expectedSeq} is not valid JSON`, "CORRUPT_LOG", runId, path, expectedSeq);
    }
    if (isObject(value) && hasOwn(value, "version") && value.version !== RUN_EVENT_LOG_VERSION) {
      throw eventError(`Event record ${expectedSeq} has an unsupported version`, "UNSUPPORTED_VERSION", runId, path, expectedSeq);
    }
    if (JSON.stringify(value) !== line) {
      throw eventError(`Event record ${expectedSeq} is not in canonical JSONL form`, "CORRUPT_LOG", runId, path, expectedSeq);
    }
    const parsedSeq = isObject(value) && typeof value.seq === "number" ? value.seq : expectedSeq;
    if (!recordShapeIsValid(value, runId)) {
      throw eventError(`Event record ${expectedSeq} violates the v1 record shape`, "CORRUPT_LOG", runId, path, parsedSeq);
    }
    if (value.seq !== expectedSeq) {
      throw eventError(`Event record sequence is not dense at ${expectedSeq}`, "CORRUPT_LOG", runId, path, value.seq);
    }
    if (value.streamId !== expectedStreamId) {
      throw eventError(`Event record ${expectedSeq} belongs to a different stream`, "STREAM_MISMATCH", runId, path, value.seq);
    }
    records.push(stripLegacyBudgetFields(value));
    offset = lf + 1;
    completeBytes = offset;
    expectedSeq += 1;
  }
  return { records, completeBytes };
}

function normalizeReadOptions(options: ReadRunEventsOptions = {}): { after: number; limit: number; streamId?: string } {
  const after = options.after ?? 0;
  if (!isNonNegativeSafeInteger(after)) {
    throw new RunEventLogError(`after is invalid: ${String(after)}`, "INVALID_CURSOR", { runId: "" });
  }
  const limit = options.limit ?? RUN_EVENT_READ_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > RUN_EVENT_READ_LIMIT_MAX) {
    throw new RunEventLogError(`limit is invalid: ${String(limit)}`, "INVALID_LIMIT", { runId: "" });
  }
  if (options.streamId !== undefined && (typeof options.streamId !== "string" || !STREAM_ID_PATTERN.test(options.streamId))) {
    throw new RunEventLogError(`streamId is invalid: ${String(options.streamId)}`, "INVALID_STREAM_ID", { runId: "" });
  }
  return { after, limit, ...(options.streamId === undefined ? {} : { streamId: options.streamId }) };
}

function resolveEventFs(fsOverride: Partial<FsLayer> = {}): ResolvedEventFs {
  return {
    readFileSync: fsOverride.readFileSync ?? readFileSync,
    unlinkSync: fsOverride.unlinkSync ?? unlinkSync,
    openSync: fsOverride.openSync ?? openSync,
    writeSync: fsOverride.writeSync ?? writeSync,
    closeSync: fsOverride.closeSync ?? closeSync,
    truncateSync: fsOverride.truncateSync ?? truncateSync,
  };
}

function withRunEventsInternal(persistence: RunPersistence, fs: ResolvedEventFs): RunEventPersistence {
  if ((persistence as RunPersistence & { [RUN_EVENT_WRAPPER]?: boolean })[RUN_EVENT_WRAPPER]) {
    return persistence as RunEventPersistence;
  }

  // One validated in-memory view per run (see RunEventCache), keyed by runId and released with the run.
  const runCaches = new Map<string, RunEventCache>();
  const runsDir = resolve(persistence.getRunsDir());
  const eventPath = (runId: string) => join(runsDir, `${runId}.events.jsonl`);

  // Move a read-seeded cache to the most-recently-used position (Map preserves insertion order),
  // and evict the least-recently-used read caches once the map exceeds MAX_CACHED_RUNS. Writer-owned
  // caches are lease-bounded and skipped — evicting one would force a re-parse and torn-tail repair.
  const touchReadCache = (runId: string, cache: RunEventCache): void => {
    if (cache.writerRepaired) return;
    runCaches.delete(runId);
    runCaches.set(runId, cache);
  };

  const evictReadCaches = (): void => {
    if (runCaches.size <= MAX_CACHED_RUNS) return;
    for (const [id, cache] of runCaches) {
      if (runCaches.size <= MAX_CACHED_RUNS) break;
      if (!cache.writerRepaired) runCaches.delete(id);
    }
  };

  const readSidecar = (runId: string): { path: string; present: boolean; buffer: Buffer } => {
    const path = eventPath(runId);
    try {
      const value = fs.readFileSync(path);
      return { path, present: true, buffer: Buffer.isBuffer(value) ? value : Buffer.from(value) };
    } catch (cause) {
      if (isEnoent(cause)) return { path, present: false, buffer: Buffer.alloc(0) };
      throw eventError("Unable to read the event log", "IO_ERROR", runId, path, undefined, cause);
    }
  };

  const loadSnapshot = (runId: string): PersistedRunState | null => {
    try {
      const snapshot = persistence.load(runId);
      if (snapshot !== null) return snapshot;
    } catch (cause) {
      if (cause instanceof RunEventLogError) throw cause;
      throw eventError("Unable to load the run snapshot", "IO_ERROR", runId, undefined, undefined, cause);
    }
    const snapshotPath = join(runsDir, `${runId}.json`);
    for (const candidate of [snapshotPath, `${snapshotPath}.bak`]) {
      try {
        fs.readFileSync(candidate);
      } catch (cause) {
        if (!isEnoent(cause)) {
          throw eventError("Unable to load the run snapshot", "IO_ERROR", runId, undefined, undefined, cause);
        }
      }
    }
    return null;
  };

  const classify = (
    runId: string,
    snapshot: PersistedRunState | null,
    sidecar: { path: string; present: boolean; buffer: Buffer },
    suppliedStreamId?: string,
  ): { snapshot: PersistedRunState; streamId: string } => {
    if (snapshot === null) {
      throw eventError(
        sidecar.present ? "Event log has no run snapshot" : "Run snapshot and event log were not found",
        sidecar.present ? "ORPHANED_LOG" : "RUN_NOT_FOUND",
        runId,
        sidecar.present ? sidecar.path : undefined,
      );
    }
    if (snapshot.eventSeq === undefined) {
      throw eventError(
        sidecar.present ? "Run snapshot has no event watermark" : "Run snapshot has no event log",
        sidecar.present ? "WATERMARK_MISSING" : "EVENT_LOG_UNAVAILABLE",
        runId,
        sidecar.present ? sidecar.path : undefined,
      );
    }
    if (!isNonNegativeSafeInteger(snapshot.eventSeq)) {
      throw eventError("Run snapshot has an invalid event watermark", "WATERMARK_MISSING", runId, sidecar.present ? sidecar.path : undefined);
    }
    if (typeof snapshot.eventStreamId !== "string" || !STREAM_ID_PATTERN.test(snapshot.eventStreamId)) {
      throw eventError("Run snapshot has no valid event stream ID", "STREAM_ID_MISSING", runId, sidecar.path);
    }
    if (suppliedStreamId !== undefined && suppliedStreamId !== snapshot.eventStreamId) {
      throw eventError("Requested event stream does not match the run snapshot", "STREAM_MISMATCH", runId, sidecar.path);
    }
    if (snapshot.eventLogIncomplete === true) {
      throw eventError("Run event log is marked incomplete", "EVENT_LOG_INCOMPLETE", runId, sidecar.path);
    }
    return { snapshot, streamId: snapshot.eventStreamId };
  };

  const snapshotAheadError = (runId: string, path: string | undefined, eventSeq: number): RunEventLogError =>
    eventError("Run snapshot watermark is ahead of the event log", "SNAPSHOT_AHEAD", runId, path, eventSeq);

  /**
   * Whole-file validated parse: the cold, authoritative path a run this process never wrote must
   * take at least once before any cached fast path is trusted. Runs every durability check on
   * every record (torn-tail stop, canonical form, shape, sequence density, stream identity,
   * snapshot watermark).
   */
  const validatedParse = (runId: string, suppliedStreamId?: string) => {
    const snapshot = loadSnapshot(runId);
    const sidecar = readSidecar(runId);
    const classified = classify(runId, snapshot, sidecar, suppliedStreamId);
    const parsed = parseLogFrom(sidecar.buffer, runId, sidecar.path, classified.streamId, 0, 0);
    if (classified.snapshot.eventSeq! > parsed.records.length) {
      throw snapshotAheadError(runId, sidecar.path, classified.snapshot.eventSeq!);
    }
    return { ...classified, ...sidecar, ...parsed };
  };

  const cacheFromParse = (
    parsed: ReturnType<typeof validatedParse>,
    writerRepaired: boolean,
  ): RunEventCache => ({
    streamId: parsed.streamId,
    records: parsed.records,
    completeBytes: parsed.completeBytes,
    prefixHash: prefixHashOf(parsed.buffer, parsed.completeBytes),
    writerRepaired,
  });

  /**
   * The writer's own view. First append (or the first after a lease release cleared the cache)
   * pays one whole-file validated parse, repairs any torn suffix, and seeds a writer-owned cache
   * that every later append advances in O(bytes-written).
   */
  const ensureWriterCache = (runId: string): RunEventCache => {
    const existing = runCaches.get(runId);
    if (existing !== undefined && existing.writerRepaired) return existing;
    const parsed = validatedParse(runId);
    if (parsed.buffer.length !== parsed.completeBytes) {
      try {
        fs.truncateSync(parsed.path, parsed.completeBytes);
      } catch (cause) {
        throw eventError("Unable to repair the partial event-log suffix", "IO_ERROR", runId, parsed.path, parsed.records.length + 1, cause);
      }
    }
    const cache = cacheFromParse(parsed, true);
    runCaches.set(runId, cache);
    return cache;
  };

  /**
   * Bring the cached view of `runId` up to date and hand it back, doing work proportional only to
   * the never-before-seen suffix. The file is re-read and its validated prefix re-verified every
   * time, so an in-place same-length rewrite of an already-validated prefix is still caught.
   */
  const ensureReadCache = (
    runId: string,
    suppliedStreamId?: string,
  ): { cache: RunEventCache; snapshot: PersistedRunState; path: string } => {
    const snapshot = loadSnapshot(runId);
    const sidecar = readSidecar(runId);
    const classified = classify(runId, snapshot, sidecar, suppliedStreamId);
    const streamId = classified.streamId;
    let cache = runCaches.get(runId);
    const canWarm =
      cache !== undefined &&
      cache.streamId === streamId &&
      sidecar.buffer.length >= cache.completeBytes &&
      // appendEvent extends a writer-owned cache itself, so a foreign extension of its file
      // falls back to a cold re-validation rather than a suffix parse.
      !(cache.writerRepaired && sidecar.buffer.length > cache.completeBytes) &&
      prefixHashEquals(prefixHashOf(sidecar.buffer, cache.completeBytes), cache.prefixHash);
    if (canWarm && cache !== undefined) {
      if (sidecar.buffer.length > cache.completeBytes) {
        const suffix = parseLogFrom(
          sidecar.buffer,
          runId,
          sidecar.path,
          streamId,
          cache.completeBytes,
          cache.records.length,
        );
        if (suffix.records.length > 0) {
          for (const record of suffix.records) cache.records.push(record);
          foldPrefixHash(cache.prefixHash, sidecar.buffer, cache.completeBytes, suffix.completeBytes);
          cache.completeBytes = suffix.completeBytes;
        }
      }
      touchReadCache(runId, cache);
    } else {
      const parsed = parseLogFrom(sidecar.buffer, runId, sidecar.path, streamId, 0, 0);
      cache = {
        streamId,
        records: parsed.records,
        completeBytes: parsed.completeBytes,
        prefixHash: prefixHashOf(sidecar.buffer, parsed.completeBytes),
        writerRepaired: false,
      };
      runCaches.set(runId, cache);
      evictReadCaches();
    }
    if (classified.snapshot.eventSeq! > cache.records.length) {
      throw snapshotAheadError(runId, sidecar.path, classified.snapshot.eventSeq!);
    }
    return { cache, snapshot: classified.snapshot, path: sidecar.path };
  };

  const readEvents = (runId: string, options: ReadRunEventsOptions = {}): ReadRunEventsResult => {
    let normalized: ReturnType<typeof normalizeReadOptions>;
    try {
      normalized = normalizeReadOptions(options);
    } catch (error) {
      const invalid = error as RunEventLogError;
      throw new RunEventLogError(invalid.message, invalid.code, { runId });
    }
    const { cache, path } = ensureReadCache(runId, normalized.streamId);
    const tail = cache.records.length;
    if (normalized.after > tail) {
      throw eventError("after is ahead of the complete event-log tail", "CURSOR_AHEAD", runId, path, normalized.after);
    }
    const events = cache.records.slice(normalized.after, normalized.after + normalized.limit);
    const cursor = events.at(-1)?.seq ?? normalized.after;
    return {
      events,
      streamId: cache.streamId,
      cursor,
      endCursor: tail,
      hasMore: cursor < tail,
    };
  };

  const appendEvent = (runId: string, input: AppendRunEventInput): RunEventLogRecord => {
    const cache = ensureWriterCache(runId);
    const expectedSeq = cache.records.length + 1;
    if (input.seq !== expectedSeq) {
      throw eventError(`Append sequence must be ${expectedSeq}`, "SEQUENCE_MISMATCH", runId, eventPath(runId), typeof input.seq === "number" ? input.seq : undefined);
    }
    if (!isCanonicalTimestamp(input.timestamp)) {
      throw eventError("Append timestamp is not canonical", "CORRUPT_LOG", runId, eventPath(runId), input.seq);
    }
    let admitted: boolean;
    try {
      admitted = isPersistableInputEvent(input.event);
    } catch (cause) {
      throw eventError("Run event traversal failed during projection", "PROJECTION_ERROR", runId, eventPath(runId), input.seq, cause);
    }
    if (!admitted || input.event.runId !== runId) {
      throw eventError("Append input is not a valid persistable run event", "CORRUPT_LOG", runId, eventPath(runId), input.seq);
    }
    let projected: ReturnType<typeof projectRunEventForPersistence>;
    try {
      projected = projectRunEventForPersistence(input.event);
    } catch (cause) {
      throw eventError("Run event projection failed", "PROJECTION_ERROR", runId, eventPath(runId), input.seq, cause);
    }
    const record: RunEventLogRecord = {
      version: RUN_EVENT_LOG_VERSION,
      streamId: cache.streamId,
      runId: projected.runId,
      seq: input.seq,
      timestamp: input.timestamp,
      event: projected.event,
      projection: projected.projection,
    };
    if (!recordShapeIsValid(record, runId)) {
      throw eventError("Projected event violates the v1 record shape", "CORRUPT_LOG", runId, eventPath(runId), input.seq);
    }
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (line.length > RUN_EVENT_MAX_RECORD_BYTES) {
      throw eventError("Projected event record exceeds the byte limit", "RECORD_TOO_LARGE", runId, eventPath(runId), input.seq);
    }

    const path = eventPath(runId);
    let descriptor: number;
    try {
      descriptor = fs.openSync(path, "a");
    } catch (cause) {
      throw eventError("Unable to open the event log for append", "IO_ERROR", runId, path, input.seq, cause);
    }
    let written: number | undefined;
    let failure: unknown;
    try {
      written = fs.writeSync(descriptor, line, 0, line.length, null);
    } catch (cause) {
      failure = cause;
    }
    try {
      fs.closeSync(descriptor);
    } catch (cause) {
      failure ??= cause;
    }
    if (failure !== undefined) {
      throw eventError("Unable to append and close the event log", "IO_ERROR", runId, path, input.seq, failure);
    }
    if (written !== line.length) {
      throw eventError("Event-log append returned a short write", "IO_ERROR", runId, path, input.seq);
    }
    // The durable write succeeded: advance the writer-owned view (O(bytes-written)).
    cache.records.push(record);
    foldPrefixHash(cache.prefixHash, line, 0, line.length);
    cache.completeBytes += line.length;
    return record;
  };

  const wrapper = {
    save(state) {
      return persistence.save(state);
    },
    load(runId) {
      return persistence.load(runId);
    },
    list() {
      return persistence.list();
    },
    delete(runId) {
      runCaches.delete(runId);
      try {
        fs.unlinkSync(eventPath(runId));
      } catch {
        // Sidecar cleanup is best-effort; the underlying delete result remains authoritative.
      }
      return persistence.delete(runId);
    },
    loadLineageTombstone(runId) {
      return persistence.loadLineageTombstone?.(runId) ?? null;
    },
    acquireRunLease(runId) {
      return persistence.acquireRunLease(runId);
    },
    releaseRunLease(lease: RunLease) {
      runCaches.delete(lease.runId);
      return persistence.releaseRunLease(lease);
    },
    inspectRunLease(runId: string) {
      return persistence.inspectRunLease?.(runId) ?? null;
    },
    validateRunLease(lease: RunLease) {
      return persistence.validateRunLease?.(lease) ?? true;
    },
    getRunsDir() {
      return persistence.getRunsDir();
    },
    // Script storage is a capability of the underlying store: the file-backed persistence keeps
    // an inline script next to its run record, while a store without these seams simply has no
    // script file, and the manager records only the origin.
    ...(persistence.scriptLocation ? { scriptLocation: (runId: string) => persistence.scriptLocation!(runId) } : {}),
    ...(persistence.writeInlineScript
      ? { writeInlineScript: (runId: string, script: string) => persistence.writeInlineScript!(runId, script) }
      : {}),
    ...(persistence.discardInlineScript
      ? { discardInlineScript: (runId: string) => persistence.discardInlineScript!(runId) }
      : {}),
    ...(persistence.readScript ? { readScript: (runId: string) => persistence.readScript!(runId) } : {}),
    appendEvent,
    readEvents,
  } as RunEventPersistence & { [RUN_EVENT_WRAPPER]: true };
  Object.defineProperty(wrapper, RUN_EVENT_WRAPPER, { value: true });
  return wrapper;
}

export function withRunEvents(persistence: RunPersistence): RunEventPersistence {
  return withRunEventsInternal(persistence, resolveEventFs());
}

/** Package-private factory seam that keeps filesystem overrides consistent with snapshot I/O. */
export function withRunEventsUsingFs(
  persistence: RunPersistence,
  fsOverride?: Partial<FsLayer>,
): RunEventPersistence {
  return withRunEventsInternal(persistence, resolveEventFs(fsOverride));
}

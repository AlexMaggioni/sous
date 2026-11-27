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
import { WorkflowErrorCode } from "../../errors.js";
import { MAX_OBSERVABILITY_SCALAR_BYTES, projectRunEventForPersistence } from "../../run-observability.js";
import type { FsLayer, PersistedRunState, RunPersistence } from "./run-persistence.js";

export const RUN_EVENT_MAX_RECORD_BYTES = 65_536;
const RUN_EVENT_READ_LIMIT_DEFAULT = 100 as const;
export const RUN_EVENT_READ_LIMIT_MAX = 1_000 as const;

const STREAM_ID_PATTERN = /^[0-9a-f]{32}$/;
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
  "asked",
]);
// Retired errors stay readable in old event logs: the execution budget's, the isolation runs',
// and the old replay check's. No run makes them now, and the error enum leaves them out.
const WORKFLOW_ERROR_CODES = new Set<string>([
  ...Object.values(WorkflowErrorCode),
  "AGENT_TIMEOUT",
  "AGENT_IDLE_TIMEOUT",
  "RECORDING_UNUSABLE",
  "REPLAY_TARGET_INVALID",
  "REPLAY_DIVERGENCE",
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

/** A run's event log: `<runsDir>/<runId>.events.jsonl`, one v1 record per line. */
export interface RunEventLog {
  appendEvent(runId: string, input: AppendRunEventInput): RunEventLogRecord;
  readEvents(runId: string, options?: ReadRunEventsOptions): ReadRunEventsResult;
}

/** The engine's own run store, which keeps each run's event log next to its state. */
export interface RunEventPersistence extends RunPersistence, RunEventLog {}

/** Whether a run store keeps an event log. A test's in-memory store has none. */
export function hasEventLog(store: RunPersistence): store is RunEventPersistence {
  const candidate = store as Partial<RunEventLog>;
  return typeof candidate.appendEvent === "function" && typeof candidate.readEvents === "function";
}

interface ResolvedEventFs {
  readFileSync: typeof readFileSync;
  unlinkSync: typeof unlinkSync;
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  closeSync: typeof closeSync;
  truncateSync: typeof truncateSync;
}

interface ParsedLog {
  records: RunEventLogRecord[];
  /** Byte length of the complete records. A partial last line, with no LF, is left out. */
  completeBytes: number;
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

function isProvenance(value: unknown): boolean {
  if (!isObject(value)) return false;
  const text = isProjectedText;
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

function isAuthContext(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value.methods) || value.methods.length > 20) return false;
  const text = isProjectedText;
  if (!hasOptional(value, "backendId", text)) return false;
  return value.methods.every(
    (method) =>
      isObject(method) &&
      hasRequired(method, "id", text) &&
      (method.type === "agent" || method.type === "terminal") &&
      hasOptional(method, "name", text),
  );
}

function isCheckpointContext(value: unknown): boolean {
  if (!isObject(value)) return false;
  const text = isProjectedText;
  if (
    !hasRequired(value, "callIndex", isNonNegativeSafeInteger) ||
    !hasRequired(value, "hash", isString) ||
    !hasRequired(value, "prompt", text) ||
    !(value.kind === "confirm" || value.kind === "input" || value.kind === "select")
  ) {
    return false;
  }
  if (hasOwn(value, "choices") && value.choices !== undefined) {
    if (!Array.isArray(value.choices) || value.choices.length > 20 || !value.choices.every(text)) return false;
  }
  if (!hasOptional(value, "timeoutMs", isNonNegativeFinite)) return false;
  return hasOptional(value, "default", isProjectionValue);
}

function isProviderUsageContext(value: unknown): boolean {
  if (!isObject(value)) return false;
  const text = isProjectedText;
  return (
    hasRequired(value, "backendId", text) &&
    (value.source === "provider" || value.source === "adapter_fallback") &&
    hasOptional(value, "providerCode", text) &&
    hasOptional(value, "resetAt", text)
  );
}

function isRecordedError(value: unknown): boolean {
  if (!isObject(value) || !(value.form === "workflow-error" || value.form === "error" || value.form === "value")) {
    return false;
  }
  const text = isProjectedText;
  if (
    !hasOptional(value, "name", text) ||
    !hasOptional(value, "message", text) ||
    !hasOptional(value, "code", (candidate) => typeof candidate === "string" && WORKFLOW_ERROR_CODES.has(candidate as WorkflowErrorCode)) ||
    !hasOptional(value, "recoverable", isBoolean) ||
    !hasOptional(value, "agentLabel", text) ||
    !hasOptional(value, "resetHint", text) ||
    !hasOptional(value, "providerUsageLimitContext", isProviderUsageContext) ||
    !hasOptional(value, "authContext", isAuthContext) ||
    !hasOptional(value, "checkpointContext", isCheckpointContext) ||
    !hasOptional(value, "lossy", isBoolean)
  ) {
    return false;
  }
  if ((value.form === "workflow-error" || value.form === "error") && !hasRequired(value, "message", text)) return false;
  return (
    hasOptional(value, "details", isProjectionValue) &&
    hasOptional(value, "props", isProjectionValue) &&
    hasOptional(value, "value", isProjectionValue)
  );
}

function isJournalCall(value: unknown): boolean {
  if (!isObject(value)) return false;
  const text = isProjectedText;
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

function isJournalEntry(value: unknown): boolean {
  if (!isObject(value)) return false;
  const text = isProjectedText;
  return (
    hasRequired(value, "index", isNonNegativeSafeInteger) &&
    hasRequired(value, "hash", isString) &&
    hasRequired(value, "result", isProjectionValue) &&
    !hasOwn(value, "session") &&
    hasOptional(value, "call", isJournalCall) &&
    hasOptional(value, "kind", (candidate) => candidate === "agent" || candidate === "checkpoint") &&
    hasOptional(value, "usage", isAgentUsage) &&
    hasOptional(value, "scope", text)
  );
}

function isCallRecord(value: unknown): boolean {
  // Historical event observation remains readable, including the retired "headless"
  // origin. Execution reuse is separately gated by explicit checkpoint provenance.
  if (!isObject(value)) return false;
  const text = isProjectedText;
  if (
    !hasRequired(value, "index", isNonNegativeSafeInteger) ||
    !(value.kind === "agent" || value.kind === "checkpoint") ||
    !hasRequired(value, "hash", isString) ||
    !(value.outcome === "result" || value.outcome === "null" || value.outcome === "error") ||
    !(value.origin === "runner" || value.origin === "journal-replay" || value.origin === "confirm" || value.origin === "headless" || value.origin === "engine") ||
    !hasOptional(value, "path", text) ||
    !hasOptional(value, "inputsHash", isString) ||
    !hasOptional(value, "label", text) ||
    !hasOptional(value, "error", isRecordedError) ||
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
    !hasOptional(value, "provenance", isProvenance) ||
    !hasOptional(value, "scope", text)
  ) {
    return false;
  }
  return value.outcome === "result" ? !hasOwn(value, "error") : hasRequired(value, "error", isRecordedError);
}

function isOrigin(value: Record<string, unknown>): boolean {
  return hasRequired(value, "runId", isProjectedText) && hasRequired(value, "scope", isProjectedText);
}

function isConfigOptions(value: unknown): boolean {
  if (!isObject(value) || Object.keys(value).length > 20) return false;
  return Object.entries(value).every(([key, option]) => isProjectedText(key) && (isBoolean(option) || isProjectedText(option)));
}

/** The shape of a saved event, after the projection. */
function isPersistedEvent(value: unknown): boolean {
  if (!isObject(value) || !isString(value.type) || !EVENT_TYPES.has(value.type) || !isOrigin(value)) return false;
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
        hasOptional(value, "configOptions", isConfigOptions) &&
        hasOptional(value, "timeoutMs", (candidate) => candidate === null || isNonNegativeFinite(candidate)) &&
        hasOptional(value, "idleTimeoutMs", (candidate) => candidate === null || isNonNegativeFinite(candidate)) &&
        hasRequired(value, "callIndex", isNonNegativeSafeInteger) &&
        hasOptional(value, "path", isProjectedText) &&
        hasOptional(value, "room", (room) => isObject(room) && hasRequired(room, "name", isProjectedText) && hasRequired(room, "call", isNonNegativeSafeInteger))
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
        hasOptional(value, "provenance", isProvenance) &&
        hasOptional(value, "errorRecord", isRecordedError) &&
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
      return hasRequired(value, "entry", isJournalEntry);
    case "callRecord":
      return hasRequired(value, "record", isCallRecord);
    case "paused":
      if (hasOwn(value, "error")) return false;
      if (!hasOwn(value, "reason")) {
        return hasNone(value, ["errorRecord", "resetHint", "authContext", "checkpointContext"]);
      }
      if (isRequestedPauseReason(value.reason)) {
        return hasRequired(value, "errorRecord", isRecordedError) && hasNone(value, ["resetHint", "authContext", "checkpointContext"]);
      }
      if (value.reason === "usage_limit") {
        return hasRequired(value, "errorRecord", isRecordedError) && hasOptional(value, "resetHint", isProjectedText) && hasNone(value, ["authContext", "checkpointContext"]);
      }
      if (value.reason === "auth_required") {
        return hasRequired(value, "errorRecord", isRecordedError) && hasOptional(value, "authContext", isAuthContext) && hasNone(value, ["resetHint", "checkpointContext"]);
      }
      if (value.reason === "checkpoint_required") {
        return hasRequired(value, "errorRecord", isRecordedError) && hasOptional(value, "checkpointContext", isCheckpointContext) && hasNone(value, ["resetHint", "authContext"]);
      }
      return false;
    case "error":
      return !hasOwn(value, "error") && hasRequired(value, "errorRecord", isRecordedError);
    case "stopped":
    case "resumed":
      return true;
    case "asked":
      return hasRequired(value, "callIndex", isNonNegativeSafeInteger) && hasRequired(value, "prompt", isProjectedText) && hasOptional(value, "step", isProjectedText);
    default:
      return false;
  }
}

function recordShapeIsValid(value: unknown, savedRunId: string): value is RunEventLogRecord {
  if (!isObject(value) || !isObject(value.projection)) return false;
  return (
    value.version === RUN_EVENT_LOG_VERSION &&
    hasRequired(value, "streamId", (candidate) => typeof candidate === "string" && STREAM_ID_PATTERN.test(candidate)) &&
    value.runId === savedRunId &&
    hasRequired(value, "seq", isPositiveSafeInteger) &&
    hasRequired(value, "timestamp", isCanonicalTimestamp) &&
    isPersistedEvent(value.event) &&
    (value.event as Record<string, unknown>).runId === savedRunId &&
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

/** The run ID as the projection saves it, which every record must carry. */
function persistedRunId(runId: string): string {
  return projectRunEventForPersistence({ type: "stopped", runId, scope: runId }).runId;
}

/**
 * Parse and validate every complete record in `buffer`. A trailing partial line, with no LF,
 * is left unparsed: a reader ignores it, and the writer cuts it off before its first append.
 */
function parseLog(buffer: Buffer, runId: string, path: string, expectedStreamId: string): ParsedLog {
  const savedRunId = persistedRunId(runId);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: RunEventLogRecord[] = [];
  let offset = 0;
  let expectedSeq = 1;
  while (offset < buffer.length) {
    const lf = buffer.indexOf(0x0a, offset);
    if (lf === -1) break;
    if (lf - offset + 1 > RUN_EVENT_MAX_RECORD_BYTES) {
      throw eventError(`Terminated event record ${expectedSeq} exceeds the byte limit`, "RECORD_TOO_LARGE", runId, path, expectedSeq);
    }
    let line: string;
    try {
      line = decoder.decode(buffer.subarray(offset, lf));
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
    if (!recordShapeIsValid(value, savedRunId)) {
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
    expectedSeq += 1;
  }
  return { records, completeBytes: offset };
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

/**
 * The event log of the runs in `runsDir`, for createRunPersistence. `load` reads a run's saved
 * state, which holds the log's stream id and watermark. Each read parses the whole log. The
 * writer parses it once per lease, before its first append, and then only counts what it adds.
 * The store calls `forget` when it releases a run's lease and `remove` before it deletes a run.
 */
export function createRunEventLog(
  runsDir: string,
  load: (runId: string) => PersistedRunState | null,
  fsOverride?: Partial<FsLayer>,
): RunEventLog & { forget(runId: string): void; remove(runId: string): void } {
  const fs = resolveEventFs(fsOverride);
  // The next sequence for each run this process appends to. It is set by the first append under
  // a lease and dropped when the lease is released.
  const writers = new Map<string, { streamId: string; nextSeq: number }>();
  const dir = resolve(runsDir);
  const eventPath = (runId: string) => join(dir, `${runId}.events.jsonl`);

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
      const snapshot = load(runId);
      if (snapshot !== null) return snapshot;
    } catch (cause) {
      if (cause instanceof RunEventLogError) throw cause;
      throw eventError("Unable to load the run snapshot", "IO_ERROR", runId, undefined, undefined, cause);
    }
    const snapshotPath = join(dir, `${runId}.json`);
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

  /** Every complete record of the run's log, checked against its snapshot. */
  const parse = (runId: string, suppliedStreamId?: string) => {
    const snapshot = loadSnapshot(runId);
    const sidecar = readSidecar(runId);
    const { snapshot: classified, streamId } = classify(runId, snapshot, sidecar, suppliedStreamId);
    const parsed = parseLog(sidecar.buffer, runId, sidecar.path, streamId);
    if (classified.eventSeq! > parsed.records.length) {
      throw eventError("Run snapshot watermark is ahead of the event log", "SNAPSHOT_AHEAD", runId, sidecar.path, classified.eventSeq!);
    }
    return { ...parsed, streamId, path: sidecar.path, bytes: sidecar.buffer.length };
  };

  /** The writer's state. The first append under a lease cuts off a partial last line. */
  const writerFor = (runId: string): { streamId: string; nextSeq: number } => {
    const existing = writers.get(runId);
    if (existing) return existing;
    const parsed = parse(runId);
    if (parsed.bytes !== parsed.completeBytes) {
      try {
        fs.truncateSync(parsed.path, parsed.completeBytes);
      } catch (cause) {
        throw eventError("Unable to repair the partial event-log suffix", "IO_ERROR", runId, parsed.path, parsed.records.length + 1, cause);
      }
    }
    const writer = { streamId: parsed.streamId, nextSeq: parsed.records.length + 1 };
    writers.set(runId, writer);
    return writer;
  };

  const readEvents = (runId: string, options: ReadRunEventsOptions = {}): ReadRunEventsResult => {
    let normalized: ReturnType<typeof normalizeReadOptions>;
    try {
      normalized = normalizeReadOptions(options);
    } catch (error) {
      const invalid = error as RunEventLogError;
      throw new RunEventLogError(invalid.message, invalid.code, { runId });
    }
    const { records, streamId, path } = parse(runId, normalized.streamId);
    const tail = records.length;
    if (normalized.after > tail) {
      throw eventError("after is ahead of the complete event-log tail", "CURSOR_AHEAD", runId, path, normalized.after);
    }
    const events = records.slice(normalized.after, normalized.after + normalized.limit);
    const cursor = events.at(-1)?.seq ?? normalized.after;
    return { events, streamId, cursor, endCursor: tail, hasMore: cursor < tail };
  };

  const appendEvent = (runId: string, input: AppendRunEventInput): RunEventLogRecord => {
    const writer = writerFor(runId);
    const path = eventPath(runId);
    if (input.seq !== writer.nextSeq) {
      throw eventError(`Append sequence must be ${writer.nextSeq}`, "SEQUENCE_MISMATCH", runId, path, typeof input.seq === "number" ? input.seq : undefined);
    }
    if (!isCanonicalTimestamp(input.timestamp)) {
      throw eventError("Append timestamp is not canonical", "CORRUPT_LOG", runId, path, input.seq);
    }
    if (!EVENT_TYPES.has(input.event.type) || input.event.runId !== runId) {
      throw eventError("Append input is not a valid persistable run event", "CORRUPT_LOG", runId, path, input.seq);
    }
    let projected: ReturnType<typeof projectRunEventForPersistence>;
    try {
      projected = projectRunEventForPersistence(input.event);
    } catch (cause) {
      throw eventError("Run event projection failed", "PROJECTION_ERROR", runId, path, input.seq, cause);
    }
    const record: RunEventLogRecord = {
      version: RUN_EVENT_LOG_VERSION,
      streamId: writer.streamId,
      runId: projected.runId,
      seq: input.seq,
      timestamp: input.timestamp,
      event: projected.event,
      projection: projected.projection,
    };
    // The record must read back: a reader runs this same check on every line.
    if (!recordShapeIsValid(record, persistedRunId(runId))) {
      throw eventError("Projected event violates the v1 record shape", "CORRUPT_LOG", runId, path, input.seq);
    }
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (line.length > RUN_EVENT_MAX_RECORD_BYTES) {
      throw eventError("Projected event record exceeds the byte limit", "RECORD_TOO_LARGE", runId, path, input.seq);
    }

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
    writer.nextSeq += 1;
    return record;
  };

  return {
    appendEvent,
    readEvents,
    forget(runId) {
      writers.delete(runId);
    },
    remove(runId) {
      writers.delete(runId);
      try {
        fs.unlinkSync(eventPath(runId));
      } catch {
        // Removing the log is best-effort. The store's delete result is the one that counts.
      }
    },
  };
}

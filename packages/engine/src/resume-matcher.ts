import type {
  AgentSessionRecord,
  JournalEntry,
  WorkflowCallRecord,
} from "./workflow-result.js";
import type { AgentUsage } from "./steps/agent-run.js";
import { assertExplicitCheckpointProvenance } from "./checkpoint-provenance.js";
import type { PreparedResume } from "./resume.js";
import {
  type PersistedCheckpointInjection,
  type PersistedResumeCandidate,
  type PersistedResumeCallBlocker,
  type PersistedResumeSeed,
  type PersistedRunState,
} from "./runs/persistence/run-persistence.js";
import { isNestedScope, resumeOccurrenceKey } from "./resume-identity.js";
import { cloneFrozenStrictJson, cloneStrictJsonValue, deepFreeze } from "./strict-json.js";

const SHA256 = /^[0-9a-f]{64}$/;
const TERMINAL_STATUSES = new Set(["completed", "paused", "failed", "aborted"]);
const RESUME_MATCHES = new Set(["path-hash", "unique-hash", "index-hash", "occurrence"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPath(value: unknown): value is string {
  return isNonEmptyString(value) && !value.includes("\u0000");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStrictJson(value: unknown): boolean {
  return cloneStrictJsonValue(value).ok;
}

function strictClone<T>(value: T): T | undefined {
  const cloned = cloneFrozenStrictJson(value);
  return cloned.ok ? cloned.clone as T : undefined;
}

function isUsage(value: unknown): value is AgentUsage {
  if (!isRecord(value)) return false;
  return ["input", "output", "cacheRead", "cacheWrite", "total", "cost"].every((field) =>
    isFiniteNonNegative(value[field]),
  ) && isStrictJson(value);
}

function isSession(value: unknown): value is AgentSessionRecord {
  if (!isRecord(value) || !isRecord(value.reopen)) return false;
  return (
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.backendId) &&
    isNonEmptyString(value.cwd) &&
    isNonNegativeSafeInteger(value.callIndex) &&
    typeof value.label === "string" &&
    (value.phase === undefined || typeof value.phase === "string") &&
    typeof value.keptOpen === "boolean" &&
    typeof value.reopen.load === "boolean" &&
    typeof value.reopen.resume === "boolean" &&
    typeof value.reopen.list === "boolean" &&
    (value.reopen.fork === undefined || typeof value.reopen.fork === "boolean") &&
    isStrictJson(value)
  );
}

function isReplayProvenance(value: unknown): value is NonNullable<WorkflowCallRecord["replay"]> {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "sourceRunId",
    "recordedIndex",
    "match",
    "checkpointHostDecision",
    "checkpointInjected",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return (
    isNonEmptyString(value.sourceRunId) &&
    isNonNegativeSafeInteger(value.recordedIndex) &&
    typeof value.match === "string" &&
    RESUME_MATCHES.has(value.match) &&
    (value.checkpointHostDecision === undefined || value.checkpointHostDecision === true) &&
    (value.checkpointInjected === undefined || value.checkpointInjected === true) &&
    (value.checkpointInjected !== true || value.checkpointHostDecision === true) &&
    isStrictJson(value)
  );
}

function validateReplayForCall(call: WorkflowCallRecord): boolean {
  const mustHaveReplay = call.origin === "journal-replay" && call.outcome === "result";
  if (!mustHaveReplay) return call.replay === undefined;
  if (!isReplayProvenance(call.replay)) return false;
  if (call.kind === "agent") {
    return (
      call.replay.checkpointHostDecision === undefined &&
      call.replay.checkpointInjected === undefined
    );
  }
  return call.replay.checkpointInjected !== true || call.replay.checkpointHostDecision === true;
}

function validateBasicCall(value: unknown, sourceRunId: string): value is WorkflowCallRecord {
  if (!isRecord(value)) return false;
  if (
    !isNonNegativeSafeInteger(value.index) ||
    (value.kind !== "agent" && value.kind !== "checkpoint") ||
    !isHash(value.hash) ||
    !["result", "null", "error"].includes(String(value.outcome)) ||
    !["runner", "journal-replay", "confirm", "engine"].includes(String(value.origin)) ||
    (value.scope !== sourceRunId && !isNestedScope(value.scope, sourceRunId))
  ) {
    return false;
  }
  if (value.path !== undefined && typeof value.path !== "string") return false;
  if (value.inputsHash !== undefined && typeof value.inputsHash !== "string") return false;
  if (value.isolation !== undefined && value.isolation !== "worktree") return false;
  if (value.worktree !== undefined && value.worktree !== true) return false;
  if (value.settlementOrdinal !== undefined && !isPositiveSafeInteger(value.settlementOrdinal)) return false;
  if (value.usage !== undefined && !isUsage(value.usage)) return false;
  if (value.outcome === "result") {
    if (value.error !== undefined) return false;
  } else if (!hasOwn(value, "error") || !isStrictJson(value.error)) {
    return false;
  }
  return isStrictJson(value);
}

function validateCallFacts(call: WorkflowCallRecord): boolean {
  if (!validateReplayForCall(call)) return false;
  if (
    call.worktree === true &&
    (call.kind !== "agent" || call.origin !== "runner" || call.isolation !== "worktree")
  ) {
    return false;
  }
  if (call.outcome !== "result") return true;
  if (!isPath(call.path) || !isHash(call.inputsHash)) return false;
  if (call.kind === "agent") {
    return call.origin === "runner" || call.origin === "journal-replay";
  }
  return (
    call.checkpointDecision === "explicit-v1" &&
    (call.origin === "confirm" || call.origin === "journal-replay")
  );
}

function validateJournalEntry(value: unknown, sourceRunId: string): value is JournalEntry {
  if (!isRecord(value)) return false;
  if (value.session !== undefined && (!isSession(value.session) || value.session.callIndex !== value.index)) {
    return false;
  }
  return (
    isNonNegativeSafeInteger(value.index) &&
    isHash(value.hash) &&
    (value.kind === "agent" || value.kind === "checkpoint") &&
    (value.kind !== "checkpoint" || value.checkpointDecision === "explicit-v1") &&
    (value.scope === sourceRunId || isNestedScope(value.scope, sourceRunId)) &&
    hasOwn(value, "result") &&
    isStrictJson(value.result) &&
    (value.session === undefined || isSession(value.session)) &&
    (value.usage === undefined || isUsage(value.usage)) &&
    (value.call === undefined || isStrictJson(value.call)) &&
    isStrictJson(value)
  );
}

/** A seed row's occurrence: its run and index, with the nested run's id for a nested row. */
function seedRowOccurrenceKey(row: PersistedResumeCandidate | PersistedResumeCallBlocker): string {
  return resumeOccurrenceKey(row.call.scope ?? row.sourceRunId, row.recordedIndex);
}

function validateCandidate(value: unknown): PersistedResumeCandidate | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.sourceRunId) ||
    !isNonNegativeSafeInteger(value.recordedIndex)
  ) {
    return undefined;
  }
  if (!validateBasicCall(value.call, value.sourceRunId) || !validateCallFacts(value.call)) return undefined;
  if (!validateJournalEntry(value.entry, value.sourceRunId)) return undefined;
  if (
    value.call.index !== value.recordedIndex ||
    value.entry.index !== value.recordedIndex ||
    value.entry.scope !== value.call.scope ||
    value.call.outcome !== "result" ||
    value.call.kind !== value.entry.kind ||
    value.call.hash !== value.entry.hash
  ) {
    return undefined;
  }
  return strictClone(value as unknown as PersistedResumeCandidate);
}

function validateCallBlocker(value: unknown): PersistedResumeCallBlocker | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.sourceRunId) ||
    !isNonNegativeSafeInteger(value.recordedIndex) ||
    !validateBasicCall(value.call, value.sourceRunId) ||
    !validateCallFacts(value.call) ||
    value.call.index !== value.recordedIndex ||
    value.call.outcome === "result" ||
    !isPath(value.call.path) ||
    !isHash(value.call.inputsHash)
  ) {
    return undefined;
  }
  return strictClone(value as unknown as PersistedResumeCallBlocker);
}

function validateInjection(value: unknown): PersistedCheckpointInjection | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.checkpointDecision !== "explicit-v1" ||
    !isNonEmptyString(value.sourceRunId) ||
    !isNonNegativeSafeInteger(value.recordedIndex) ||
    !isHash(value.hash) ||
    !isPath(value.path) ||
    !isHash(value.inputsHash) ||
    !hasOwn(value, "decision") ||
    !isStrictJson(value.decision)
  ) {
    return undefined;
  }
  return strictClone(value as unknown as PersistedCheckpointInjection);
}

export function cloneResumeCandidate(
  sourceRunId: string,
  entry: JournalEntry,
  call: WorkflowCallRecord,
): PersistedResumeCandidate | undefined {
  if (
    !isNonEmptyString(sourceRunId) ||
    !validateBasicCall(call, sourceRunId) ||
    !validateCallFacts(call) ||
    !validateJournalEntry(entry, sourceRunId) ||
    call.outcome !== "result" ||
    call.index !== entry.index ||
    call.hash !== entry.hash ||
    call.kind !== entry.kind
  ) {
    return undefined;
  }
  return strictClone({
    sourceRunId,
    recordedIndex: call.index,
    entry,
    call,
  });
}

export function cloneResumeCallBlocker(
  sourceRunId: string,
  call: WorkflowCallRecord,
): PersistedResumeCallBlocker | undefined {
  return validateCallBlocker({
    sourceRunId,
    recordedIndex: call.index,
    call,
  });
}

export function normalizeResumeSeed(input: {
  sourceRunId: string;
  promoted?: readonly PersistedResumeCandidate[];
  retained?: readonly PersistedResumeCandidate[];
  promotedBlockers?: readonly PersistedResumeCallBlocker[];
  retainedBlockers?: readonly PersistedResumeCallBlocker[];
  retainedInjections?: readonly PersistedCheckpointInjection[];
}): PersistedResumeSeed | undefined {
  if (!isNonEmptyString(input.sourceRunId)) return undefined;
  const candidates: PersistedResumeCandidate[] = [];
  const callBlockers: PersistedResumeCallBlocker[] = [];
  const checkpointInjections: PersistedCheckpointInjection[] = [];
  const occurrences = new Set<string>();
  for (const value of [...(input.promoted ?? []), ...(input.retained ?? [])]) {
    const candidate = validateCandidate(value);
    if (!candidate) return undefined;
    const key = seedRowOccurrenceKey(candidate);
    if (occurrences.has(key)) return undefined;
    occurrences.add(key);
    candidates.push(candidate);
  }
  for (const value of [...(input.promotedBlockers ?? []), ...(input.retainedBlockers ?? [])]) {
    const blocker = validateCallBlocker(value);
    if (!blocker) return undefined;
    const key = seedRowOccurrenceKey(blocker);
    if (occurrences.has(key)) return undefined;
    occurrences.add(key);
    callBlockers.push(blocker);
  }
  for (const value of input.retainedInjections ?? []) {
    const injection = validateInjection(value);
    if (!injection) return undefined;
    const key = resumeOccurrenceKey(injection.sourceRunId, injection.recordedIndex);
    if (occurrences.has(key)) return undefined;
    occurrences.add(key);
    checkpointInjections.push(injection);
  }
  return deepFreeze({
    format: "identity-v1",
    sourceRunId: input.sourceRunId,
    candidates,
    ...(callBlockers.length === 0 ? {} : { callBlockers }),
    ...(checkpointInjections.length === 0 ? {} : { checkpointInjections }),
  });
}

/**
 * Whether a reuse may replay the saved run's steps. A run that has not ended, or that ran in
 * another folder, replays nothing. Any other run pairs by occurrence.
 */
export function admitResumeSource(input: { source: PersistedRunState; effectiveCwd: string }): PreparedResume {
  const { source, effectiveCwd } = input;
  assertExplicitCheckpointProvenance(source);
  const base = { sourceRunId: source.runId, requestedPolicy: "auto" as const };
  if (!TERMINAL_STATUSES.has(String(source.status))) {
    return { strategy: "live", ...base, disabledReason: "source-not-terminal" };
  }
  if (typeof source.effectiveCwd === "string" && source.effectiveCwd !== effectiveCwd) {
    return { strategy: "live", ...base, disabledReason: "cwd-mismatch" };
  }
  return { strategy: "occurrence-v1", ...base };
}

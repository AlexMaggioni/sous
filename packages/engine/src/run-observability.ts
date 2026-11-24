import type { AgentResultProvenance, AgentUsage } from "./steps/agent-run.js";
import type { AuthErrorContext, CheckpointContext, WorkflowRecordedError } from "./errors.js";
import type { TokenUsage, WorkflowCallRecord } from "./workflow-result.js";
import type {
  PersistableEngineRunEvent,
  PersistedRunEvent,
  RunEventCheckpointProjection,
  RunEventErrorProjection,
  RunEventLogRecord,
  RunEventValueProjection,
} from "./run-events.js";
import { redactText, truncateUtf8 } from "./redact.js";

export const MAX_OBSERVABILITY_SCALAR_BYTES = 512;
const MAX_RESULT_DEPTH = 4;
const MAX_ARRAY_ITEMS = 10;
const MAX_OBJECT_KEYS = 20;

interface SanitizedText {
  value: string;
  redacted: boolean;
  truncated: boolean;
}

interface CompactState {
  redacted: boolean;
  truncated: boolean;
}

const SENSITIVE_KEY_PARTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "credential",
  "authorization",
  "cookie",
  "privatekey",
] as const;

function sanitizeText(value: string): SanitizedText {
  const redacted = redactText(value);
  const shortened = truncateUtf8(redacted.value, MAX_OBSERVABILITY_SCALAR_BYTES);
  return {
    value: shortened,
    redacted: redacted.redacted,
    truncated: shortened !== redacted.value,
  };
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function compactJson(value: unknown, depth: number, state: CompactState): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const redacted = redactText(value);
    state.redacted ||= redacted.redacted;
    return redacted.value;
  }
  if (typeof value !== "object") return null;
  if (depth >= MAX_RESULT_DEPTH) {
    state.truncated = true;
    return "[max depth]";
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactJson(item, depth + 1, state));
    if (value.length > MAX_ARRAY_ITEMS) {
      state.truncated = true;
      kept.push(`[+${value.length - MAX_ARRAY_ITEMS} items omitted]`);
    }
    return kept;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, unknown> = {};
  for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
    const outwardKey = sanitizeText(key);
    state.redacted ||= outwardKey.redacted;
    state.truncated ||= outwardKey.truncated;
    if (Object.hasOwn(output, outwardKey.value)) {
      state.truncated = true;
      continue;
    }
    if (sensitiveKey(key)) {
      output[outwardKey.value] = "[REDACTED]";
      state.redacted = true;
    } else {
      output[outwardKey.value] = compactJson(child, depth + 1, state);
    }
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    const marker = `[+${entries.length - MAX_OBJECT_KEYS} items omitted]`;
    if (!Object.hasOwn(output, marker)) output[marker] = marker;
    state.truncated = true;
  }
  return output;
}

interface RunEventProjectionState {
  redacted: boolean;
  truncated: boolean;
}

function projectText(value: string, state: RunEventProjectionState): string {
  const projected = sanitizeText(value);
  state.redacted ||= projected.redacted;
  state.truncated ||= projected.truncated;
  return projected.value;
}

function projectValue(value: unknown, state: RunEventProjectionState): RunEventValueProjection {
  const compactState: CompactState = { redacted: false, truncated: false };
  const compact = compactJson(value, 0, compactState);
  const serialized = JSON.stringify(compact) ?? "null";
  const preview = truncateUtf8(serialized, MAX_OBSERVABILITY_SCALAR_BYTES);
  const projection = {
    preview,
    redacted: compactState.redacted,
    truncated: compactState.truncated || preview !== serialized,
  };
  state.redacted ||= projection.redacted;
  state.truncated ||= projection.truncated;
  return projection;
}

function projectAgentUsage(usage: AgentUsage): AgentUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.total,
    cost: usage.cost,
  };
}

function projectTokenUsage(usage: TokenUsage): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.total,
    cost: usage.cost,
    ...(usage.cacheRead === undefined ? {} : { cacheRead: usage.cacheRead }),
    ...(usage.cacheWrite === undefined ? {} : { cacheWrite: usage.cacheWrite }),
  };
}

function projectProvenance(
  provenance: AgentResultProvenance,
  state: RunEventProjectionState,
): AgentResultProvenance {
  if (provenance.source === "live") {
    return {
      source: "live",
      ...(provenance.overrideModel === undefined
        ? {}
        : { overrideModel: projectText(provenance.overrideModel, state) }),
      ...(provenance.continuation === undefined
        ? {}
        : { continuation: provenance.continuation }),
    };
  }
  return {
    source: "replay",
    ...(provenance.recordedRunId === undefined
      ? {}
      : { recordedRunId: projectText(provenance.recordedRunId, state) }),
    ...(provenance.recordedIndex === undefined ? {} : { recordedIndex: provenance.recordedIndex }),
    ...(provenance.hashMatched === undefined ? {} : { hashMatched: provenance.hashMatched }),
  };
}

function projectAuthContext(
  context: AuthErrorContext,
  state: RunEventProjectionState,
): AuthErrorContext {
  const methods = context.methods.slice(0, MAX_OBJECT_KEYS).map((method) => ({
    id: projectText(method.id, state),
    type: method.type,
    ...(method.name === undefined ? {} : { name: projectText(method.name, state) }),
  }));
  state.truncated ||= context.methods.length > MAX_OBJECT_KEYS;
  return {
    ...(context.backendId === undefined ? {} : { backendId: projectText(context.backendId, state) }),
    methods,
  };
}

function projectCheckpointContext(
  context: CheckpointContext,
  state: RunEventProjectionState,
): RunEventCheckpointProjection {
  const choices = context.choices?.slice(0, MAX_OBJECT_KEYS).map((choice) => projectText(choice, state));
  state.truncated ||= (context.choices?.length ?? 0) > MAX_OBJECT_KEYS;
  return {
    callIndex: context.callIndex,
    hash: context.hash,
    prompt: projectText(context.prompt, state),
    kind: context.kind,
    ...(choices === undefined ? {} : { choices }),
    ...(context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
  };
}

function projectRecordedError(
  error: WorkflowRecordedError,
  state: RunEventProjectionState,
): RunEventErrorProjection {
  return {
    form: error.form,
    ...(error.name === undefined ? {} : { name: projectText(error.name, state) }),
    ...(error.message === undefined ? {} : { message: projectText(error.message, state) }),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.recoverable === undefined ? {} : { recoverable: error.recoverable }),
    ...(error.agentLabel === undefined ? {} : { agentLabel: projectText(error.agentLabel, state) }),
    ...(error.details === undefined ? {} : { details: projectValue(error.details, state) }),
    ...(error.resetHint === undefined ? {} : { resetHint: projectText(error.resetHint, state) }),
    ...(error.providerUsageLimitContext === undefined
      ? {}
      : {
          providerUsageLimitContext: {
            backendId: projectText(error.providerUsageLimitContext.backendId, state),
            source: error.providerUsageLimitContext.source,
            ...(error.providerUsageLimitContext.providerCode === undefined
              ? {}
              : { providerCode: projectText(error.providerUsageLimitContext.providerCode, state) }),
            ...(error.providerUsageLimitContext.resetAt === undefined
              ? {}
              : { resetAt: projectText(error.providerUsageLimitContext.resetAt, state) }),
          },
        }),
    ...(error.authContext === undefined ? {} : { authContext: projectAuthContext(error.authContext, state) }),
    ...(error.checkpointContext === undefined
      ? {}
      : { checkpointContext: projectCheckpointContext(error.checkpointContext, state) }),
    ...(error.props === undefined ? {} : { props: projectValue(error.props, state) }),
    ...(error.value === undefined ? {} : { value: projectValue(error.value, state) }),
    ...(error.lossy === undefined ? {} : { lossy: error.lossy }),
  };
}

function projectConfigOptions(
  options: Record<string, string | boolean>,
  state: RunEventProjectionState,
): Record<string, string | boolean> {
  const entries = Object.entries(options).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  state.truncated ||= entries.length > MAX_OBJECT_KEYS;
  const projected: Record<string, string | boolean> = {};
  for (const [key, value] of entries.slice(0, MAX_OBJECT_KEYS)) {
    const projectedKey = projectText(key, state);
    if (Object.hasOwn(projected, projectedKey)) {
      state.truncated = true;
      continue;
    }
    if (sensitiveKey(key)) {
      projected[projectedKey] = "[REDACTED]";
      state.redacted = true;
    } else {
      projected[projectedKey] = typeof value === "string" ? projectText(value, state) : value;
    }
  }
  return projected;
}

function projectCallRecord(
  record: WorkflowCallRecord,
  state: RunEventProjectionState,
): Extract<PersistedRunEvent, { type: "callRecord" }>["record"] {
  return {
    index: record.index,
    kind: record.kind,
    hash: record.hash,
    ...(record.path === undefined ? {} : { path: projectText(record.path, state) }),
    ...(record.inputsHash === undefined ? {} : { inputsHash: record.inputsHash }),
    ...(record.label === undefined ? {} : { label: projectText(record.label, state) }),
    outcome: record.outcome,
    origin: record.origin,
    ...(record.error === undefined ? {} : { error: projectRecordedError(record.error, state) }),
    ...(record.aborted === undefined ? {} : { aborted: record.aborted }),
    ...(record.attempts === undefined ? {} : { attempts: record.attempts }),
    ...(record.usage === undefined ? {} : { usage: projectAgentUsage(record.usage) }),
    ...(record.modelRequested === undefined
      ? {}
      : { modelRequested: projectText(record.modelRequested, state) }),
    ...(record.modeRequested === undefined
      ? {}
      : { modeRequested: projectText(record.modeRequested, state) }),
    ...(record.configOptionsRequested === undefined
      ? {}
      : { configOptionsRequested: projectConfigOptions(record.configOptionsRequested, state) }),
    ...(record.modelResolved === undefined
      ? {}
      : { modelResolved: projectText(record.modelResolved, state) }),
    ...(record.backendId === undefined ? {} : { backendId: projectText(record.backendId, state) }),
    ...(record.worktree === undefined ? {} : { worktree: record.worktree }),
    ...(record.isolation === undefined ? {} : { isolation: record.isolation }),
    ...(record.resolvedCwd === undefined ? {} : { resolvedCwd: projectText(record.resolvedCwd, state) }),
    ...(record.settlementOrdinal === undefined ? {} : { settlementOrdinal: record.settlementOrdinal }),
    ...(record.provenance === undefined ? {} : { provenance: projectProvenance(record.provenance, state) }),
    ...(record.scope === undefined ? {} : { scope: projectText(record.scope, state) }),
  };
}

function projectOrigin(event: PersistableEngineRunEvent, state: RunEventProjectionState) {
  return {
    runId: projectText(event.runId, state),
    scope: projectText(event.scope, state),
  };
}

/** Build the bounded, redacted record body written to a structured run-event log. */
export function projectRunEventForPersistence(
  event: PersistableEngineRunEvent,
): Omit<RunEventLogRecord, "streamId" | "seq" | "timestamp"> {
  const state: RunEventProjectionState = { redacted: false, truncated: false };
  const runId = projectText(event.runId, state);
  const origin = () => projectOrigin(event, state);
  let projected: PersistedRunEvent;

  switch (event.type) {
    case "log":
      projected = { type: "log", ...origin(), message: projectText(event.message, state) };
      break;
    case "phase":
      projected = { type: "phase", ...origin(), title: projectText(event.title, state) };
      break;
    case "agentStart":
      projected = {
        type: "agentStart",
        ...origin(),
        label: projectText(event.label, state),
        ...(event.phase === undefined ? {} : { phase: projectText(event.phase, state) }),
        prompt: projectText(event.prompt, state),
        ...(event.model === undefined ? {} : { model: projectText(event.model, state) }),
        ...(event.configOptions === undefined
          ? {}
          : { configOptions: projectConfigOptions(event.configOptions, state) }),
        callIndex: event.callIndex,
        // Never truncated: a partial call-path key is worse than none for consumers that
        // join on it, so an oversized capture is dropped instead of projected.
        ...(event.path === undefined || Buffer.byteLength(event.path, "utf8") > MAX_OBSERVABILITY_SCALAR_BYTES
          ? {}
          : { path: event.path }),
      };
      break;
    case "agentEnd": {
      projected = {
        type: "agentEnd",
        ...origin(),
        label: projectText(event.label, state),
        ...(event.phase === undefined ? {} : { phase: projectText(event.phase, state) }),
        result: projectValue(event.result, state),
        ...(event.tokens === undefined ? {} : { tokens: event.tokens }),
        ...(event.worktree === undefined ? {} : { worktree: projectText(event.worktree, state) }),
        ...(event.model === undefined ? {} : { model: projectText(event.model, state) }),
        ...(event.error === undefined ? {} : { error: projectText(event.error, state) }),
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        ...(event.recoverable === undefined ? {} : { recoverable: event.recoverable }),
        callIndex: event.callIndex,
        ...(event.usage === undefined ? {} : { usage: projectAgentUsage(event.usage) }),
        ...(event.modelResolved === undefined
          ? {}
          : { modelResolved: projectText(event.modelResolved, state) }),
        ...(event.backendId === undefined ? {} : { backendId: projectText(event.backendId, state) }),
        ...(event.provenance === undefined ? {} : { provenance: projectProvenance(event.provenance, state) }),
        ...(event.errorRecord === undefined
          ? {}
          : { errorRecord: projectRecordedError(event.errorRecord, state) }),
      };
      break;
    }
    case "tokenUsage":
      projected = { type: "tokenUsage", ...origin(), usage: projectTokenUsage(event.usage) };
      break;
    case "complete":
      projected = {
        type: "complete",
        ...origin(),
        summary: {
          status: "completed",
          workflowName: projectText(event.result.meta.name, state),
          agentCount: event.result.agentCount,
          durationMs: event.result.durationMs,
          phaseCount: event.result.phases.length,
          callCount: event.result.calls?.length ?? 0,
          ...(event.result.tokenUsage === undefined ? {} : { tokenUsage: projectTokenUsage(event.result.tokenUsage) }),
          result: projectValue(event.result.result, state),
        },
      };
      break;
    case "journal":
      projected = {
        type: "journal",
        ...origin(),
        entry: {
          index: event.entry.index,
          hash: event.entry.hash,
          result: projectValue(event.entry.result, state),
          ...(event.entry.call === undefined
            ? {}
            : event.entry.call.kind === "agent"
              ? {
                  call: {
                    kind: "agent" as const,
                    label: projectText(event.entry.call.label, state),
                    ...(event.entry.call.phase === undefined
                      ? {}
                      : { phase: projectText(event.entry.call.phase, state) }),
                    ...(event.entry.call.model === undefined
                      ? {}
                      : { model: projectText(event.entry.call.model, state) }),
                    ...(event.entry.call.backendId === undefined
                      ? {}
                      : { backendId: projectText(event.entry.call.backendId, state) }),
                    ...(event.entry.call.continuation === undefined
                      ? {}
                      : { continuation: event.entry.call.continuation }),
                  },
                }
              : {
                  call: {
                    kind: "checkpoint" as const,
                    label: projectText(event.entry.call.label, state) as "checkpoint",
                    ...(event.entry.call.phase === undefined
                      ? {}
                      : { phase: projectText(event.entry.call.phase, state) }),
                  },
                }),
          ...(event.entry.kind === undefined ? {} : { kind: event.entry.kind }),
          ...(event.entry.usage === undefined ? {} : { usage: projectAgentUsage(event.entry.usage) }),
          ...(event.entry.scope === undefined ? {} : { scope: projectText(event.entry.scope, state) }),
        },
      };
      break;
    case "callRecord":
      projected = { type: "callRecord", ...origin(), record: projectCallRecord(event.record, state) };
      break;
    case "paused":
      // One case per reason, so a new reason fails to compile here until it has its own.
      switch (event.reason) {
        case "requested":
        case "step_failed":
        case "step_stopped":
        case "time_limit":
        case "budget":
          projected = {
            type: "paused",
            ...origin(),
            reason: event.reason,
            errorRecord: projectRecordedError(event.errorRecord, state),
          };
          break;
        case "usage_limit":
          projected = {
            type: "paused",
            ...origin(),
            reason: "usage_limit",
            errorRecord: projectRecordedError(event.errorRecord, state),
            ...(event.resetHint === undefined ? {} : { resetHint: projectText(event.resetHint, state) }),
          };
          break;
        case "auth_required":
          projected = {
            type: "paused",
            ...origin(),
            reason: "auth_required",
            errorRecord: projectRecordedError(event.errorRecord, state),
            ...(event.authContext === undefined ? {} : { authContext: projectAuthContext(event.authContext, state) }),
          };
          break;
        case "checkpoint_required":
          projected = {
            type: "paused",
            ...origin(),
            reason: "checkpoint_required",
            errorRecord: projectRecordedError(event.errorRecord, state),
            ...(event.checkpointContext === undefined
              ? {}
              : { checkpointContext: projectCheckpointContext(event.checkpointContext, state) }),
          };
          break;
        default: {
          const exhaustive: never = event;
          throw new TypeError(`Unsupported pause reason ${(exhaustive as { reason?: unknown }).reason as string}`);
        }
      }
      break;
    case "error":
      projected = {
        type: "error",
        ...origin(),
        errorRecord: projectRecordedError(event.errorRecord, state),
      };
      break;
    case "stopped":
      projected = { type: "stopped", ...origin() };
      break;
    case "resumed":
      projected = { type: "resumed", ...origin() };
      break;
    default: {
      const exhaustive: never = event;
      throw new TypeError(`Unsupported run event ${(exhaustive as { type?: unknown }).type as string}`);
    }
  }

  return {
    version: 1,
    runId,
    event: projected,
    projection: { redacted: state.redacted, truncated: state.truncated },
  };
}

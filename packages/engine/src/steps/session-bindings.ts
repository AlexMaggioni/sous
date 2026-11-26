import type { AgentSessionRecord } from "../workflow-result.js";
import type { PersistedRunState, RunLease, RunPersistence } from "../runs/persistence/run-persistence.js";
import type { AttemptSessionEvent } from "./attempt-sessions.js";

interface SessionOwner {
  runId: string;
  status: string;
  lease?: RunLease;
  controller: AbortController;
  snapshot: { agents: Array<{ scope?: string; callIndex?: number; status: string; label: string }> };
  activeAgentSessions?: Map<string, { scope: string; attempt: number; session?: AgentSessionRecord }>;
}

export function releaseSessionLease(owner: SessionOwner, persistence: RunPersistence,
  failStop?: (error: Error) => never): void {
  owner.activeAgentSessions?.clear();
  const lease = owner.lease;
  owner.lease = undefined;
  if (!lease) return;
  try {
    persistence.releaseRunLease(lease);
    if (!failStop || !persistence.validateRunLease(lease)) return;
    throw new Error(`lease for ${owner.runId} remains owned after release`);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    owner.controller.abort(failure);
    if (failStop) failStop(failure);
    throw failure;
  }
}

/** Persistence is supplied by the owner. A failed update revokes its execution before the
 * callback can return to an adapter, even one that catches callback errors. */
export function recordSessionBinding(owner: SessionOwner, event: AttemptSessionEvent,
  enabled: boolean, save: () => void, release: () => void): void {
  if (!enabled) return;
  try { updateSessionBinding(owner, event, save); }
  catch (error) {
    try { release(); }
    finally { owner.controller.abort(error); }
    throw error;
  }
}

function updateSessionBinding(owner: SessionOwner, event: AttemptSessionEvent, save: () => void): void {
  const key = JSON.stringify([event.scope, event.callIndex]);
  const current = owner.activeAgentSessions?.get(key);
  if (event.state === "closed") {
    if (current?.attempt !== event.attempt) return;
    owner.activeAgentSessions!.delete(key);
    if (owner.status === "running" && owner.lease) save();
    return;
  }
  if (owner.status !== "running" || owner.controller.signal.aborted) return;
  const step = owner.snapshot.agents.find(candidate => candidate.scope === event.scope
    && candidate.callIndex === event.callIndex && candidate.status === "running");
  if (!step || step.label !== event.label) return;
  const bindings = owner.activeAgentSessions ??= new Map();
  if (event.state === "starting") {
    bindings.set(key, { scope: event.scope, attempt: event.attempt });
    save();
    return;
  }
  if (current?.attempt !== event.attempt || !event.session) return;
  if (current.session) {
    delete current.session;
    save();
  }
  current.session = event.session;
  save();
}

export function persistedSessionBindings(owner: SessionOwner, pid: number):
  Pick<PersistedRunState, "activeAgentSessions"> {
  if (owner.status !== "running" || !owner.lease || !owner.activeAgentSessions?.size) return {};
  return { activeAgentSessions: {
    leaseToken: owner.lease.token, pid,
    entries: [...owner.activeAgentSessions.values()].flatMap(entry => entry.session
      ? [{ scope: entry.scope, attempt: entry.attempt, session: entry.session }] : []),
  } };
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

export function isContinuationSession(
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


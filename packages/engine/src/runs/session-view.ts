import type { AgentSessionRecord } from "../workflow-result.js";
import type { PersistedAgentState, PersistedRunState } from "./persistence/run-persistence.js";
import type { RunRecord } from "./records.js";

export function currentSessionSteps(steps: PersistedAgentState[], bindings: Map<string, AgentSessionRecord>,
  keyFor: (scope: unknown, callIndex: unknown) => string): PersistedAgentState[] {
  return steps.map(step => {
    if (step.status !== "running") return step;
    // A historical result is never evidence for the current attempt.
    const { session: _historical, ...current } = step;
    const session = bindings.get(keyFor(step.scope, step.callIndex));
    return session?.label === step.label ? { ...current, session } : current;
  });
}

export function publicSessionState(state: PersistedRunState, steps: PersistedAgentState[]):
  Omit<PersistedRunState, "script" | "journal" | "nestedJournal" | "calls" | "activeAgentSessions"> {
  const { script: _script, journal: _journal, nestedJournal: _nested, calls: _calls,
    activeAgentSessions: _active, ...rest } = state;
  return { ...rest, agents: steps };
}

/** Pure projection of a primary snapshot. The caller supplies the process/lease check. */
export function validatedActiveSessions(primary: PersistedRunState, record: RunRecord,
  state: PersistedRunState, ownsLease: (owner: NonNullable<PersistedRunState["activeAgentSessions"]>) => boolean,
  keyFor: (scope: string, callIndex: number) => string): Map<string, AgentSessionRecord> {
  const sessions = new Map<string, AgentSessionRecord>();
  if (primary?.runId !== record.runId || primary.status !== "running") return sessions;
  const owner = primary.activeAgentSessions;
  if (state.status !== "running" || !owner || owner.pid !== record.pid
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.leaseToken !== "string" || !owner.leaseToken
    || !Array.isArray(owner.entries) || owner.entries.length > 1_000) return sessions;
  if (!ownsLease(owner)) return sessions;
  for (const entry of owner.entries) {
    if (!entry || typeof entry.scope !== "string" || !entry.scope
      || !Number.isSafeInteger(entry.attempt) || entry.attempt < 1
      || !validActiveSession(entry.session)) continue;
    const key = keyFor(entry.scope, entry.session.callIndex);
    // Ambiguous bindings are not evidence, even when each row looks valid on its own.
    if (sessions.has(key)) return new Map();
    const ref = entry.session;
    sessions.set(key, {
      sessionId: ref.sessionId, backendId: ref.backendId, cwd: ref.cwd,
      callIndex: ref.callIndex, label: ref.label, keptOpen: ref.keptOpen,
      reopen: { load: ref.reopen.load, resume: ref.reopen.resume, list: ref.reopen.list,
        ...(typeof ref.reopen.fork === "boolean" ? { fork: ref.reopen.fork } : {}) },
      ...(typeof ref.poolKey === "string" ? { poolKey: ref.poolKey } : {}),
      ...(typeof ref.phase === "string" ? { phase: ref.phase } : {}),
      ...(typeof ref.model === "string" ? { model: ref.model } : {}),
      ...(typeof ref.costGauge === "number" && Number.isFinite(ref.costGauge)
        ? { costGauge: ref.costGauge } : {}),
      ...(ref.initializeMeta && typeof ref.initializeMeta === "object"
        && !Array.isArray(ref.initializeMeta) ? { initializeMeta: ref.initializeMeta } : {}),
    });
  }
  return sessions;
}

function validActiveSession(value: unknown): value is AgentSessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Partial<AgentSessionRecord>;
  return typeof ref.sessionId === "string" && ref.sessionId.length > 0
    && typeof ref.backendId === "string" && ref.backendId.length > 0
    && typeof ref.cwd === "string" && ref.cwd.length > 0
    && Number.isSafeInteger(ref.callIndex) && ref.callIndex! >= 0
    && typeof ref.label === "string" && typeof ref.keptOpen === "boolean"
    && ref.reopen !== null && typeof ref.reopen === "object"
    && typeof ref.reopen.load === "boolean" && typeof ref.reopen.resume === "boolean"
    && typeof ref.reopen.list === "boolean";
}

/** A step's key: its scope and its call. Retries of a step happen inside the one call. */
export function stepKey(record: RunRecord, scope: unknown, callIndex: unknown): string {
  return `${typeof scope === "string" ? scope : record.runId}#${String(callIndex)}`;
}


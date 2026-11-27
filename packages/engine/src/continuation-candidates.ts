/**
 * The interrupted agent calls a resume goes on with in their own sessions. A turn goes on in its
 * session whatever stopped it: the person, a budget pause, a time limit, the usage limit, a lost
 * login or a kill. So any pause reason but a failed step, and any error code, gives a candidate, in
 * the run and in its nested runs. Bad saved rows can only remove a candidate. They never make a
 * resume throw.
 */

import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { projectRecordedError } from "./recorded-error.js";
import { continuationKey, type ContinuationCandidate, type PreparedContinuation } from "./resume.js";
import type { PersistedAgentState, PersistedRunState } from "./runs/persistence/run-persistence.js";
import type { AgentSessionRecord, WorkflowCallRecord } from "./workflow-result.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function isContinuationSession(value: unknown): value is AgentSessionRecord & { cwd?: string } {
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
    (value.delivered === undefined || typeof value.delivered === "boolean") &&
    isNonNegativeSafeInteger(value.callIndex) &&
    typeof value.label === "string" &&
    isOptionalString(value, "phase") &&
    typeof value.keptOpen === "boolean"
  );
}

/** The scope of a saved row: its own, or the run's when it has none (an old save). */
function scopeOf(row: Record<string, unknown>, runId: string): string | undefined {
  if (row.scope === undefined) return runId;
  return typeof row.scope === "string" ? row.scope : undefined;
}

/** The sessions of the agent calls that ended in an error, by scope and call index. */
function erroredSessions(persisted: PersistedRunState): Map<string, AgentSessionRecord & { cwd?: string }> {
  const sessions = new Map<string, AgentSessionRecord & { cwd?: string }>();
  for (const value of Array.isArray(persisted.agents) ? persisted.agents : []) {
    if (!isRecord(value) || value.status !== "error") continue;
    const scope = scopeOf(value, persisted.runId);
    if (scope === undefined || !isNonNegativeSafeInteger(value.callIndex)) continue;
    if (!isContinuationSession(value.session) || value.session.callIndex !== value.callIndex) continue;
    // A session whose program never had the prompt does not hold the task. The step runs again.
    if (value.session.delivered === false) continue;
    sessions.set(continuationKey(scope, value.callIndex), value.session);
  }
  return sessions;
}

/** The candidate of one saved call row, when its agent's session can go on. */
function candidateOf(record: Record<string, unknown>, joined: AgentSessionRecord & { cwd?: string }, callIndex: number): ContinuationCandidate | undefined {
  if (record.kind !== "agent" || record.outcome !== "error" || typeof record.hash !== "string") return undefined;
  if (record.inputsHash !== undefined && typeof record.inputsHash !== "string") return undefined;
  if (typeof record.backendId !== "string" || joined.backendId !== record.backendId) return undefined;
  if (record.resolvedCwd !== undefined && typeof record.resolvedCwd !== "string") return undefined;
  if (joined.cwd !== undefined && record.resolvedCwd !== undefined && joined.cwd !== record.resolvedCwd) return undefined;
  if (joined.reopen.resume !== true && joined.reopen.load !== true) return undefined;
  const recordedCwd = record.resolvedCwd ?? joined.cwd;
  if (typeof recordedCwd !== "string") return undefined;
  return {
    callIndex,
    hash: record.hash,
    ...(typeof record.inputsHash === "string" ? { inputsHash: record.inputsHash } : {}),
    sessionRef: joined,
    recordedCwd,
  };
}

/**
 * The candidates of a paused run, or undefined when it has none. A run paused because a step
 * failed has none: the failed step runs its own prompt again, with the note when there is one.
 */
export function continuationCandidates(persisted: PersistedRunState): PreparedContinuation | undefined {
  if (!isRecord(persisted) || persisted.status !== "paused" || typeof persisted.runId !== "string") return undefined;
  if (persisted.pauseReason === "step_failed") return undefined;
  const sessions = erroredSessions(persisted);
  // The last saved row of each call is the one that counts.
  const rows = new Map<string, { record: Record<string, unknown>; index: number }>();
  for (const value of Array.isArray(persisted.calls) ? persisted.calls : []) {
    if (!isRecord(value) || !isNonNegativeSafeInteger(value.index)) continue;
    const scope = scopeOf(value, persisted.runId);
    if (scope !== undefined) rows.set(continuationKey(scope, value.index), { record: value, index: value.index });
  }
  const candidates = new Map<string, ContinuationCandidate>();
  for (const [key, { record, index }] of rows) {
    const joined = sessions.get(key);
    const candidate = joined ? candidateOf(record, joined, index) : undefined;
    if (candidate) candidates.set(key, candidate);
  }
  return candidates.size === 0 ? undefined : { candidates };
}

const DEAD_STEP = "The process running the step ended before the step did.";

/**
 * The steps and call rows of a run whose process died, with each step it left running settled as
 * an error. A step that saved its session and its call's identity also gets an error call row, so
 * continuationCandidates pairs the two and a resume goes on in the session. A step with a call row
 * already, or with no call index, stays as it is.
 */
export function settleDeadSteps(state: PersistedRunState, at: string): Pick<PersistedRunState, "agents" | "calls"> {
  const calls: WorkflowCallRecord[] = Array.isArray(state.calls) ? [...state.calls] : [];
  let pushed = false;
  const rowed = new Set(calls.map((row: unknown) => (isRecord(row) ? continuationKey(scopeOf(row, state.runId) ?? "", Number(row.index)) : "")));
  const code = WorkflowErrorCode.AGENT_EXECUTION_ERROR;
  const settle = (row: PersistedAgentState): PersistedAgentState => {
    const scope = isRecord(row) ? scopeOf(row, state.runId) : undefined;
    if (scope === undefined || row.status !== "running" || !isNonNegativeSafeInteger(row.callIndex)) return row;
    if (rowed.has(continuationKey(scope, row.callIndex))) return row;
    const { call, ...settled } = row;
    if (isRecord(call) && typeof call.hash === "string" && isContinuationSession(row.session)) {
      pushed = true;
      calls.push({
        index: row.callIndex,
        kind: "agent",
        hash: call.hash,
        ...(typeof call.path === "string" ? { path: call.path } : {}),
        ...(typeof call.inputsHash === "string" ? { inputsHash: call.inputsHash } : {}),
        label: row.label,
        outcome: "error",
        origin: "engine",
        error: projectRecordedError(new WorkflowError(DEAD_STEP, code, { recoverable: true, agentLabel: row.label })),
        backendId: row.session.backendId,
        ...(typeof call.resolvedCwd === "string" ? { resolvedCwd: call.resolvedCwd } : {}),
        scope,
      });
    }
    return { ...settled, status: "error", error: DEAD_STEP, errorCode: code, recoverable: true, endedAt: at };
  };
  const agents = Array.isArray(state.agents) ? state.agents.map(settle) : state.agents;
  return { agents, ...(pushed ? { calls } : {}) };
}

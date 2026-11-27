// The run's map from a session key to its session, as the engine keeps it between a handle's
// turns. workflow.ts owns the map. These functions read and change one entry: ending a session's
// program, copying a parent's entry for fork(), and the session's cost after a turn.

import type { AgentRunner } from "../steps/agent-runner.js";
import type { AgentSessionRecord, AgentSessionRef } from "../workflow-result.js";

/** What the run's map holds for a session key: the session, the hash of its last turn, and the
 *  cost its turns recorded, which a kept turn's program reports again in its total. */
export interface SessionEntry {
  ref?: AgentSessionRef;
  lastHash: string;
  cost: number;
  /** Set while the entry is a fork's copy of its parent's session, until the fork's own turn settles. */
  forked?: true;
}

/** Ends a session's step: the runner closes the program the step's turns kept open. A fork's
 *  copy names its parent's session, whose program is the parent's to close. */
export const endSession = (sessions: Map<string, SessionEntry>, runner: AgentRunner) => async (key: string) => {
  const entry = sessions.get(key);
  const sessionId = entry?.forked ? undefined : entry?.ref?.sessionId;
  if (sessionId !== undefined) await runner.release?.(sessionId);
};

/** Starts the session `key` as a copy of the session `from`, for fork(). The fork's cost starts
 *  at nothing: its program counts its own total. False when `from` has no session yet. */
export const forkSession = (sessions: Map<string, SessionEntry>) => (from: string, key: string): boolean => {
  const parent = sessions.get(from);
  if (!parent?.ref) return false;
  sessions.set(key, { ref: parent.ref, lastHash: parent.lastHash, cost: 0, forked: true });
  return true;
};

/**
 * A session's cost so far after a turn. That is the program's own total for the session when it
 * gave one. Without it, the turn's cost: a kept turn's every attempt ran in the session, and a
 * fresh turn's earlier attempts ran in sessions of their own, so only its last attempt counts.
 */
export function sessionCost(ref: AgentSessionRecord | undefined, kept: SessionEntry | undefined, spent: number | undefined, lastAttempt: number | undefined): number {
  const gauge = ref?.costGauge;
  if (typeof gauge === "number" && Number.isFinite(gauge)) return gauge;
  return kept?.ref ? kept.cost + (spent ?? 0) : (lastAttempt ?? spent ?? 0);
}

/** A session as the map keeps it: the ref, without the record's call fields and its gauge. */
export function sessionRefOf(record: AgentSessionRef): AgentSessionRef {
  const { costGauge: _gauge, callIndex: _index, label: _label, phase: _phase, keptOpen: _kept, ...ref } = record as AgentSessionRecord;
  return ref;
}

// The rows a resumed run pairs with, read from a saved run. Each scope, the run itself or one of
// its nested runs, gets its own rows: the run's own rows first, by index, then the rows of its
// seed that no own row replayed.
//
// Internal: not exported from index.ts.

import { cloneResumeCallBlocker, cloneResumeCandidate, normalizeResumeSeed } from "./resume-matcher.js";
import { isNestedScope, resumeOccurrenceKey } from "./resume-identity.js";
import type { RecordedCall, RecordedScope } from "./resume-pairing.js";
import type {
  PersistedResumeCallBlocker,
  PersistedResumeCandidate,
  PersistedResumeSeed,
} from "./runs/persistence/run-persistence.js";
import type { JournalEntry, WorkflowCallRecord } from "./workflow-result.js";

/** A recorded call, with what a replay needs. */
export interface ResumeRow extends RecordedCall {
  /** The run that recorded it. For an own row, the scope's own id. */
  sourceRunId: string;
  /** The journal row of a result. */
  entry?: JournalEntry;
  /** A seed row's call row. Own rows leave it out, so a replay of one looks as it always has. */
  call?: WorkflowCallRecord;
  /** A seed's answer to a question. */
  injected?: true;
  /** The row is in this run's journal already, at its index. */
  own?: true;
}

/** The rows of each scope, by the scope's run id. */
export type ResumeRows = ReadonlyMap<string, RecordedScope<ResumeRow>>;

/** The latest row of each scope and index. */
function byScope<T extends { index: number; scope?: string }>(rows: readonly T[], runId: string): Map<string, Map<number, T>> {
  const scopes = new Map<string, Map<number, T>>();
  for (const row of rows) {
    const scope = row.scope ?? runId;
    if (scope !== runId && !isNestedScope(scope, runId)) continue;
    let indexes = scopes.get(scope);
    if (!indexes) scopes.set(scope, (indexes = new Map()));
    indexes.set(row.index, row);
  }
  return scopes;
}

/**
 * Whether a journal row is a result. It is while the call row at its index returned it, or while
 * its index has no call row: a run saved before call rows wrote it, and a resume replays it. Under
 * any other call row it is stale, since a later call took its index.
 */
export function isResult(entry: JournalEntry, call: WorkflowCallRecord | undefined): boolean {
  return call === undefined || (call.outcome === "result" && call.hash === entry.hash);
}

/**
 * One scope's own rows, by index. A journal row that is a result gives a result row. Any other
 * call row is a failed row: the call failed or stopped, or its result was never saved. A replay
 * that moved a row to another index took it from its old index already, in the run's rows.
 */
function ownRows(scope: string, journal: Map<number, JournalEntry>, calls: Map<number, WorkflowCallRecord>): ResumeRow[] {
  const rows: ResumeRow[] = [];
  const indexes = [...new Set([...journal.keys(), ...calls.keys()])].sort((a, b) => a - b);
  for (const index of indexes) {
    const entry = journal.get(index);
    const call = calls.get(index);
    const result = entry !== undefined && isResult(entry, call);
    if (call && !result) {
      rows.push({
        index, kind: call.kind, hash: call.hash,
        ...(call.inputsHash !== undefined ? { inputsHash: call.inputsHash } : {}),
        outcome: "failed", sourceRunId: scope,
      });
    }
    if (result) {
      const kind = call?.kind ?? entry.kind;
      rows.push({
        index,
        ...(kind !== undefined ? { kind } : {}),
        hash: entry.hash,
        ...(call?.inputsHash !== undefined ? { inputsHash: call.inputsHash } : {}),
        outcome: "result", sourceRunId: scope, entry, own: true,
      });
    }
  }
  return rows;
}

/** The current run's scope for a seed row's scope, or none for a row outside its source run. */
function seedScope(scope: string, sourceRunId: string, runId: string): string | undefined {
  if (scope === sourceRunId) return runId;
  return isNestedScope(scope, sourceRunId) ? runId + scope.slice(sourceRunId.length) : undefined;
}

/** The seed rows an own call row replayed, by scope, run and index. */
function usedSeedRows(calls: readonly WorkflowCallRecord[], runId: string): Set<string> {
  const used = new Set<string>();
  for (const call of calls) {
    if (call.replay) used.add(`${call.scope ?? runId}\u0000${resumeOccurrenceKey(call.replay.sourceRunId, call.replay.recordedIndex)}`);
  }
  return used;
}

/**
 * The seed without the rows the run's own call rows replayed. None when nothing is left, or when
 * a row does not read as a seed row.
 */
export function unusedSeed(
  seed: PersistedResumeSeed | undefined,
  calls: readonly WorkflowCallRecord[],
  runId: string,
): PersistedResumeSeed | undefined {
  if (seed?.format !== "identity-v1") return undefined;
  const used = usedSeedRows(calls, runId);
  const unused = (row: { sourceRunId: string; recordedIndex: number }, scope: string) => {
    const mapped = seedScope(scope, row.sourceRunId, runId);
    return mapped !== undefined && !used.has(`${mapped}\u0000${resumeOccurrenceKey(row.sourceRunId, row.recordedIndex)}`);
  };
  const remaining = normalizeResumeSeed({
    sourceRunId: seed.sourceRunId,
    retained: (seed.candidates ?? []).filter((row) => unused(row, row.call?.scope ?? row.sourceRunId)),
    retainedBlockers: (seed.callBlockers ?? []).filter((row) => unused(row, row.call?.scope ?? row.sourceRunId)),
    retainedInjections: (seed.checkpointInjections ?? []).filter((row) => unused(row, row.sourceRunId)),
  });
  const empty = remaining === undefined ||
    remaining.candidates.length + (remaining.callBlockers?.length ?? 0) + (remaining.checkpointInjections?.length ?? 0) === 0;
  return empty ? undefined : remaining;
}

/**
 * The seed of a run whose script changed, before the new version clears its journal and call
 * rows. It holds the run's own rows of each scope with call rows, with the run as their source,
 * then the rows of its seed that no own row replayed. A seed row from an earlier version at the
 * same scope and index gives way to the own row. A row with no path or inputs hash cannot be a
 * seed row, so its step runs again. None when nothing is left.
 */
export function revisionSeed(input: {
  runId: string;
  journal: readonly JournalEntry[];
  calls: readonly WorkflowCallRecord[];
  seed?: PersistedResumeSeed;
}): PersistedResumeSeed | undefined {
  const { runId } = input;
  const journal = byScope(input.journal, runId);
  const candidates: PersistedResumeCandidate[] = [];
  const blockers: PersistedResumeCallBlocker[] = [];
  for (const [scope, calls] of byScope(input.calls, runId)) {
    for (const call of [...calls.values()].sort((a, b) => a.index - b.index)) {
      const entry = journal.get(scope)?.get(call.index);
      if (call.outcome === "result") {
        if (entry === undefined || !isResult(entry, call)) continue;
        const candidate = cloneResumeCandidate(runId, { ...entry, scope }, { ...call, scope });
        if (candidate) candidates.push(candidate);
      } else {
        const blocker = cloneResumeCallBlocker(runId, { ...call, scope });
        if (blocker) blockers.push(blocker);
      }
    }
  }
  const own = new Set([...candidates, ...blockers].map((row) => resumeOccurrenceKey(row.call.scope ?? runId, row.recordedIndex)));
  const left = unusedSeed(input.seed, input.calls, runId);
  const keep = (row: { sourceRunId: string; recordedIndex: number; call?: WorkflowCallRecord }) =>
    !own.has(resumeOccurrenceKey(row.call?.scope ?? row.sourceRunId, row.recordedIndex));
  const seed = normalizeResumeSeed({
    sourceRunId: runId,
    promoted: candidates,
    promotedBlockers: blockers,
    retained: (left?.candidates ?? []).filter(keep),
    retainedBlockers: (left?.callBlockers ?? []).filter(keep),
    retainedInjections: (left?.checkpointInjections ?? []).filter(keep),
  });
  const empty = seed === undefined ||
    seed.candidates.length + (seed.callBlockers?.length ?? 0) + (seed.checkpointInjections?.length ?? 0) === 0;
  return empty ? undefined : seed;
}

/** A seed's rows, by the current run's scope, each scope in recorded index order. */
function seedRows(seed: PersistedResumeSeed | undefined, runId: string): Map<string, ResumeRow[]> {
  const scopes = new Map<string, ResumeRow[]>();
  const add = (scope: string | undefined, row: ResumeRow) => {
    if (scope === undefined) return;
    const rows = scopes.get(scope);
    if (rows) rows.push(row);
    else scopes.set(scope, [row]);
  };
  for (const { sourceRunId, recordedIndex, entry, call } of seed?.candidates ?? []) {
    add(seedScope(call.scope ?? sourceRunId, sourceRunId, runId), {
      index: recordedIndex, kind: call.kind, hash: call.hash,
      ...(call.inputsHash !== undefined ? { inputsHash: call.inputsHash } : {}),
      outcome: "result", sourceRunId, entry, call,
    });
  }
  for (const { sourceRunId, recordedIndex, call } of seed?.callBlockers ?? []) {
    add(seedScope(call.scope ?? sourceRunId, sourceRunId, runId), {
      index: recordedIndex, kind: call.kind, hash: call.hash,
      ...(call.inputsHash !== undefined ? { inputsHash: call.inputsHash } : {}),
      outcome: "failed", sourceRunId, call,
    });
  }
  for (const injection of seed?.checkpointInjections ?? []) {
    add(runId, {
      index: injection.recordedIndex, kind: "checkpoint", hash: injection.hash, inputsHash: injection.inputsHash,
      outcome: "result", sourceRunId: injection.sourceRunId,
      entry: {
        checkpointDecision: injection.checkpointDecision,
        index: injection.recordedIndex,
        hash: injection.hash,
        result: injection.decision,
        kind: "checkpoint",
      },
      injected: true,
    });
  }
  for (const rows of scopes.values()) rows.sort((a, b) => a.index - b.index);
  return scopes;
}

/**
 * The rows of every scope: the run's own rows, then the seed's. Pass the seed through
 * `unusedSeed` first.
 */
export function resumeRows(input: {
  runId: string;
  journal: readonly JournalEntry[];
  calls: readonly WorkflowCallRecord[];
  seed?: PersistedResumeSeed;
  key: RecordedScope<ResumeRow>["key"];
}): ResumeRows {
  const journal = byScope(input.journal, input.runId);
  const calls = byScope(input.calls, input.runId);
  const seed = seedRows(input.seed, input.runId);
  const scopes = new Map<string, RecordedScope<ResumeRow>>();
  for (const scope of new Set([...journal.keys(), ...calls.keys(), ...seed.keys()])) {
    const own = ownRows(scope, journal.get(scope) ?? new Map(), calls.get(scope) ?? new Map());
    scopes.set(scope, { rows: [...own, ...(seed.get(scope) ?? [])], key: input.key });
  }
  return scopes;
}

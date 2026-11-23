// A run's rows: its journal, its nested runs' journal, its call rows and its resume seed. The
// manager hands it each row the run writes, and saves what `saved` returns. It also builds the
// rows a resumed run pairs with, through resume-rows.ts. Both sides read a journal row with the
// same rule, `isResult`.
//
// Internal: not exported from index.ts.

import { isNestedScope } from "./resume-identity.js";
import { isResult, resumeRows, revisionSeed, unusedSeed, type ResumeRows } from "./resume-rows.js";
import type { PersistedResumeSeed, PersistedRunState, RunStatus } from "./runs/persistence/run-persistence.js";
import { deepFreeze } from "./strict-json.js";
import type { JournalEntry, WorkflowCallRecord } from "./workflow-result.js";

/** The rows a save writes. */
export interface SavedRows {
  journal: JournalEntry[];
  /** The nested runs' journal rows, each under its child run id. */
  nestedJournal: JournalEntry[];
  calls: WorkflowCallRecord[];
  resumeSeed?: PersistedResumeSeed;
}

/** A run's rows. Each row replaces the row of the same scope and index. */
export interface RunRows {
  /** Take a journal row of the run or of one of its nested runs. */
  journal(entry: JournalEntry): void;
  /**
   * Take a call row of the run or of one of its nested runs. A replay of the run's journal row at
   * the same index binds that row to this call. `phase` is the run's phase now, for a checkpoint.
   */
  call(record: WorkflowCallRecord, phase: string | undefined): void;
  /** The run completed. Its root call rows are the ones this execution settled. */
  completed(calls: readonly WorkflowCallRecord[]): void;
  /** The rows a save writes at this status. It changes nothing. */
  saved(status: RunStatus): SavedRows;
  /** The call rows of the run's result: all but its nested runs'. */
  resultCalls(): WorkflowCallRecord[];
}

/** A run's rows when it starts from saved rows, with the rows its first execution pairs with. */
export interface StartedRows {
  rows: RunRows;
  /** The rows of each scope the run pairs with. None when the run replays nothing. */
  resume?: ResumeRows;
  /** The first root steps the rows can replay, counted from step 0. */
  prefix: number;
}

/** The rows of a saved run that a reuse starts from. */
export interface SourceRows {
  /** The saved run. A run whose script changed is its own source. */
  sourceRunId: string;
  /** The journal rows of the run and of its nested runs. */
  journal: readonly JournalEntry[];
  calls: readonly WorkflowCallRecord[];
  seed?: PersistedResumeSeed;
  /** What a step pairs with a row on. */
  key: "inputs" | "hash";
}

/** The row fields of a saved run. */
export type SavedRunRows = Pick<PersistedRunState, "journal" | "nestedJournal" | "calls" | "resumeSeed">;

/** A new run, with no rows. */
export function newRows(runId: string): RunRows {
  return createRows({ runId });
}

/**
 * A new run over a journal its caller hands in by index. workflow.ts pairs its steps with these
 * rows. A terminal save trims the rows, as for a reuse.
 */
export function handedInRows(runId: string, journal: ReadonlyMap<number, JournalEntry>): RunRows {
  return createRows({ runId, journal: latestRows([...journal.values()]), reuse: true });
}

/**
 * A new run that reuses a saved run. Its seed holds the source's own rows, then the rows of the
 * source's seed that the source did not replay. The new run starts with no rows of its own. With
 * no source rows, the run replays nothing and starts empty.
 */
export function reuseRows(runId: string): StartedRows;
export function reuseRows(runId: string, source: SourceRows): StartedRows & { resume: ResumeRows };
export function reuseRows(runId: string, source?: SourceRows): StartedRows {
  if (!source) return { rows: createRows({ runId, reuse: true }), prefix: 0 };
  const { sourceRunId, journal, calls } = source;
  const seed = revisionSeed({ runId: sourceRunId, journal, calls, seed: source.seed });
  return {
    rows: createRows({ runId, seed, reuse: true }),
    resume: resumeRows({ runId, journal: [], calls: [], seed, key: source.key }),
    prefix: seedPrefix(seed),
  };
}

/**
 * The same run resumed with the same script. It pairs with its own rows, then with the rows its
 * seed still holds, on the kind and call hash. A replay that moves one of its own rows to
 * another index takes it from its old index.
 */
export function continueRows(runId: string, saved: SavedRunRows): { rows: RunRows; resume: ResumeRows } {
  const { journal, nestedJournal, calls } = ownSavedRows(runId, saved);
  const seed = unusedSeed(saved.resumeSeed, calls, runId);
  return {
    rows: createRows({
      runId, journal, nestedJournal, calls, seed,
      resumed: new Set([...journal, ...nestedJournal, ...calls]),
    }),
    resume: resumeRows({ runId, journal: [...journal, ...nestedJournal], calls, seed, key: "hash" }),
  };
}

/**
 * The same run resumed with a new script. The new version starts with no rows. Its seed holds
 * the rows of the version before, so a second pause keeps the steps the new version has not
 * reached.
 */
export function reviseRows(
  runId: string,
  saved: SavedRunRows,
  key: SourceRows["key"],
): StartedRows & { resume: ResumeRows } {
  const { journal, nestedJournal, calls } = ownSavedRows(runId, saved);
  return reuseRows(runId, { sourceRunId: runId, journal: [...journal, ...nestedJournal], calls, seed: saved.resumeSeed, key });
}

/** A saved run's latest rows of each scope and index, as the run reads them back. */
function ownSavedRows(runId: string, saved: SavedRunRows) {
  return {
    journal: latestRootRows(saved.journal ?? [], runId),
    nestedJournal: [...(saved.nestedJournal ?? [])],
    calls: [...latestRootRows(saved.calls ?? [], runId), ...latestNestedRows(saved.calls ?? [], runId)],
  };
}

interface Start {
  runId: string;
  journal?: JournalEntry[];
  nestedJournal?: JournalEntry[];
  calls?: WorkflowCallRecord[];
  seed?: PersistedResumeSeed;
  /** A same-ID resume's rows as it started. */
  resumed?: ReadonlySet<JournalEntry | WorkflowCallRecord>;
  /** The run starts from another execution's rows, so a terminal save trims them. */
  reuse?: true;
}

function createRows(start: Start): RunRows {
  const { runId, seed, resumed } = start;
  let journal = start.journal ?? [];
  let nestedJournal = start.nestedJournal ?? [];
  let calls = start.calls ?? [];
  const isRoot = (scope: string | undefined) => scope === undefined || scope === runId;

  /**
   * A same-ID resume can replay one of the run's own rows at another index, when steps open in
   * another order. The row then lives at the new index, so drop it from the old one. Otherwise a
   * later resume reads it twice, and gives a call that never ran the other call's result.
   */
  const dropMoved = (record: WorkflowCallRecord) => {
    const from = record.replay;
    const scope = record.scope ?? runId;
    if (!resumed || from?.sourceRunId !== scope || from.recordedIndex === record.index) return;
    const stale = (row: JournalEntry | WorkflowCallRecord) =>
      resumed.has(row) && (row.scope ?? runId) === scope && row.index === from.recordedIndex;
    journal = journal.filter((row) => !stale(row));
    nestedJournal = nestedJournal.filter((row) => !stale(row));
    calls = calls.filter((row) => !stale(row));
  };

  /** A replay of the run's journal row at the same index binds the row to the call that replayed it. */
  const rebind = (record: WorkflowCallRecord, currentPhase: string | undefined) => {
    const source = journal.find((entry) => entry.index === record.index && entry.hash === record.hash);
    if (!source) return;
    const phase = record.kind === "checkpoint" ? currentPhase : source.call?.phase;
    const label = record.kind === "agent" ? record.label ?? source.call?.label ?? "agent" : "checkpoint";
    const rebound = deepFreeze({
      ...source,
      kind: record.kind,
      scope: runId,
      ...(source.session
        ? { session: { ...source.session, callIndex: record.index, label, ...(phase === undefined ? {} : { phase }) } }
        : {}),
      call: record.kind === "agent"
        ? { ...source.call, kind: "agent" as const, label, ...(phase === undefined ? {} : { phase }) }
        : { kind: "checkpoint" as const, label: "checkpoint" as const, phase },
    } satisfies JournalEntry);
    journal = latestRows([...journal.filter((entry) => entry.index !== record.index), rebound]);
  };

  return {
    journal(entry) {
      if (isRoot(entry.scope)) journal = [...journal.filter((row) => row.index !== entry.index), entry];
      else {
        nestedJournal = [
          ...nestedJournal.filter((row) => !(row.scope === entry.scope && row.index === entry.index)),
          entry,
        ];
      }
    },
    call(record, phase) {
      dropMoved(record);
      if (isRoot(record.scope)) {
        if (record.origin === "journal-replay" && record.outcome === "result") rebind(record, phase);
        calls = [...calls.filter((row) => isNestedScope(row.scope, runId) || row.index !== record.index), record];
      } else {
        calls = [...calls.filter((row) => !(row.scope === record.scope && row.index === record.index)), record];
      }
    },
    completed(rootCalls) {
      calls = [...rootCalls, ...latestNestedRows(calls, runId)];
    },
    saved(status) {
      const terminal = status !== "running" && status !== "pending";
      const rows = terminal && start.reuse
        ? trimmed(runId, status, { journal, nestedJournal, calls, resumeSeed: seed })
        : { journal, nestedJournal, calls, resumeSeed: seed };
      // A completed run has no later steps to replay, whether or not it started as a reuse.
      if (status === "completed" || rows.resumeSeed === undefined) delete rows.resumeSeed;
      return rows;
    },
    resultCalls() {
      return calls.filter((row) => !isNestedScope(row.scope, runId));
    },
  };
}

/**
 * What a terminal save keeps of a run that started from another execution's rows: its latest call
 * rows, by index; the run's journal rows that are still results; and the seed rows it did not
 * replay, with the run as their source while it can still resume.
 */
function trimmed(runId: string, status: RunStatus, rows: SavedRows): SavedRows {
  const rootCalls = latestRows(rows.calls.filter((row) => row.scope === runId));
  const calls = [...rootCalls, ...latestNestedRows(rows.calls, runId)];
  const callAt = new Map(rootCalls.map((row) => [row.index, row] as const));
  // A row with no call at its index comes from a run saved before call rows, at a step this run
  // did not reach yet.
  const journal = latestRows(rows.journal.filter((entry) => entry.scope === runId && isResult(entry, callAt.get(entry.index))));
  let seed = unusedSeed(rows.resumeSeed, calls, runId);
  if (status !== "completed" && seed) seed = deepFreeze({ ...seed, sourceRunId: runId });
  if (seed?.checkpointInjections) {
    // A checkpoint this run asked again is answered in its own rows.
    const asked = new Set(
      rootCalls.filter((row) => row.kind === "checkpoint").map((row) => `${row.hash}\u0000${row.inputsHash ?? ""}`),
    );
    const injections = seed.checkpointInjections.filter((injection) => !asked.has(`${injection.hash}\u0000${injection.inputsHash}`));
    if (injections.length !== seed.checkpointInjections.length) {
      const { checkpointInjections: _discarded, ...rest } = seed;
      seed = deepFreeze({ ...rest, ...(injections.length === 0 ? {} : { checkpointInjections: injections }) });
    }
  }
  return { journal, nestedJournal: rows.nestedJournal, calls, resumeSeed: seed };
}

/** The first root steps a seed and the old journal rows can replay, counted from step 0. */
function seedPrefix(seed: PersistedResumeSeed | undefined): number {
  const available = new Set([
    ...(seed?.candidates ?? [])
      .filter((candidate) => (candidate.call.scope ?? candidate.sourceRunId) === candidate.sourceRunId)
      .map((candidate) => candidate.recordedIndex),
    ...(seed?.checkpointInjections ?? []).map((injection) => injection.recordedIndex),
  ]);
  let prefix = 0;
  while (available.has(prefix)) prefix++;
  return prefix;
}

/** The latest row of each index, by index. */
function latestRows<T extends { index: number }>(rows: readonly T[]): T[] {
  const latest = new Map<number, T>();
  for (const row of rows) latest.set(row.index, row);
  return [...latest.values()].sort((a, b) => a.index - b.index);
}

/** The latest row of each index of the run itself, by index. A row with no scope is the run's. */
function latestRootRows<T extends { index: number; scope?: string }>(rows: readonly T[], runId: string): T[] {
  return latestRows(rows.filter((row) => row.scope === undefined || row.scope === runId));
}

/** The latest row of each nested run's index, by scope and then index. */
function latestNestedRows<T extends { index: number; scope?: string }>(rows: readonly T[], runId: string): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (isNestedScope(row.scope, runId)) latest.set(`${row.scope}\u0000${row.index}`, row);
  }
  return [...latest.values()].sort((a, b) =>
    a.scope === b.scope ? a.index - b.index : (a.scope as string) < (b.scope as string) ? -1 : 1);
}

// The calls of one scope, in the order the script makes them. A kind opens a slot for each
// call. The slot takes the call's index, pairs the call with a recorded row through the scope's
// source, and settles once. Settling writes the call row and, for a result, the journal row.
// The kinds keep their hash, their live run, their retries and their events.
//
// Internal: not exported from index.ts.

import { deepFreeze } from "./strict-json.js";
import type {
  JournalEntry,
  WorkflowCallRecord,
  WorkflowResumeCallDecision,
  WorkflowResumeCallLiveReason,
  WorkflowResumeMatch,
} from "./workflow-result.js";

type IdentityField = "index" | "kind" | "hash" | "path" | "inputsHash" | "scope" | "settlementOrdinal";

/** One call a kind opens. */
export interface LedgerCall {
  kind: "agent" | "checkpoint";
  hash: string;
  inputsHash?: string;
  path?: string;
  /** An agent with a schema. Without one, an agent's empty text result does not replay. */
  hasSchema?: boolean;
  /** Fields the kind adds to its call row, after the ones above. */
  fields?: Partial<Omit<WorkflowCallRecord, IdentityField>>;
}

/** A call with its index. */
export interface OpenedCall extends LedgerCall {
  index: number;
}

/** A recorded call that a resumed call can take. */
export interface SourceRow {
  sourceRunId: string;
  recordedIndex: number;
  /** The recorded journal row. A replay returns its result. */
  entry: JournalEntry;
  /** The recorded call row, when the source has one. */
  call?: WorkflowCallRecord;
  /** A reuse run's seed held this answer to a question. */
  injected?: true;
}

export type Pairing<T> =
  | {
      action: "replay";
      row: SourceRow;
      /** What `accept` made of the row. */
      value: T;
      match: WorkflowResumeMatch;
      /** The call row names the row it replayed. */
      provenance: boolean;
      /** The row is in this run's journal already. */
      journaled: boolean;
    }
  | {
      action: "live";
      /** Absent when the source reports no decisions. */
      reason?: WorkflowResumeCallLiveReason;
      /** The recorded call that failed, when the call took one. Its session can go on. */
      failed?: { sourceRunId: string; recordedIndex: number };
    };

/** Where the calls of a scope find their recorded rows. */
export interface SourceScope {
  /**
   * Pairs one call. `accept` turns a row into the value a replay returns, and throws when the
   * row cannot replay. A source calls it before it uses the row up.
   */
  pair<T>(call: OpenedCall, accept: (row: SourceRow) => T): Pairing<T>;
}

/** Lets one call decide after the calls opened before it. */
export interface DecisionTurn {
  /** Settles when every call opened before this one has decided. */
  predecessor: Promise<void>;
  /** Lets the next call decide. A second call does nothing. */
  release(): void;
}

/** The resume decisions of a run, made in the order calls were opened. */
export interface DecisionOrder {
  /** A turn for the next call, or none when the run reports no decisions. */
  reserve(): DecisionTurn | undefined;
  /** Records a decision. A second decision for the same index is dropped. */
  decide(decision: WorkflowResumeCallDecision): void;
  decisions(): readonly WorkflowResumeCallDecision[];
}

export function createDecisionOrder(input: {
  ordered: boolean;
  onDecision?: (decision: WorkflowResumeCallDecision) => void;
}): DecisionOrder {
  const decisions = new Map<number, WorkflowResumeCallDecision>();
  let tail = Promise.resolve();
  return {
    reserve() {
      if (!input.ordered) return undefined;
      const predecessor = tail;
      let resolveTurn!: () => void;
      const turn = new Promise<void>((resolve) => {
        resolveTurn = resolve;
      });
      tail = predecessor.then(() => turn, () => turn);
      let released = false;
      return {
        predecessor,
        release: () => {
          if (released) return;
          released = true;
          resolveTurn();
        },
      };
    },
    decide(decision) {
      if (decisions.has(decision.index)) return;
      const frozen = deepFreeze({ ...decision }) as WorkflowResumeCallDecision;
      decisions.set(frozen.index, frozen);
      input.onDecision?.(frozen);
    },
    decisions: () => [...decisions.values()],
  };
}

export type SettledCall = Omit<WorkflowCallRecord, IdentityField>;

export interface StepSlot {
  readonly index: number;
  /** The call row, once the call has settled. */
  readonly settled: WorkflowCallRecord | undefined;
  /**
   * Pairs the call with a recorded row. When the run reports decisions, it waits for the calls
   * opened before it and returns a promise. A replay then reports its decision, and a live
   * call reports it with `live`.
   */
  pair<T>(accept: (row: SourceRow) => T): Pairing<T> | Promise<Pairing<T>>;
  /** Reports the live decision, when the source gave a reason, and lets the next call decide. */
  live(reason: WorkflowResumeCallLiveReason | undefined): void;
  /** Lets the next call decide, for a call that failed before it decided. */
  release(): void;
  /**
   * Writes the call row, and the journal row when the call returned a result. A call settles
   * once: a later settle returns the first row and writes nothing.
   */
  settle(terminal: SettledCall, entry?: JournalEntry): WorkflowCallRecord;
}

export interface StepLedger {
  open(call: LedgerCall): StepSlot;
  decisions(): readonly WorkflowResumeCallDecision[];
}

export function createStepLedger(input: {
  /** The rows to pair with, or none. */
  source: SourceScope | undefined;
  order: DecisionOrder;
  /** The scope's call sequence, shared by both kinds. */
  counter: { next(): number };
  sink: {
    /** Adds the scope and settlement ordinal, keeps the row and reports it. */
    call(record: Omit<WorkflowCallRecord, "scope" | "settlementOrdinal">): WorkflowCallRecord;
    journal(entry: JournalEntry): void;
  };
}): StepLedger {
  const { source, order, sink } = input;
  return {
    decisions: () => order.decisions(),
    open(call) {
      const index = input.counter.next();
      const turn = order.reserve();
      const opened: OpenedCall = { ...call, index };
      let settled: WorkflowCallRecord | undefined;

      // A run that reports decisions reports a replay here and a live call through `live`.
      const decide = <T>(pairing: Pairing<T>): Pairing<T> => {
        if (turn && pairing.action === "replay") {
          order.decide({
            index,
            kind: call.kind,
            action: "replayed",
            sourceRunId: pairing.row.sourceRunId,
            recordedIndex: pairing.row.recordedIndex,
            match: pairing.match,
            ...(pairing.row.injected ? { checkpointInjected: true as const } : {}),
          });
          turn.release();
        }
        return pairing;
      };

      return {
        index,
        get settled() {
          return settled;
        },
        pair(accept) {
          if (!source) return { action: "live" };
          if (!turn) return decide(source.pair(opened, accept));
          return (async () => {
            try {
              await turn.predecessor;
              return decide(source.pair(opened, accept));
            } catch (error) {
              turn.release();
              throw error;
            }
          })();
        },
        live(reason) {
          if (!turn) return;
          if (reason) order.decide({ index, kind: call.kind, action: "live", reason });
          turn.release();
        },
        release() {
          turn?.release();
        },
        settle(terminal, entry) {
          if (settled) return settled;
          settled = sink.call({
            index,
            kind: call.kind,
            hash: call.hash,
            ...(call.path !== undefined ? { path: call.path } : {}),
            ...(call.inputsHash !== undefined ? { inputsHash: call.inputsHash } : {}),
            ...call.fields,
            ...terminal,
          });
          if (entry && settled.outcome === "result") sink.journal(entry);
          return settled;
        },
      };
    },
  };
}

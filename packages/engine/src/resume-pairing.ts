// Which recorded call a resumed call takes. Pure: it reads the recorded calls of one scope and
// pairs each new call in the order the script makes them.
//
// A call's key is its kind, its call hash and its inputs hash. The n-th call with a key pairs
// with the n-th recorded call with that key. A recorded result replays. A recorded call that
// failed, stopped or returned empty text runs live, and the live call gets that row, for its
// session. A call with no row runs live. A failed row still counts, so the next identical call
// does not take a later row.

/** One recorded call of a scope. */
export interface RecordedCall {
  /** The row's index in the run that recorded it. */
  index: number;
  /** Absent on journal rows of an old run. */
  kind?: "agent" | "checkpoint";
  hash: string;
  /** Absent on rows saved before inputs hashes. */
  inputsHash?: string;
  /** "result" replays. "failed" (failed or stopped) and "empty" (empty text) run live. */
  outcome: "result" | "failed" | "empty";
}

/** A call the script makes now. */
export interface CallToPair {
  index: number;
  kind: "agent" | "checkpoint";
  hash: string;
  inputsHash?: string;
}

/** How a call pairs with the recorded rows. A source scope turns it into the step ledger's `Pairing`. */
export type RowPairing<Row extends RecordedCall> =
  | { action: "replay"; row: Row }
  | { action: "live"; row?: Row };

export interface RecordedScope<Row extends RecordedCall> {
  /** The rows in pairing order: the n-th row with a key is the n-th in this list. */
  rows: readonly Row[];
  /**
   * "inputs" keys on kind, call hash and inputs hash. "hash" keys on kind and call hash. A scope
   * with a row that has no inputs hash keys on "hash" whatever is asked.
   */
  key: "inputs" | "hash";
}

/** Pair calls one at a time, in the order the script makes them. */
export function createPairing<Row extends RecordedCall>(scope: RecordedScope<Row>): (call: CallToPair) => RowPairing<Row> {
  const withInputs = scope.key === "inputs" && scope.rows.every((row) => row.inputsHash !== undefined);
  const keyOf = (call: { kind?: string; hash: string; inputsHash?: string }) =>
    withInputs ? `${call.kind}\u0000${call.hash}\u0000${call.inputsHash ?? ""}` : `${call.kind}\u0000${call.hash}`;
  const queues = new Map<string, Row[]>();
  for (const row of scope.rows) {
    if (row.kind === undefined) continue;
    const key = keyOf(row);
    const queue = queues.get(key);
    if (queue) queue.push(row);
    else queues.set(key, [row]);
  }
  return (call) => {
    const row = queues.get(keyOf(call))?.shift();
    if (!row) return { action: "live" };
    return row.outcome === "result" ? { action: "replay", row } : { action: "live", row };
  };
}

/** Pair a whole list of calls. */
export function pairCalls<Row extends RecordedCall>(scope: RecordedScope<Row>, calls: readonly CallToPair[]): RowPairing<Row>[] {
  const pair = createPairing(scope);
  return calls.map(pair);
}

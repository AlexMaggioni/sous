import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDecisionLog,
  createStepLedger,
  type OpenedCall,
  type Pairing,
  type SourceRow,
  type SourceScope,
} from "../src/step-ledger.js";
import type { JournalEntry, WorkflowCallRecord, WorkflowResumeCallDecision } from "../src/workflow-result.js";

// The ledger on its own, with a planted source and no agent. A kind opens a slot, pairs it and
// settles it. The source here replays a row for every hash in `rows` and runs the rest live.

function entry(index: number, hash: string, result: unknown = `${hash} done`): JournalEntry {
  return { index, hash, result, kind: "agent" };
}

function plantedSource(rows: Record<string, SourceRow>, seen: OpenedCall[] = []): SourceScope {
  return {
    pair<T>(call: OpenedCall, accept: (row: SourceRow) => T): Pairing<T> {
      seen.push(call);
      const row = rows[call.hash];
      if (!row) return { action: "live", reason: "not-recorded" };
      return { action: "replay", row, value: accept(row), match: "path-hash", journaled: false };
    },
  };
}

function setup(input: { source?: SourceScope; reports?: boolean }) {
  let seq = 0;
  let ordinal = 0;
  const calls: WorkflowCallRecord[] = [];
  const journal: JournalEntry[] = [];
  const reported: WorkflowResumeCallDecision[] = [];
  const log = createDecisionLog({ reports: input.reports ?? false, onDecision: (d) => reported.push(d) });
  const ledger = createStepLedger({
    source: input.source,
    log,
    counter: { next: () => seq++ },
    sink: {
      call: (record) => {
        const kept = { ...record, scope: "run", settlementOrdinal: ++ordinal };
        calls.push(kept);
        return kept;
      },
      journal: (row) => journal.push(row),
    },
  });
  return { ledger, calls, journal, reported };
}

const row = (hash: string, recordedIndex: number): SourceRow => ({
  sourceRunId: "source",
  recordedIndex,
  entry: entry(recordedIndex, hash),
});

describe("step ledger", () => {
  it("gives indices in the order calls open, from the scope's counter", () => {
    let seq = 4;
    const ledger = createStepLedger({
      source: undefined,
      log: createDecisionLog({ reports: false }),
      counter: { next: () => seq++ },
      sink: { call: (record) => ({ ...record, scope: "run", settlementOrdinal: 1 }), journal: () => {} },
    });
    assert.deepEqual(
      [ledger.open({ kind: "agent", hash: "a" }), ledger.open({ kind: "checkpoint", hash: "q" })].map((s) => s.index),
      [4, 5],
    );
    assert.equal(seq, 6);
  });

  it("writes the call row once, with the call's identity first and no schema flag, and returns it on a second settle", () => {
    const { ledger, calls } = setup({});
    const slot = ledger.open({
      kind: "agent", hash: "a", path: "p", inputsHash: "a-in", hasSchema: true, fields: { label: "A" },
    });
    assert.equal(slot.settled, undefined);
    const first = slot.settle({ outcome: "error", origin: "engine", aborted: true });
    const second = slot.settle({ outcome: "result", origin: "runner" });
    assert.equal(second, first);
    assert.equal(slot.settled, first);
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(first), [
      "index", "kind", "hash", "path", "inputsHash", "label", "outcome", "origin", "aborted", "scope", "settlementOrdinal",
    ]);
  });

  it("writes the journal row only for a result", () => {
    const { ledger, journal } = setup({});
    ledger.open({ kind: "agent", hash: "a" }).settle({ outcome: "result", origin: "runner" }, entry(0, "a"));
    ledger.open({ kind: "agent", hash: "b" }).settle({ outcome: "null", origin: "runner" }, entry(1, "b"));
    ledger.open({ kind: "agent", hash: "c" }).settle({ outcome: "result", origin: "journal-replay" });
    assert.deepEqual(journal.map((row) => row.hash), ["a"]);
  });

  it("runs every call live when there is no source", () => {
    const { ledger, reported } = setup({ reports: true });
    const pairing = ledger.open({ kind: "agent", hash: "a" }).pair(() => assert.fail("no row to accept"));
    assert.deepEqual(pairing, { action: "live" });
    assert.deepEqual(reported, []);
  });

  it("pairs at once and reports nothing when the run reports no decisions", () => {
    const seen: OpenedCall[] = [];
    const { ledger, reported } = setup({ source: plantedSource({ a: row("a", 0) }, seen) });
    const slot = ledger.open({ kind: "agent", hash: "a", inputsHash: "a-in" });
    const pairing = slot.pair((r) => r.entry.result);
    assert.ok(!(pairing instanceof Promise));
    assert.equal(pairing.action, "replay");
    assert.equal(pairing.action === "replay" && pairing.value, "a done");
    slot.live("not-recorded");
    assert.deepEqual(reported, []);
    assert.deepEqual(seen, [{ kind: "agent", hash: "a", inputsHash: "a-in", index: 0 }]);
  });

  it("reports a replay with its source row, and an injected answer as injected", () => {
    const injected: SourceRow = { ...row("q", 3), injected: true };
    const { ledger, reported } = setup({ reports: true, source: plantedSource({ a: row("a", 2), q: injected }) });
    ledger.open({ kind: "agent", hash: "a" }).pair((r) => r);
    ledger.open({ kind: "checkpoint", hash: "q" }).pair((r) => r);
    assert.deepEqual(reported, [
      { index: 0, kind: "agent", action: "replayed", sourceRunId: "source", recordedIndex: 2, match: "path-hash" },
      {
        index: 1, kind: "checkpoint", action: "replayed", sourceRunId: "source", recordedIndex: 3, match: "path-hash",
        checkpointInjected: true,
      },
    ]);
    assert.ok(Object.isFrozen(reported[0]));
  });

  it("reports a live call through live, once, and only with a reason", () => {
    const { ledger, reported } = setup({ reports: true, source: plantedSource({}) });
    const first = ledger.open({ kind: "agent", hash: "x" });
    const pairing = first.pair((r) => r);
    assert.deepEqual(pairing, { action: "live", reason: "not-recorded" });
    first.live("not-recorded");
    first.live("strategy-live");
    const second = ledger.open({ kind: "agent", hash: "y" });
    second.pair((r) => r);
    second.live(undefined);
    assert.deepEqual(reported, [{ index: 0, kind: "agent", action: "live", reason: "not-recorded" }]);
    assert.deepEqual(ledger.decisions(), reported);
  });

  it("reports nothing for a call whose accept throws, and pairs the next call", () => {
    const { ledger, reported } = setup({ reports: true, source: plantedSource({ a: row("a", 0), b: row("b", 1) }) });
    const bad = ledger.open({ kind: "checkpoint", hash: "a" });
    const next = ledger.open({ kind: "agent", hash: "b" });
    assert.throws(
      () => bad.pair(() => {
        throw new Error("not an explicit answer");
      }),
      /not an explicit answer/,
    );
    const pairing = next.pair((r) => r.entry.result);
    assert.equal(pairing.action === "replay" && pairing.value, "b done");
    assert.deepEqual(reported.map((d) => [d.index, d.action]), [[1, "replayed"]]);
  });

  it("keeps the first decision for an index", () => {
    const log = createDecisionLog({ reports: true });
    log.decide({ index: 0, kind: "agent", action: "live", reason: "not-recorded" });
    log.decide({ index: 0, kind: "agent", action: "live", reason: "strategy-live" });
    assert.deepEqual(log.decisions(), [{ index: 0, kind: "agent", action: "live", reason: "not-recorded" }]);
  });

  it("records nothing when the run reports no decisions", () => {
    const reported: WorkflowResumeCallDecision[] = [];
    const log = createDecisionLog({ reports: false, onDecision: (d) => reported.push(d) });
    log.decide({ index: 0, kind: "agent", action: "live", reason: "not-recorded" });
    assert.deepEqual(log.decisions(), []);
    assert.deepEqual(reported, []);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CallToPair, pairCalls, type RecordedCall, type RowPairing } from "../src/resume-pairing.js";

// The pairing function on its own. Each case gives a scope's recorded calls and the calls a
// resumed script makes, and checks what each call does: "replay <index>", "live" or
// "live <index>" (runs live and gets that row, for its session).

type Kind = "agent" | "checkpoint";

/** A recorded agent call with inputs hash `<hash>-in`. */
function row(index: number, hash: string, outcome: RecordedCall["outcome"] = "result", kind: Kind = "agent"): RecordedCall {
  return { index, kind, hash, inputsHash: `${hash}-in`, outcome };
}

/** A call the script makes now, with inputs hash `<hash>-in`. */
function call(index: number, hash: string, kind: Kind = "agent"): CallToPair {
  return { index, kind, hash, inputsHash: `${hash}-in` };
}

function show(pairings: RowPairing<RecordedCall>[]): string[] {
  return pairings.map((pairing) =>
    pairing.action === "replay" ? `replay ${pairing.row.index}` : pairing.row ? `live ${pairing.row.index}` : "live");
}

/** The rule a same-script resume uses today: the row at the call's index, if the hashes agree. */
function indexAndHash(rows: readonly RecordedCall[], calls: readonly CallToPair[]): string[] {
  return calls.map((next) => {
    const found = rows.find((recorded) => recorded.index === next.index);
    if (!found || found.hash !== next.hash) return "live";
    return found.outcome === "result" ? `replay ${found.index}` : `live ${found.index}`;
  });
}

/** Recorded runs whose script did not change. Each `calls` is what the same script makes again. */
const SAME_SCRIPT: { name: string; rows: RecordedCall[]; calls: CallToPair[] }[] = [
  {
    name: "three steps, the last one failed",
    rows: [row(0, "a"), row(1, "b"), row(2, "c", "failed")],
    calls: [call(0, "a"), call(1, "b"), call(2, "c")],
  },
  {
    name: "a usage limit on the second step",
    rows: [row(0, "a"), row(1, "b", "failed")],
    calls: [call(0, "a"), call(1, "b"), call(2, "c")],
  },
  {
    name: "parallel steps, one failed and a sibling finished after it",
    rows: [row(0, "a"), row(1, "b"), row(2, "c", "failed"), row(3, "d")],
    calls: [call(0, "a"), call(1, "b"), call(2, "c"), call(3, "d")],
  },
  {
    name: "a loop of three identical steps",
    rows: [row(0, "l"), row(1, "l"), row(2, "l")],
    calls: [call(0, "l"), call(1, "l"), call(2, "l")],
  },
  {
    name: "a loop stopped on its second step",
    rows: [row(0, "l"), row(1, "l", "failed")],
    calls: [call(0, "l"), call(1, "l"), call(2, "l")],
  },
  {
    name: "an answered question, then a step",
    rows: [row(0, "a"), row(1, "q", "result", "checkpoint"), row(2, "b", "failed")],
    calls: [call(0, "a"), call(1, "q", "checkpoint"), call(2, "b")],
  },
  {
    name: "a step that returned empty text",
    rows: [row(0, "a"), row(1, "b", "empty")],
    calls: [call(0, "a"), call(1, "b"), call(2, "c")],
  },
];

describe("pairing calls by occurrence", () => {
  for (const trace of SAME_SCRIPT) {
    it(`pairs the same script like index and hash: ${trace.name}`, () => {
      const byOccurrence = show(pairCalls({ rows: trace.rows, key: "inputs" }, trace.calls));
      assert.deepEqual(byOccurrence, indexAndHash(trace.rows, trace.calls));
    });
  }

  it("pairs parallel calls made in another order by their key", () => {
    const rows = [row(0, "a"), row(1, "b"), row(2, "c"), row(3, "d", "failed")];
    const calls = [call(0, "a"), call(1, "c"), call(2, "d"), call(3, "b")];
    assert.deepEqual(show(pairCalls({ rows, key: "inputs" }, calls)), ["replay 0", "replay 2", "live 3", "replay 1"]);
  });

  it("pairs the n-th call of a loop with the n-th row", () => {
    const rows = [row(0, "a"), row(1, "l"), row(2, "b"), row(3, "l")];
    const calls = [call(0, "a"), call(1, "l"), call(2, "b"), call(3, "l"), call(4, "l")];
    assert.deepEqual(show(pairCalls({ rows, key: "inputs" }, calls)), ["replay 0", "replay 1", "replay 2", "replay 3", "live"]);
  });

  it("counts a failed row, so the next identical call takes the next row", () => {
    const rows = [row(0, "l"), row(1, "l", "failed"), row(2, "l")];
    const calls = [call(0, "l"), call(1, "l"), call(2, "l")];
    assert.deepEqual(show(pairCalls({ rows, key: "inputs" }, calls)), ["replay 0", "live 1", "replay 2"]);
  });

  it("runs an edited first step live and replays the steps after it", () => {
    const rows = [row(0, "a"), row(1, "b"), row(2, "c", "failed")];
    const calls = [call(0, "a2"), call(1, "b"), call(2, "c")];
    assert.deepEqual(show(pairCalls({ rows, key: "inputs" }, calls)), ["live", "replay 1", "live 2"]);
  });

  it("replays the steps after a step inserted first", () => {
    const rows = [row(0, "a"), row(1, "b"), row(2, "c", "failed")];
    const calls = [call(0, "z"), call(1, "a"), call(2, "b"), call(3, "c")];
    assert.deepEqual(show(pairCalls({ rows, key: "inputs" }, calls)), ["live", "replay 0", "replay 1", "live 2"]);
  });

  it("keeps the kind in the key", () => {
    const rows = [row(0, "x", "result", "checkpoint")];
    assert.deepEqual(show(pairCalls({ rows, key: "inputs" }, [call(0, "x", "agent")])), ["live"]);
  });

  it("runs live a call whose inputs hash changed, when the key holds inputs", () => {
    const rows = [row(0, "a"), row(1, "b")];
    const calls = [call(0, "a"), { ...call(1, "b"), inputsHash: "b-other" }];
    assert.deepEqual(show(pairCalls({ rows, key: "inputs" }, calls)), ["replay 0", "live"]);
  });

  it("replays a call whose inputs hash changed, when the key is the call hash", () => {
    const rows = [row(0, "a"), row(1, "b")];
    const calls = [call(0, "a"), { ...call(1, "b"), inputsHash: "b-other" }];
    assert.deepEqual(show(pairCalls({ rows, key: "hash" }, calls)), ["replay 0", "replay 1"]);
  });

  it("keys on the call hash when a row has no inputs hash", () => {
    const rows = [row(0, "a"), { index: 1, kind: "agent" as const, hash: "b", outcome: "result" as const }];
    const calls = [{ ...call(0, "a"), inputsHash: "a-other" }, call(1, "b")];
    assert.deepEqual(show(pairCalls({ rows, key: "inputs" }, calls)), ["replay 0", "replay 1"]);
  });

  it("runs live a call with no recorded row", () => {
    assert.deepEqual(show(pairCalls({ rows: [], key: "inputs" }, [call(0, "a")])), ["live"]);
  });
});

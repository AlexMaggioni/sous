import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WorkflowErrorCode } from "../src/errors.js";
import { resumeRows, revisionSeed, unusedSeed } from "../src/resume-rows.js";
import type { PersistedResumeSeed, PersistedRunState } from "../src/runs/persistence/run-persistence.js";
import type { JournalEntry, WorkflowCallRecord } from "../src/workflow-result.js";

// The rows a same-ID resume pairs with: the run's own rows by index, then its seed's rows.

const RUN = "run";

function entry(index: number, hash: string, scope = RUN): JournalEntry {
  return { index, hash, result: `${hash} done`, kind: "agent", scope };
}

function call(index: number, hash: string, outcome: WorkflowCallRecord["outcome"], scope = RUN): WorkflowCallRecord {
  return { index, kind: "agent", hash, inputsHash: `${hash}-in`, outcome, origin: "runner", scope };
}

/** Each row of a scope as index, hash and outcome, with "own" for the run's own result rows. */
function shape(rows: ReturnType<typeof resumeRows>, scope: string) {
  return rows.get(scope)?.rows.map((row) => [row.index, row.hash, row.outcome, row.own === true ? "own" : row.sourceRunId]);
}

/** The seed of the paused reuse run in the reuse-blockers fixture: candidates B and C, blocker D. */
function plantedSeed(): { seed: PersistedResumeSeed; runId: string } {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "resume-v1", "reuse-blockers.json"), "utf8")) as {
    runs: Array<{ state: PersistedRunState }>;
  };
  const state = fixture.runs[1]!.state;
  return { seed: state.resumeSeed!, runId: state.runId };
}

/** A hash of one repeated hex digit, so the seed checks take it. */
const H = (digit: string) => digit.repeat(64);

/** A journal row and a call row a seed can hold: with a path and an inputs hash. */
function full(index: number, digit: string, outcome: WorkflowCallRecord["outcome"], scope = RUN): WorkflowCallRecord {
  const base = {
    index, kind: "agent", hash: H(digit), path: `step-${digit}`, inputsHash: H(digit).slice(0, 63) + "0",
    origin: "runner", scope,
  } as const;
  return outcome === "result" ? { ...base, outcome } : { ...base, outcome, error: { form: "workflow-error", message: "stopped", code: WorkflowErrorCode.AGENT_EXECUTION_ERROR } };
}

function fullEntry(index: number, digit: string, scope = RUN): JournalEntry {
  return { index, hash: H(digit), result: `${digit} done`, kind: "agent", scope };
}

describe("resume rows", () => {
  it("joins the journal and the call rows of a scope by index", () => {
    const rows = resumeRows({
      runId: RUN,
      journal: [entry(0, "a"), entry(1, "b"), entry(3, "d"), entry(4, "e")],
      calls: [call(0, "a", "result"), call(1, "x", "error"), call(2, "c", "error"), call(3, "d", "error"), call(4, "y", "result")],
      key: "hash",
    });
    // At 1 and 3 a later call took the index and failed, so B's and D's rows are stale. At 4 a
    // later call returned a result, but its journal row was never saved.
    assert.deepEqual(shape(rows, RUN), [
      [0, "a", "result", "own"],
      [1, "x", "failed", RUN],
      [2, "c", "failed", RUN],
      [3, "d", "failed", RUN],
      [4, "y", "failed", RUN],
    ]);
    const [a] = rows.get(RUN)!.rows;
    assert.equal(a!.kind, "agent");
    assert.equal(a!.inputsHash, "a-in");
    assert.equal(a!.call, undefined, "an own row has no call row, so its replay looks as it always has");
    assert.equal(rows.get(RUN)!.byIndex, undefined);
  });

  it("keeps nested scopes apart", () => {
    const nested = `${RUN}-nested1`;
    const rows = resumeRows({
      runId: RUN,
      journal: [entry(0, "a"), entry(0, "n", nested), entry(0, "z", "other")],
      calls: [call(0, "a", "result"), call(0, "n", "result", nested)],
      key: "hash",
    });
    assert.deepEqual([...rows.keys()].sort(), [RUN, nested]);
    assert.equal(rows.get(RUN)!.byIndex, undefined);
    assert.equal(rows.get(nested)!.byIndex, undefined);
  });

  it("puts the seed's rows after the run's own rows, in recorded order", () => {
    const { seed, runId } = plantedSeed();
    const rows = resumeRows({
      runId,
      journal: [entry(0, seed.candidates[0]!.call.hash, runId)],
      calls: [],
      seed,
      key: "hash",
    });
    const scope = rows.get(runId)!;
    assert.deepEqual(scope.rows.map((row) => [row.index, row.outcome, row.own === true]), [
      [0, "result", true],
      [1, "result", false],
      [2, "result", false],
      [3, "failed", false],
    ]);
    assert.equal(scope.rows[1]!.sourceRunId, seed.candidates[0]!.sourceRunId);
    assert.equal(scope.rows[1]!.call, seed.candidates[0]!.call);
    assert.equal(scope.byIndex, undefined);
  });

  it("drops the seed rows a call row replayed, and keeps the rest", () => {
    const { seed, runId } = plantedSeed();
    const [b, c] = seed.candidates;
    const replayed: WorkflowCallRecord = {
      ...call(1, b!.call.hash, "result", runId),
      origin: "journal-replay",
      replay: { sourceRunId: b!.sourceRunId, recordedIndex: b!.recordedIndex, match: "occurrence" },
    };
    const left = unusedSeed(seed, [replayed], runId);
    assert.deepEqual(left?.candidates.map((row) => row.recordedIndex), [c!.recordedIndex]);
    assert.equal(left?.callBlockers?.length, 1);
    assert.equal(left?.sourceRunId, seed.sourceRunId);

    // A replay in another scope does not use a root row.
    const elsewhere = { ...replayed, scope: `${runId}-nested1` };
    assert.equal(unusedSeed(seed, [elsewhere], runId)?.candidates.length, 2);
  });

  it("carries a revised run's own rows into a seed, with the run as their source", () => {
    const nested = `${RUN}-nested1`;
    const seed = revisionSeed({
      runId: RUN,
      journal: [fullEntry(0, "a"), fullEntry(2, "c"), fullEntry(0, "d", nested)],
      calls: [
        full(0, "a", "result"),
        full(1, "b", "error"),
        { ...full(2, "c", "result"), path: undefined },
        full(3, "e", "result"),
        full(0, "d", "result", nested),
      ],
    });
    assert.equal(seed?.sourceRunId, RUN);
    // Index 2 has no path and index 3 has no journal row, so those steps run again.
    assert.deepEqual(seed?.candidates.map((row) => [row.call.scope, row.recordedIndex, row.sourceRunId]), [
      [RUN, 0, RUN],
      [nested, 0, RUN],
    ]);
    assert.deepEqual(seed?.callBlockers?.map((row) => [row.recordedIndex, row.call.outcome]), [[1, "error"]]);

    // The new version starts with no journal and no call rows, and pairs with the seed.
    const rows = resumeRows({ runId: RUN, journal: [], calls: [], seed, key: "inputs" });
    assert.deepEqual(shape(rows, RUN), [
      [0, H("a"), "result", RUN],
      [1, H("b"), "failed", RUN],
    ]);
    assert.deepEqual(shape(rows, nested), [[0, H("d"), "result", RUN]]);
  });

  it("keeps the seed rows a revised run did not reach, and drops one its own row now holds", () => {
    const first = revisionSeed({
      runId: RUN,
      journal: [fullEntry(0, "a"), fullEntry(1, "b"), fullEntry(2, "c")],
      calls: [full(0, "a", "result"), full(1, "b", "result"), full(2, "c", "result")],
    });
    // The second version replayed A, ran a new step D at index 1, and stopped there.
    const replayedA: WorkflowCallRecord = {
      ...full(0, "a", "result"),
      origin: "journal-replay",
      replay: { sourceRunId: RUN, recordedIndex: 0, match: "occurrence" },
    };
    const second = revisionSeed({
      runId: RUN,
      journal: [fullEntry(0, "a"), fullEntry(1, "d")],
      calls: [replayedA, full(1, "d", "result")],
      seed: first,
    });
    assert.deepEqual(second?.candidates.map((row) => [row.recordedIndex, row.call.hash]), [
      [0, H("a")],
      [1, H("d")],
      [2, H("c")],
    ]);
  });

  it("gives no revision seed when no row can be carried", () => {
    assert.equal(revisionSeed({ runId: RUN, journal: [entry(0, "a")], calls: [call(0, "a", "result")] }), undefined);
    assert.equal(revisionSeed({ runId: RUN, journal: [], calls: [] }), undefined);
  });

  it("gives no seed when every row is used, or when there was none", () => {
    const { seed, runId } = plantedSeed();
    const used = [...seed.candidates, ...(seed.callBlockers ?? [])].map((row, i): WorkflowCallRecord => ({
      ...call(i, row.call.hash, "result", runId),
      replay: { sourceRunId: row.sourceRunId, recordedIndex: row.recordedIndex, match: "occurrence" },
    }));
    assert.equal(unusedSeed(seed, used, runId), undefined);
    assert.equal(unusedSeed(undefined, [], runId), undefined);
  });
});

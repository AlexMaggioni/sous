import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resumeRows, unusedSeed } from "../src/resume-rows.js";
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

describe("resume rows", () => {
  it("joins the journal and the call rows of a scope by index", () => {
    const rows = resumeRows({
      runId: RUN,
      journal: [entry(0, "a"), entry(1, "b")],
      calls: [call(0, "a", "result"), call(1, "x", "error"), call(2, "c", "error")],
      key: "hash",
    });
    // At 1 a later call asked for something else and failed. B's result still counts.
    assert.deepEqual(shape(rows, RUN), [
      [0, "a", "result", "own"],
      [1, "x", "failed", RUN],
      [1, "b", "result", "own"],
      [2, "c", "failed", RUN],
    ]);
    const [a] = rows.get(RUN)!.rows;
    assert.equal(a!.kind, "agent");
    assert.equal(a!.inputsHash, "a-in");
    assert.equal(a!.call, undefined, "an own row has no call row, so its replay looks as it always has");
    assert.equal(rows.get(RUN)!.byIndex, undefined);
  });

  it("keeps nested scopes apart, and pairs by index a scope saved with no call rows", () => {
    const nested = `${RUN}-nested1`;
    const rows = resumeRows({
      runId: RUN,
      journal: [entry(0, "a"), entry(0, "n", nested), entry(0, "z", "other")],
      calls: [call(0, "a", "result")],
      key: "hash",
    });
    assert.deepEqual([...rows.keys()].sort(), [RUN, nested]);
    assert.equal(rows.get(RUN)!.byIndex, undefined);
    assert.equal(rows.get(nested)!.byIndex, true);
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

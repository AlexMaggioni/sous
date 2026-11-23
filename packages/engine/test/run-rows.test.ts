import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowErrorCode } from "../src/errors.js";
import { continueRows, handedInRows, newRows, reuseRows, reviseRows } from "../src/run-rows.js";
import type { PersistedCheckpointInjection, PersistedResumeSeed } from "../src/runs/persistence/run-persistence.js";
import type { JournalEntry, WorkflowCallRecord } from "../src/workflow-result.js";

// A run's rows as the manager saves them: each row it records, and what a save writes.

const RUN = "run";
const NESTED = `${RUN}-nested1`;
const SOURCE = "source";

/** A journal row. A null scope gives a row with none, as an old journal saved it. */
function entry(index: number, hash: string, scope: string | null = RUN): JournalEntry {
  return { index, hash, result: `${hash} done`, kind: "agent", ...(scope === null ? {} : { scope }) };
}

function call(index: number, hash: string, outcome: WorkflowCallRecord["outcome"], scope = RUN): WorkflowCallRecord {
  return { index, kind: "agent", hash, inputsHash: `${hash}-in`, outcome, origin: "runner", scope };
}

/** A call that replayed the journal row at `from` of `sourceRunId`. */
function replayed(record: WorkflowCallRecord, sourceRunId: string, from = record.index): WorkflowCallRecord {
  return { ...record, origin: "journal-replay", replay: { sourceRunId, recordedIndex: from, match: "index-hash" } };
}

/** Each row as index and hash, with the scope when it is not the run's. */
const rows = (list: ReadonlyArray<JournalEntry | WorkflowCallRecord>) =>
  list.map((row) => (row.scope === RUN ? [row.index, row.hash] : [row.index, row.hash, row.scope]));

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

/** The seed rows as source, index and outcome. */
function seedShape(seed: PersistedResumeSeed | undefined) {
  if (!seed) return undefined;
  return {
    sourceRunId: seed.sourceRunId,
    rows: [
      ...seed.candidates.map((row) => [row.sourceRunId, row.recordedIndex, "result"]),
      ...(seed.callBlockers ?? []).map((row) => [row.sourceRunId, row.recordedIndex, "failed"]),
      ...(seed.checkpointInjections ?? []).map((row) => [row.sourceRunId, row.recordedIndex, "checkpoint"]),
    ],
  };
}

describe("run rows", () => {
  it("replaces a row of the same scope and index, and keeps nested runs apart", () => {
    const run = newRows(RUN);
    run.journal(entry(0, "a"));
    run.journal(entry(0, "n", NESTED));
    run.journal(entry(0, "b"));
    run.journal(entry(0, "m", NESTED));
    run.journal(entry(1, "c", null));
    run.call(call(0, "a", "error"), undefined);
    run.call(call(0, "n", "result", NESTED), undefined);
    run.call(call(0, "b", "result"), undefined);

    const saved = run.saved("running");
    assert.deepEqual(rows(saved.journal), [[0, "b"], [1, "c", undefined]], "a row with no scope is the run's");
    assert.deepEqual(rows(saved.nestedJournal), [[0, "m", NESTED]]);
    assert.deepEqual(rows(saved.calls), [[0, "n", NESTED], [0, "b"]]);
    assert.deepEqual(rows(run.resultCalls()), [[0, "b"]], "the result leaves out the nested runs' calls");
    assert.equal(saved.resumeSeed, undefined);
  });

  it("binds a replayed journal row to the call that replayed it", () => {
    const session = {
      sessionId: "s1", backendId: "claude", cwd: "/work", reopen: { load: true, resume: true, list: true },
      callIndex: 7, label: "old", phase: "plan", keptOpen: false,
    };
    const old: JournalEntry = { index: 0, hash: "a", result: "a done", session, call: { kind: "agent", label: "old", phase: "plan" } };
    const run = handedInRows(RUN, new Map([[0, old], [1, { index: 1, hash: "k", result: true }], [2, entry(2, "c")]]));

    run.call(replayed({ ...call(0, "a", "result"), label: "writer" }, RUN), "review");
    run.call(replayed({ ...call(1, "k", "result"), kind: "checkpoint" }, RUN), "review");
    run.call(replayed(call(2, "z", "result"), RUN), "review");

    const [agent, checkpoint, other] = run.saved("running").journal;
    assert.deepEqual(agent, {
      ...old,
      kind: "agent",
      scope: RUN,
      session: { ...session, callIndex: 0, label: "writer", phase: "plan" },
      call: { kind: "agent", label: "writer", phase: "plan" },
    }, "an agent row keeps the phase it ran in");
    assert.ok(Object.isFrozen(agent));
    assert.deepEqual(checkpoint, {
      index: 1, hash: "k", result: true, kind: "checkpoint", scope: RUN,
      call: { kind: "checkpoint", label: "checkpoint", phase: "review" },
    }, "a checkpoint row takes the run's phase now");
    assert.deepEqual(other, entry(2, "c"), "a call with another hash leaves the row as it is");

    const live = handedInRows(RUN, new Map([[0, entry(0, "a", null)]]));
    live.call(call(0, "a", "result"), undefined);
    assert.deepEqual(live.saved("running").journal, [entry(0, "a", null)], "a live call binds nothing");
  });

  it("takes a resumed row from its old index when a replay moves it", () => {
    const run = continueRows(RUN, {
      journal: [entry(0, "a"), entry(1, "b"), entry(2, "c")],
      calls: [call(0, "a", "result"), call(1, "b", "result"), call(2, "c", "result")],
    }).rows;
    // Index 2 ran again in this execution before the replay moved its old row.
    run.call(call(2, "x", "result"), undefined);
    run.journal(entry(2, "x"));
    run.call(replayed(call(0, "b", "result"), RUN, 1), undefined);
    run.journal(entry(0, "b"));
    run.call(replayed(call(3, "c", "result"), RUN, 2), undefined);
    run.journal(entry(3, "c"));

    const saved = run.saved("running");
    assert.deepEqual(rows(saved.journal), [[2, "x"], [0, "b"], [3, "c"]], "the row this execution wrote at 2 stays");
    assert.deepEqual(rows(saved.calls), [[2, "x"], [0, "b"], [3, "c"]]);

    const fresh = newRows(RUN);
    fresh.journal(entry(1, "b"));
    fresh.call(call(1, "b", "result"), undefined);
    fresh.call(replayed(call(0, "b", "result"), RUN, 1), undefined);
    assert.deepEqual(rows(fresh.saved("running").calls), [[1, "b"], [0, "b"]], "a run that did not resume moves nothing");
  });

  it("completes with the call rows of this execution, and keeps the nested runs' latest rows", () => {
    const run = newRows(RUN);
    run.call(call(0, "a", "error"), undefined);
    run.call(call(0, "n", "error", NESTED), undefined);
    run.call(call(0, "m", "result", NESTED), undefined);
    run.completed([call(0, "a", "result"), call(1, "b", "result")]);
    assert.deepEqual(rows(run.saved("completed").calls), [[0, "a"], [1, "b"], [0, "m", NESTED]]);
    assert.deepEqual(rows(run.resultCalls()), [[0, "a"], [1, "b"]]);
  });

  it("saves a run that started from its own rows as it recorded them, and drops the seed when it completes", () => {
    const seed = reviseRows(RUN, {
      journal: [fullEntry(0, "a")],
      calls: [full(0, "a", "result"), full(1, "b", "error")],
    }, "hash").rows.saved("paused").resumeSeed;
    const run = continueRows(RUN, {
      journal: [entry(0, "a"), entry(1, "b")],
      calls: [call(0, "a", "result"), call(1, "b", "error")],
      resumeSeed: seed,
    }).rows;
    run.call(call(2, "c", "error"), undefined);

    const paused = run.saved("paused");
    assert.deepEqual(rows(paused.journal), [[0, "a"], [1, "b"]], "a stale row stays");
    assert.deepEqual(rows(paused.calls), [[0, "a"], [1, "b"], [2, "c"]]);
    assert.deepEqual(seedShape(paused.resumeSeed), { sourceRunId: RUN, rows: [[RUN, 0, "result"], [RUN, 1, "failed"]] });
    assert.equal(run.saved("completed").resumeSeed, undefined);
    assert.deepEqual(seedShape(run.saved("paused").resumeSeed), seedShape(paused.resumeSeed), "a save changes nothing");
  });

  it("trims a reuse run's rows when it stops", () => {
    const run = reuseRows(RUN, {
      sourceRunId: SOURCE,
      journal: [fullEntry(0, "a", SOURCE), fullEntry(1, "b", SOURCE), fullEntry(0, "d", "old")],
      calls: [full(0, "a", "result", SOURCE), full(1, "b", "result", SOURCE), full(2, "c", "error", SOURCE)],
      key: "hash",
    }).rows;
    run.journal(entry(5, "e"));
    run.call(call(5, "e", "result"), undefined);
    run.journal(entry(3, "x"));
    run.call(call(3, "y", "result"), undefined);
    run.journal(entry(4, "f"));
    run.call(call(4, "f", "error"), undefined);
    run.journal(entry(6, "g"));
    run.journal(entry(0, "n", NESTED));
    run.call(call(0, "n", "result", NESTED), undefined);
    run.call(replayed(full(0, "a", "result"), SOURCE), undefined);

    const running = run.saved("running");
    assert.deepEqual(rows(running.journal), [[5, "e"], [3, "x"], [4, "f"], [6, "g"]], "a running save keeps every row");
    assert.deepEqual(seedShape(running.resumeSeed), {
      sourceRunId: SOURCE, rows: [[SOURCE, 0, "result"], [SOURCE, 1, "result"], [SOURCE, 2, "failed"]],
    });

    const paused = run.saved("paused");
    // 3 and 4 are stale under the calls that took them. 6 has no call, so a resume replays it.
    assert.deepEqual(rows(paused.journal), [[5, "e"], [6, "g"]]);
    assert.deepEqual(rows(paused.nestedJournal), [[0, "n", NESTED]]);
    assert.deepEqual(rows(paused.calls), [[0, H("a")], [3, "y"], [4, "f"], [5, "e"], [0, "n", NESTED]]);
    assert.deepEqual(seedShape(paused.resumeSeed), { sourceRunId: RUN, rows: [[SOURCE, 1, "result"], [SOURCE, 2, "failed"]] },
      "the seed keeps the rows the run did not replay, with the run as their source");
    assert.deepEqual(seedShape(run.saved("aborted").resumeSeed), seedShape(paused.resumeSeed));
    assert.equal(run.saved("completed").resumeSeed, undefined);
    assert.deepEqual(rows(run.saved("running").journal), rows(running.journal), "a save changes nothing");
  });

  it("drops a seed checkpoint that the run asked again", () => {
    const injection = (index: number, digit: string): PersistedCheckpointInjection => ({
      checkpointDecision: "explicit-v1", sourceRunId: "older", recordedIndex: index,
      hash: H(digit), path: `ask-${digit}`, inputsHash: H(digit), decision: { approved: true },
    });
    const seed: PersistedResumeSeed = {
      format: "identity-v1", sourceRunId: SOURCE, candidates: [], checkpointInjections: [injection(7, "7"), injection(8, "8")],
    };
    const run = reuseRows(RUN, { sourceRunId: SOURCE, journal: [fullEntry(0, "a", SOURCE)], calls: [full(0, "a", "result", SOURCE)], seed, key: "hash" }).rows;
    run.call({ index: 1, kind: "checkpoint", hash: H("7"), inputsHash: H("7"), outcome: "result", origin: "runner", scope: RUN }, "review");
    run.call({ index: 2, kind: "checkpoint", hash: H("8"), inputsHash: H("9"), outcome: "result", origin: "runner", scope: RUN }, "review");

    assert.deepEqual(seedShape(run.saved("paused").resumeSeed), {
      sourceRunId: RUN, rows: [[SOURCE, 0, "result"], ["older", 8, "checkpoint"]],
    }, "a checkpoint asked with other inputs keeps its answer");
  });

  it("does not trim a run that started from no other rows", () => {
    const fresh = newRows(RUN);
    const live = reuseRows(RUN);
    assert.equal(live.prefix, 0);
    assert.equal(live.resume, undefined);
    for (const run of [fresh, live.rows]) {
      run.journal(entry(1, "b"));
      run.journal(entry(0, "a"));
      run.call(call(0, "x", "error"), undefined);
    }
    assert.deepEqual(rows(fresh.saved("paused").journal), [[1, "b"], [0, "a"]]);
    assert.deepEqual(rows(live.rows.saved("paused").journal), [[1, "b"]], "a reuse that replays nothing still trims");
  });

  it("starts a reuse from the source's seed and moves its old data", () => {
    const started = reuseRows(RUN, {
      sourceRunId: SOURCE,
      journal: [fullEntry(0, "a", SOURCE), fullEntry(1, "b", SOURCE), entry(0, "o", `${SOURCE}-nested1`), entry(0, "z", "elsewhere")],
      calls: [full(0, "a", "result", SOURCE), full(1, "b", "result", SOURCE)],
      key: "inputs",
    });
    const saved = started.rows.saved("running");
    assert.deepEqual(rows(saved.journal), [], "a scope with call rows goes in the seed");
    assert.deepEqual(rows(saved.nestedJournal), [[0, "o", NESTED]], "a scope with no call rows moves to the new run");
    assert.deepEqual(saved.calls, []);
    assert.deepEqual(seedShape(saved.resumeSeed), { sourceRunId: SOURCE, rows: [[SOURCE, 0, "result"], [SOURCE, 1, "result"]] });
    assert.equal(started.prefix, 2);
    assert.deepEqual(started.resume?.get(RUN)?.rows.map((row) => [row.index, row.sourceRunId]), [[0, SOURCE], [1, SOURCE]]);
    assert.equal(started.resume?.get(RUN)?.key, "inputs");
    assert.deepEqual(started.resume?.get(NESTED)?.rows.map((row) => [row.index, row.hash]), [[0, "o"]]);

    const old = reuseRows(RUN, { sourceRunId: SOURCE, journal: [entry(1, "b", null), entry(0, "a", SOURCE)], calls: [], key: "hash" });
    assert.deepEqual(rows(old.rows.saved("running").journal), [[0, "a"], [1, "b"]], "a root scope with no call rows moves too");
    assert.equal(old.prefix, 2);
  });

  it("continues from the run's latest saved rows", () => {
    const legacy = { ...call(0, "a2", "result"), budgetDebit: 1, replay: { sourceRunId: RUN, recordedIndex: 0, match: "index-hash" as const, logicalBudgetDebit: 1 } };
    const continued = continueRows(RUN, {
      journal: [entry(0, "a"), entry(0, "a2", null), entry(1, "b", "elsewhere")],
      nestedJournal: [entry(0, "n", NESTED)],
      calls: [call(0, "a", "error"), legacy, call(0, "n", "result", NESTED)],
    });
    const saved = continued.rows.saved("running");
    assert.deepEqual(rows(saved.journal), [[0, "a2", undefined]], "the latest row of an index wins");
    assert.deepEqual(rows(saved.nestedJournal), [[0, "n", NESTED]]);
    assert.deepEqual(saved.calls[0], { ...call(0, "a2", "result"), replay: { sourceRunId: RUN, recordedIndex: 0, match: "index-hash" } },
      "a call row loses the budget fields of an older engine");
    assert.equal(continued.resume.get(RUN)?.key, "hash");
    assert.deepEqual(continued.resume.get(RUN)?.rows.map((row) => [row.index, row.hash, row.own]), [[0, "a2", true]]);
  });

  it("revises a run into a new version with no call rows", () => {
    const revised = reviseRows(RUN, {
      journal: [fullEntry(0, "a"), fullEntry(1, "b")],
      nestedJournal: [entry(0, "o", NESTED)],
      calls: [full(0, "a", "result"), full(1, "b", "error")],
    }, "inputs");
    const saved = revised.rows.saved("running");
    assert.deepEqual(saved.journal, []);
    assert.deepEqual(rows(saved.nestedJournal), [[0, "o", NESTED]], "a nested run with no call rows keeps its journal");
    assert.deepEqual(saved.calls, []);
    assert.deepEqual(seedShape(saved.resumeSeed), { sourceRunId: RUN, rows: [[RUN, 0, "result"], [RUN, 1, "failed"]] });
    assert.equal(revised.prefix, 1);
    assert.equal(revised.resume?.get(RUN)?.key, "inputs");
    assert.deepEqual(seedShape(revised.rows.saved("paused").resumeSeed), seedShape(saved.resumeSeed), "the new version trims when it stops");
  });

  it("sorts a journal handed in by index, and trims it when the run stops", () => {
    const run = handedInRows(RUN, new Map([[1, entry(1, "b")], [0, entry(0, "a")]]));
    assert.deepEqual(rows(run.saved("running").journal), [[0, "a"], [1, "b"]]);
    run.call(call(1, "x", "result"), undefined);
    assert.deepEqual(rows(run.saved("failed").journal), [[0, "a"]]);
  });
});

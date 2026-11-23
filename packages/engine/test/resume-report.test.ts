import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildResumeReport, startResumeReport, type ResumingRun } from "../src/resume-report.js";
import type { PreparedResume } from "../src/resume.js";
import type { PersistedRunState } from "../src/runs/persistence/run-persistence.js";
import type { WorkflowResumeCallDecision } from "../src/workflow-result.js";

// A resumed run's report, as `orc show --json` prints it. The manager tests reach these rules only
// through whole resumes. These tests guard them one by one, with no run: the first call that did
// not replay, the replayed prefix, and each difference between the source run and this one. They
// compare the JSON text where the key order is what a reader sees.

const SOURCE_RUN_ID = "source-run";
const RUNTIME = { engineVersion: "1.2.0", node: "v24.0.0", v8: "13.0", pathFormat: 1, inputsFormat: 2 };
const LIMITS = { maxAgents: 50, concurrency: 4, agentRetries: 2 };
const OCCURRENCE: PreparedResume = { strategy: "occurrence-v1", sourceRunId: SOURCE_RUN_ID, requestedPolicy: "auto" };

function source(overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    runId: SOURCE_RUN_ID,
    workflowName: "source",
    script: "return null",
    status: "completed",
    phases: [],
    agents: [],
    logs: [],
    runtime: { ...RUNTIME },
    environment: { key: "workspace-v1" },
    limits: { ...LIMITS },
    callsAllocated: 3,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<ResumingRun> = {}): ResumingRun {
  return { runtime: { ...RUNTIME }, environment: { key: "workspace-v1" }, limits: { ...LIMITS }, ...overrides };
}

const replayedCall = (index: number): WorkflowResumeCallDecision => ({
  index, kind: "agent", action: "replayed", sourceRunId: SOURCE_RUN_ID, recordedIndex: index, match: "occurrence",
});
const liveCall = (index: number): WorkflowResumeCallDecision => ({
  index, kind: "agent", action: "live", reason: "empty-output",
});

describe("incremental resume report construction", () => {
  it("sorts cloned decisions, computes counters, and emits only strategy fields", () => {
    const decisions: WorkflowResumeCallDecision[] = [
      { index: 2, kind: "agent", action: "failed", reason: "resume-fatal-latch" },
      { index: 0, kind: "agent", action: "replayed", sourceRunId: SOURCE_RUN_ID, recordedIndex: 7, match: "occurrence" },
      { index: 1, kind: "checkpoint", action: "live", reason: "not-recorded" },
    ];
    const report = buildResumeReport({
      strategy: "occurrence-v1",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
    }, decisions);
    assert.deepEqual(report, {
      strategy: "occurrence-v1",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
      replayed: 1,
      live: 1,
      failed: 1,
      calls: [decisions[1], decisions[2], decisions[0]],
    });
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.calls), true);
    assert.notEqual(report.calls, decisions);
    assert.throws(() => buildResumeReport({
      strategy: "occurrence-v1",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
    }, [decisions[0], { ...decisions[0] }]));

    const live = buildResumeReport({
      strategy: "live",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
      disabledReason: "cwd-mismatch",
    }, []);
    assert.deepEqual(live, {
      strategy: "live",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
      replayed: 0,
      live: 0,
      failed: 0,
      calls: [],
      disabledReason: "cwd-mismatch",
    });
  });
});

describe("the start of a resumed run's report", () => {
  it("has no decision, and no first non-replay when the source can replay every call", () => {
    const reporting = startResumeReport({ plan: OCCURRENCE, source: source(), run: run(), predictedReplayablePrefix: 3 });
    assert.equal(JSON.stringify(reporting.report()), JSON.stringify({
      strategy: "occurrence-v1",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
      replayed: 0,
      live: 0,
      failed: 0,
      calls: [],
    }));
    assert.equal(JSON.stringify(reporting.eligibility()), JSON.stringify({
      sourceRunId: SOURCE_RUN_ID,
      strategy: "occurrence-v1",
      predictedReplayablePrefix: 3,
      replayedPrefix: 0,
      replayed: 0,
      live: 0,
      failed: 0,
      sourceEngineVersion: "1.2.0",
      currentEngineVersion: "1.2.0",
      engineVersionComparison: "same",
      sourceInputsFormat: 2,
      currentInputsFormat: 2,
      provenanceChanges: [],
      operationalChanges: [],
    }));
    assert.equal(Object.isFrozen(reporting.report()), true);
    assert.equal(Object.isFrozen(reporting.eligibility()), true);
  });

  it("names the first call the source has no result for", () => {
    const short = startResumeReport({ plan: OCCURRENCE, source: source(), run: run(), predictedReplayablePrefix: 1 });
    assert.deepEqual(short.eligibility().firstNonReplay, {
      index: 1,
      action: "live",
      reason: "not-recorded",
      detail: "source has no contiguous replayable result at call 1",
    });
    const empty = startResumeReport({
      plan: OCCURRENCE,
      source: source({ callsAllocated: 0 }),
      run: run(),
      predictedReplayablePrefix: 0,
    });
    assert.equal(empty.eligibility().firstNonReplay?.index, 0);
    assert.equal(empty.eligibility().firstNonReplay?.reason, "not-recorded");
  });

  it("starts a live admission at call 0 with its reason", () => {
    for (const [disabledReason, detail] of [
      ["cwd-mismatch", "source effectiveCwd differs from this run"],
      ["source-not-terminal", "source status is not terminal"],
    ] as const) {
      const plan: PreparedResume = { strategy: "live", sourceRunId: SOURCE_RUN_ID, requestedPolicy: "auto", disabledReason };
      const reporting = startResumeReport({ plan, source: source(), run: run(), predictedReplayablePrefix: 0 });
      assert.equal(reporting.report().disabledReason, disabledReason);
      const eligibility = reporting.eligibility();
      assert.equal(eligibility.strategy, "live");
      assert.equal(eligibility.disabledReason, disabledReason);
      assert.deepEqual(eligibility.firstNonReplay, { index: 0, action: "live", reason: disabledReason, detail });
    }
  });
});

describe("decisions in a resumed run's report", () => {
  it("count the calls, the replayed prefix from call 0, and the first call that did not replay", () => {
    const reporting = startResumeReport({ plan: OCCURRENCE, source: source(), run: run(), predictedReplayablePrefix: 1 });
    reporting.decide(replayedCall(1));
    assert.equal(reporting.eligibility().replayedPrefix, 0, "call 0 has no decision yet");
    reporting.decide(replayedCall(0));
    reporting.decide(liveCall(2));
    reporting.decide(replayedCall(3));

    const report = reporting.report();
    assert.deepEqual(report.calls.map((call) => call.index), [0, 1, 2, 3]);
    assert.deepEqual([report.replayed, report.live, report.failed], [3, 1, 0]);
    const eligibility = reporting.eligibility();
    assert.equal(eligibility.replayedPrefix, 2);
    assert.deepEqual([eligibility.replayed, eligibility.live, eligibility.failed], [3, 1, 0]);
    assert.deepEqual(eligibility.firstNonReplay, { index: 2, action: "live", reason: "empty-output" });
    assert.equal(eligibility.predictedReplayablePrefix, 1);
  });

  it("keep the predicted first non-replay while every call so far replayed", () => {
    const reporting = startResumeReport({ plan: OCCURRENCE, source: source(), run: run(), predictedReplayablePrefix: 1 });
    reporting.decide(replayedCall(0));
    assert.equal(reporting.eligibility().firstNonReplay?.reason, "not-recorded");
    assert.equal(reporting.eligibility().firstNonReplay?.index, 1);
  });
});

describe("what differs between the source run and this one", () => {
  it("compares the engine version and the inputs format", () => {
    const newer = startResumeReport({
      plan: OCCURRENCE,
      source: source(),
      run: run({ runtime: { ...RUNTIME, engineVersion: "1.3.0" } }),
      predictedReplayablePrefix: 3,
    }).eligibility();
    assert.equal(newer.sourceEngineVersion, "1.2.0");
    assert.equal(newer.currentEngineVersion, "1.3.0");
    assert.equal(newer.engineVersionComparison, "different");

    const unversioned = { node: RUNTIME.node, v8: RUNTIME.v8, pathFormat: RUNTIME.pathFormat };
    const unknown = startResumeReport({
      plan: OCCURRENCE,
      source: source({ runtime: unversioned as PersistedRunState["runtime"] }),
      run: run(),
      predictedReplayablePrefix: 3,
    }).eligibility();
    assert.equal("sourceEngineVersion" in unknown, false);
    assert.equal(unknown.engineVersionComparison, "source-unknown");
    assert.equal("sourceInputsFormat" in unknown, false);
    assert.equal(unknown.currentInputsFormat, 2);
  });

  it("lists the Node and V8 changes, with 'unavailable' for a value the source did not record", () => {
    const changed = startResumeReport({
      plan: OCCURRENCE,
      source: source(),
      run: run({ runtime: { ...RUNTIME, node: "v25.0.0", v8: "14.0" } }),
      predictedReplayablePrefix: 3,
    }).eligibility();
    assert.deepEqual(changed.provenanceChanges, [
      { field: "runtime.node", source: "v24.0.0", current: "v25.0.0", detail: "source recorded runtime.node=v24.0.0; this run: v25.0.0" },
      { field: "runtime.v8", source: "13.0", current: "14.0", detail: "source recorded runtime.v8=13.0; this run: 14.0" },
    ]);

    const unrecorded = startResumeReport({ plan: OCCURRENCE, source: source({ runtime: undefined }), run: run(), predictedReplayablePrefix: 3 });
    assert.equal(
      unrecorded.eligibility().provenanceChanges?.[0]?.detail,
      "source recorded runtime.node=unavailable; this run: v24.0.0",
    );
  });

  it("compares git HEAD and the dirty digest when both runs have a git identity", () => {
    const eligibility = startResumeReport({
      plan: OCCURRENCE,
      source: source({ environment: { git: { head: "aaa", dirtyDigest: "d1" } } }),
      run: run({ environment: { git: { head: "bbb", dirtyDigest: "d2" } } }),
      predictedReplayablePrefix: 3,
    }).eligibility();
    assert.deepEqual(eligibility.provenanceChanges?.map((change) => [change.field, change.detail]), [
      ["environment.git.head", "source recorded git HEAD=aaa; this run: bbb"],
      ["environment.git.dirtyDigest", "source recorded git dirty digest=d1; this run: d2"],
    ]);
  });

  it("reports only the kind of identity when the kinds differ", () => {
    const eligibility = startResumeReport({
      plan: OCCURRENCE,
      source: source({ environment: { git: { head: "aaa", dirtyDigest: "d1" } } }),
      run: run({ environment: { key: "workspace-v2" } }),
      predictedReplayablePrefix: 3,
    }).eligibility();
    assert.deepEqual(eligibility.provenanceChanges, [{
      field: "environment.identity",
      source: "git",
      current: "key",
      detail: "source recorded environment identity=git; this run: key",
    }]);
    const none = startResumeReport({
      plan: OCCURRENCE,
      source: source(),
      run: run({ environment: undefined }),
      predictedReplayablePrefix: 3,
    }).eligibility();
    assert.equal(none.provenanceChanges?.[0]?.detail, "source recorded environment identity=key; this run: unavailable");
  });

  it("compares the environment key, the source's terminal environment first", () => {
    const eligibility = startResumeReport({
      plan: OCCURRENCE,
      source: source({
        environment: { key: "at-start" },
        resume: { format: "identity-v1", terminalEnvironment: { key: "at-end" } },
      }),
      run: run({ environment: { key: "now" } }),
      predictedReplayablePrefix: 3,
    }).eligibility();
    assert.deepEqual(eligibility.provenanceChanges, [{
      field: "environment.key",
      source: "at-end",
      current: "now",
      detail: "source recorded environment key=at-end; this run: now",
    }]);
  });

  it("lists agentRetries and concurrency changes, not maxAgents, and none without the source's limits", () => {
    const changed = startResumeReport({
      plan: OCCURRENCE,
      source: source(),
      run: run({ limits: { maxAgents: 10, concurrency: 8, agentRetries: 0 } }),
      predictedReplayablePrefix: 3,
    }).eligibility();
    assert.deepEqual(changed.operationalChanges, [
      { option: "agentRetries", source: 2, current: 0, detail: "source recorded agentRetries=2; this run: 0" },
      { option: "concurrency", source: 4, current: 8, detail: "source recorded concurrency=4; this run: 8" },
    ]);
    const unrecorded = startResumeReport({
      plan: OCCURRENCE,
      source: source({ limits: undefined }),
      run: run({ limits: { maxAgents: 10, concurrency: 8, agentRetries: 0 } }),
      predictedReplayablePrefix: 3,
    }).eligibility();
    assert.deepEqual(unrecorded.operationalChanges, []);
  });
});

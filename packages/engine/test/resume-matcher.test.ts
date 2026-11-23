import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { JournalEntry, WorkflowCallRecord } from "../src/workflow-result.js";
import { WorkflowErrorCode } from "../src/errors.js";
import {
  admitResumeSource,
  cloneResumeCallBlocker,
  cloneResumeCandidate,
  normalizeResumeSeed,
} from "../src/resume-matcher.js";
import type {
  PersistedCheckpointInjection,
  PersistedResumeCandidate,
  PersistedResumeCallBlocker,
  PersistedRunState,
} from "../src/runs/persistence/run-persistence.js";
import { CALL_INPUTS_FORMAT } from "../src/workflow.js";
import { CALL_PATH_FORMAT } from "../src/call-path.js";
import { CHECKPOINT_INPUTS_FORMAT } from "../src/checkpoint-call.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const INPUT_A = "1".repeat(64);
const INPUT_B = "2".repeat(64);
const INPUT_C = "3".repeat(64);
const SOURCE_RUN_ID = "source-run";
const CWD = "/workspace/project";
const ENVIRONMENT = { git: { head: "f".repeat(40), dirtyDigest: "d".repeat(64) } };
const RUNTIME = {
  node: process.version,
  v8: process.versions.v8,
  pathFormat: CALL_PATH_FORMAT,
  inputsFormat: CALL_INPUTS_FORMAT,
  checkpointInputsFormat: CHECKPOINT_INPUTS_FORMAT,
};

function agentRow(index = 0, overrides: Partial<WorkflowCallRecord> = {}): WorkflowCallRecord {
  return {
    index,
    kind: "agent",
    hash: HASH_A,
    path: `workflow.js:${index + 1}:1`,
    inputsHash: INPUT_A,
    outcome: "result",
    origin: "runner",
    scope: SOURCE_RUN_ID,
    ...overrides,
  };
}

function checkpointRow(index = 0, overrides: Partial<WorkflowCallRecord> = {}): WorkflowCallRecord {
  return {
    index,
    kind: "checkpoint",
    ...(overrides.outcome === undefined || overrides.outcome === "result" ? { checkpointDecision: "explicit-v1" as const } : {}),
    hash: HASH_B,
    path: `workflow.js:${index + 1}:1`,
    inputsHash: INPUT_B,
    outcome: "result",
    origin: "confirm",
    scope: SOURCE_RUN_ID,
    ...overrides,
  };
}

function entryFor(call: WorkflowCallRecord, result: unknown = `result-${call.index}`): JournalEntry {
  return {
    index: call.index,
    hash: call.hash,
    result,
    kind: call.kind,
    ...(call.checkpointDecision === undefined ? {} : { checkpointDecision: call.checkpointDecision }),
    scope: call.scope,
  };
}

function sourceState(
  calls: WorkflowCallRecord[] = [agentRow()],
  overrides: Partial<PersistedRunState> = {},
): PersistedRunState {
  return {
    runId: SOURCE_RUN_ID,
    workflowName: "resume-source",
    script: "export const meta = { name: 'resume-source', description: 'test' }\nreturn null",
    effectiveCwd: CWD,
    runtime: { ...RUNTIME },
    environment: structuredClone(ENVIRONMENT),
    resume: { format: "identity-v1", terminalEnvironment: structuredClone(ENVIRONMENT) },
    status: "completed",
    phases: [],
    agents: [],
    logs: [],
    journal: calls.filter((call) => call.outcome === "result").map((call) => entryFor(call)),
    calls,
    callsAllocated: calls.length,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function admission(source: PersistedRunState, effectiveCwd = CWD) {
  return admitResumeSource({ source, effectiveCwd });
}

function candidate(
  index = 0,
  overrides: {
    call?: Partial<WorkflowCallRecord>;
    entry?: Partial<JournalEntry>;
    sourceRunId?: string;
  } = {},
): PersistedResumeCandidate {
  const sourceRunId = overrides.sourceRunId ?? SOURCE_RUN_ID;
  const call = agentRow(index, { scope: sourceRunId, ...overrides.call });
  const entry = { ...entryFor(call), scope: sourceRunId, ...overrides.entry };
  return {
    sourceRunId,
    recordedIndex: index,
    entry,
    call,
  };
}

function injection(index = 0, overrides: Partial<PersistedCheckpointInjection> = {}): PersistedCheckpointInjection {
  return {
    checkpointDecision: "explicit-v1",
    sourceRunId: SOURCE_RUN_ID,
    recordedIndex: index,
    hash: HASH_B,
    path: `workflow.js:${index + 1}:1`,
    inputsHash: INPUT_B,
    decision: true,
    ...overrides,
  };
}

function blocker(index = 0, overrides: Partial<WorkflowCallRecord> = {}): PersistedResumeCallBlocker {
  return {
    sourceRunId: SOURCE_RUN_ID,
    recordedIndex: index,
    call: agentRow(index, {
      outcome: "error",
      origin: "engine",
      error: {
        form: "workflow-error",
        message: "interrupted",
        code: WorkflowErrorCode.WORKFLOW_ABORTED,
        recoverable: true,
      },
      aborted: true,
      ...overrides,
    }),
  };
}


describe("incremental resume admission", () => {
  it("pairs by occurrence with an ended source run in the same folder", () => {
    const legacy = sourceState();
    delete legacy.resume;
    const failedCall = checkpointRow(0, {
      outcome: "error",
      origin: "engine",
      error: { form: "workflow-error", message: "stopped", code: WorkflowErrorCode.UNKNOWN },
    });
    const cases: Array<[string, PersistedRunState]> = [
      ["current", sourceState()],
      ["legacy recording", legacy],
      ["failed call", sourceState([failedCall])],
      ["interrupted call", sourceState([blocker().call])],
      ["nested", sourceState(undefined, { nestedWorkflows: true })],
      ["paused", sourceState(undefined, { status: "paused", pauseReason: "interrupted" })],
      ["failed", sourceState(undefined, { status: "failed" })],
      ["aborted", sourceState(undefined, { status: "aborted" })],
      ["abort marker", sourceState(undefined, { abortSignaled: true })],
      ["older call-input format", sourceState(undefined, { runtime: { ...RUNTIME, inputsFormat: 1 } })],
      ["no runtime saved", sourceState(undefined, { runtime: undefined })],
      ["no folder saved", sourceState(undefined, { effectiveCwd: undefined })],
    ];
    for (const [name, source] of cases) {
      assert.deepEqual(
        admission(source),
        { strategy: "occurrence-v1", sourceRunId: SOURCE_RUN_ID, requestedPolicy: "auto" },
        name,
      );
    }
  });

  it("runs every call live for a source that has not ended or ran in another folder", () => {
    const live = (disabledReason: string) => ({
      strategy: "live",
      sourceRunId: SOURCE_RUN_ID,
      requestedPolicy: "auto",
      disabledReason,
    });
    assert.deepEqual(admission(sourceState(undefined, { status: "running" })), live("source-not-terminal"));
    assert.deepEqual(admission(sourceState(), "/other"), live("cwd-mismatch"));
    assert.deepEqual(
      admission(sourceState(undefined, { status: "running", abortSignaled: true }), "/other"),
      live("source-not-terminal"),
      "a source that has not ended is checked first",
    );
  });

  it("refuses a source with a question answered by no explicit decision", () => {
    assert.throws(
      () => admission(sourceState([checkpointRow(0, { origin: "headless" as never })])),
      /checkpoint-provenance-incompatible/,
    );
  });

  it("replays across retry/concurrency changes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "resume-knobs-cwd-"));
    const persistenceRoot = mkdtempSync(join(tmpdir(), "resume-knobs-runs-"));
    const script = `export const meta = { name: "resume-knobs", description: "resume knobs" };
const first = await agent("first", { label: "first" });
const second = await agent("second", { label: "second" });
return { first, second };`;
    let liveCalls = 0;
    const manager = new WorkflowManager({
      cwd,
      persistenceRoot,
      agent: {
        async run(prompt) {
          liveCalls++;
          return `recorded:${prompt}`;
        },
      },
    });
    try {
      const source = await manager.runSync(script, undefined, {
        agentRetries: 1,
        concurrency: 2,
      });
      assert.equal(liveCalls, 2);
      const sourceState = manager.getPersistence().load(source.runId);
      assert.ok(sourceState?.runtime);
      sourceState.runtime.engineVersion = "0.25.0";
      manager.getPersistence().save(sourceState);
      const variants = [
        { runId: "retries-changed", agentRetries: 0 },
        { runId: "concurrency-changed", concurrency: 7 },
      ] as const;
      for (const variant of variants) {
        const resumed = await manager.runSync(script, undefined, {
          ...variant,
          resumeFromRunId: source.runId,
        });
        assert.equal(resumed.resumeReport?.strategy, "occurrence-v1", variant.runId);
        assert.equal(resumed.resumeReport?.replayed, 2, variant.runId);
        assert.equal(resumed.resumeReport?.live, 0, variant.runId);
        assert.equal(resumed.replayEligibility?.engineVersionComparison, "different", variant.runId);
      }
      assert.equal(liveCalls, 2, "operational changes never invoke the runner for completed calls");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(persistenceRoot, { recursive: true, force: true });
    }
  });

  it("validates seed rows", () => {
    const replayCall = agentRow(0, {
      origin: "journal-replay",
      replay: {
        sourceRunId: "older-run",
        recordedIndex: 7,
        match: "unique-hash",
      },
    });
    const cloned = cloneResumeCandidate(SOURCE_RUN_ID, entryFor(replayCall), replayCall);
    assert.notEqual(cloned?.call, replayCall);
    assert.deepEqual(cloned?.call, replayCall);

    const validRetained = candidate(2, { sourceRunId: "older-run", call: { hash: HASH_C, inputsHash: INPUT_C } });
    const kept = normalizeResumeSeed({ sourceRunId: SOURCE_RUN_ID, promoted: [candidate()], retained: [validRetained] });
    assert.equal(kept?.candidates.length, 2);

    const invalidBlocker = blocker();
    invalidBlocker.recordedIndex = 1;
    assert.equal(normalizeResumeSeed({ sourceRunId: SOURCE_RUN_ID, retainedBlockers: [invalidBlocker] }), undefined);
    assert.equal(cloneResumeCandidate(SOURCE_RUN_ID, entryFor(agentRow()), agentRow(0, { path: undefined })), undefined);
    assert.equal(cloneResumeCandidate(SOURCE_RUN_ID, entryFor(agentRow()), agentRow(0, { inputsHash: undefined })), undefined);

    const collision = normalizeResumeSeed({
      sourceRunId: SOURCE_RUN_ID,
      promoted: [candidate()],
      retained: [candidate()],
    });
    assert.equal(collision, undefined);
    const crossKindCollision = normalizeResumeSeed({
      sourceRunId: SOURCE_RUN_ID,
      promoted: [candidate()],
      retainedInjections: [injection()],
    });
    assert.equal(crossKindCollision, undefined);
  });

  it("accepts seed rows of a nested run, and refuses a row of another run", () => {
    const nestedScope = `${SOURCE_RUN_ID}-nested1`;
    const nested = agentRow(0, { scope: nestedScope, hash: HASH_C, inputsHash: INPUT_C });
    assert.ok(cloneResumeCandidate(SOURCE_RUN_ID, entryFor(nested), nested));
    const foreign = agentRow(0, { scope: "other-run", hash: HASH_C, inputsHash: INPUT_C });
    assert.equal(cloneResumeCandidate(SOURCE_RUN_ID, entryFor(foreign), foreign), undefined);

    // A nested seed row and a root row with the same index are two occurrences.
    const nestedCandidate = candidate(0, {
      call: { scope: nestedScope, hash: HASH_C, inputsHash: INPUT_C },
      entry: { scope: nestedScope },
    });
    const withNested = normalizeResumeSeed({ sourceRunId: SOURCE_RUN_ID, promoted: [candidate()], retained: [nestedCandidate] });
    assert.equal(withNested?.candidates.length, 2);

    const splitScopes = candidate(0, { call: { scope: nestedScope, hash: HASH_C, inputsHash: INPUT_C } });
    assert.equal(normalizeResumeSeed({ sourceRunId: SOURCE_RUN_ID, retained: [splitScopes] }), undefined);
  });

  it("admits a paused checkpoint source and keeps the pending question as a failed row", () => {
    const context = { callIndex: 1, hash: HASH_B, prompt: "approve?", kind: "confirm" as const };
    const pending = checkpointRow(1, {
      outcome: "error",
      origin: "engine",
      error: {
        form: "workflow-error",
        message: "awaits reply",
        code: WorkflowErrorCode.CHECKPOINT_REQUIRED,
      },
    });
    const paused = sourceState([agentRow(0), pending], {
      status: "paused",
      pauseReason: "checkpoint_required",
      checkpointContext: context,
    });
    assert.equal(admission(paused).strategy, "occurrence-v1");
    assert.equal(cloneResumeCallBlocker(SOURCE_RUN_ID, pending)?.call.outcome, "error");
  });
});

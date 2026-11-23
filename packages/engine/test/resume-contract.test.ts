import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { WorkflowCallRecord, WorkflowResumeCallDecision } from "../src/workflow-result.js";
import { CALL_INPUTS_FORMAT, type WorkflowRunOptions } from "../src/workflow.js";
import { CALL_PATH_FORMAT } from "../src/call-path.js";
import { CHECKPOINT_INPUTS_FORMAT } from "../src/checkpoint-call.js";
import type { LiveResume, OccurrenceResume } from "../src/resume.js";
import type {
  PersistedCheckpointInjection,
  PersistedResumeCandidate,
  PersistedResumeFormat,
  PersistedResumeSeed,
  PersistedRunState,
} from "../src/runs/persistence/run-persistence.js";

const HASH = "a".repeat(64);

const sourceCall: WorkflowCallRecord = {
  index: 3,
  kind: "agent",
  hash: HASH,
  path: "workflow.js:3:1",
  inputsHash: HASH,
  outcome: "result",
  origin: "runner",
  resumeSafety: "declared-read-only",
  scope: "source-run",
};
const candidate: PersistedResumeCandidate = {
  sourceRunId: "source-run",
  recordedIndex: 3,
  entry: {
    index: 3,
    hash: HASH,
    result: "cached",
    kind: "agent",
    scope: "source-run",
  },
  call: sourceCall,
};
const injection: PersistedCheckpointInjection = {
  checkpointDecision: "explicit-v1",
  sourceRunId: "source-run",
  recordedIndex: 4,
  hash: HASH,
  path: "workflow.js:4:1",
  inputsHash: HASH,
  decision: { accepted: true },
};
const seed: PersistedResumeSeed = {
  format: "identity-v1",
  sourceRunId: "source-run",
  candidates: [candidate],
  checkpointInjections: [injection],
};
const format: PersistedResumeFormat = {
  format: "identity-v1",
  terminalEnvironment: { git: { head: HASH, dirtyDigest: HASH } },
};
const occurrencePrepared: OccurrenceResume = {
  strategy: "occurrence-v1",
  sourceRunId: "source-run",
  requestedPolicy: "auto",
};
const livePrepared: LiveResume = {
  strategy: "live",
  sourceRunId: "source-run",
  requestedPolicy: "auto",
  disabledReason: "cwd-mismatch",
};

const runner: AgentRunner = {
  async run() {
    return "unused" as never;
  },
};
const decisions: WorkflowResumeCallDecision[] = [];
const activities: number[] = [];
const allocations: number[] = [];
let filesystemTainted = false;
const runOptions: WorkflowRunOptions = {
  agent: runner,
  resume: { rows: new Map(), plan: occurrencePrepared },
  onResumeFilesystemTainted: () => {
    filesystemTainted = true;
  },
  onResumeActivity: (active) => activities.push(active),
  onResumeCallAllocated: (allocated) => allocations.push(allocated),
  onResumeDecision: (decision) => decisions.push(decision),
};

const legacyState: PersistedRunState = {
  runId: "legacy-run",
  workflowName: "legacy",
  script: "return null",
  status: "completed",
  phases: [],
  agents: [],
  logs: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  runtime: {
    node: "v22.0.0",
    v8: "12.4",
    pathFormat: CALL_PATH_FORMAT,
    inputsFormat: 1,
  },
};
const identityState: PersistedRunState = {
  ...legacyState,
  runId: "identity-run",
  runtime: {
    ...legacyState.runtime!,
    checkpointInputsFormat: CHECKPOINT_INPUTS_FORMAT,
  },
  resume: format,
  resumeSeed: seed,
  resumeReport: {
    strategy: "identity-v1",
    sourceRunId: "source-run",
    requestedPolicy: "auto",
    replayed: 0,
    live: 0,
    failed: 0,
    calls: [],
  },
};

test("incremental resume format constants match the contract", () => {
  assert.equal(CALL_PATH_FORMAT, 1);
  assert.equal(CALL_INPUTS_FORMAT, 2);
  assert.equal(CHECKPOINT_INPUTS_FORMAT, 2);
});

test("persisted and prepared resume declaration fixtures cover every branch", () => {
  assert.equal(identityState.resume?.terminalEnvironment?.git?.head, HASH);
  assert.equal(identityState.resumeSeed?.checkpointInjections?.[0]?.recordedIndex, 4);
  assert.equal(identityState.runtime?.checkpointInputsFormat, 2);
  assert.equal(occurrencePrepared.strategy, "occurrence-v1");
  assert.equal(livePrepared.disabledReason, "cwd-mismatch");
  assert.equal(runOptions.resume?.plan?.sourceRunId, "source-run");
  runOptions.onResumeFilesystemTainted?.();
  runOptions.onResumeActivity?.(1);
  runOptions.onResumeCallAllocated?.(1);
  runOptions.onResumeDecision?.({
    index: 0,
    kind: "agent",
    action: "live",
    reason: "not-recorded",
  });
  assert.equal(filesystemTainted, true);
  assert.deepEqual(activities, [1]);
  assert.deepEqual(allocations, [1]);
  assert.equal(decisions[0]?.reason, "not-recorded");
});

test("legacy persisted state remains valid and omits additive resume fields", () => {
  const json = JSON.parse(JSON.stringify(legacyState)) as PersistedRunState;
  assert.deepEqual(json.runtime, {
    node: "v22.0.0",
    v8: "12.4",
    pathFormat: 1,
    inputsFormat: 1,
  });
  assert.equal(json.runtime?.checkpointInputsFormat, undefined);
  assert.equal(json.runtime?.engineVersion, undefined);
  assert.equal(json.resume, undefined);
  assert.equal(json.resumeSeed, undefined);
  assert.equal(json.resumeReport, undefined);
  assert.equal(json.replayEligibility, undefined);
  assert.equal(Object.hasOwn(json, "resume"), false);
  assert.equal(Object.hasOwn(json, "resumeSeed"), false);
  assert.equal(Object.hasOwn(json, "resumeReport"), false);
});

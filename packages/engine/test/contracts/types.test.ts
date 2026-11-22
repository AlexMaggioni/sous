import test from "node:test";
import assert from "node:assert/strict";

// The step and run record types: what a step may be given, and what old journals still parse as.
import type { CheckpointContext } from "../../src/errors.js";
import type {
  JournalCallMetadata,
  JournalEntry,
  WorkflowCheckpointTaken,
  WorkflowLogTail,
  WorkflowRunFallback,
  WorkflowRunInspectionOptions,
  WorkflowRunResult,
  WorkflowRunStatus,
} from "../../src/workflow-result.js";

test("CheckpointContext has the fields a paused checkpoint records", () => {
  const context: CheckpointContext = {
    callIndex: 0,
    hash: "hash",
    prompt: "Continue?",
    kind: "confirm",
  };
  assert.equal(context.kind, "confirm");
});

test("run-observability contracts are exported and legacy journals remain valid", () => {
  const legacy: JournalEntry = { index: 0, hash: "legacy", result: "cached" };
  const agentCall: JournalCallMetadata = {
    kind: "agent",
    label: "review",
    phase: "Review",
    model: "provider/model",
    backendId: "provider",
  };
  const checkpointCall: JournalCallMetadata = { kind: "checkpoint", label: "checkpoint", phase: "Review" };
  const entries: JournalEntry[] = [
    legacy,
    { index: 1, hash: "agent", result: { ok: true }, call: agentCall },
    { index: 2, hash: "checkpoint", result: true, kind: "checkpoint", checkpointDecision: "explicit-v1", call: checkpointCall },
  ];
  const options: WorkflowRunInspectionOptions = { lastN: 10, labelGlob: "review*", logLines: 5 };
  const tail: WorkflowLogTail = {
    lines: ["done"],
    totalLines: 1,
    omittedLines: 0,
    truncatedLines: 0,
    redactedLines: 0,
  };
  const status: WorkflowRunStatus = {
    runId: "mabc-def",
    status: "completed",
    workflowName: "review",
    phases: ["Review"],
    logTail: tail,
    calls: [],
    filter: { lastN: options.lastN ?? 20, logLines: options.logLines ?? 20, labelGlob: options.labelGlob },
    truncation: {
      maxStructuredBytes: 24_576,
      byteCapApplied: false,
      phases: { total: 1, returned: 1, shortened: 0 },
      logs: { total: 1, returned: 1, shortened: 0, redacted: 0 },
      calls: { total: 3, matched: 1, returned: 0, shortenedResults: 0, redactedResults: 0 },
    },
  };
  assert.equal(entries[0]?.call, undefined);
  assert.equal(entries[1]?.call?.kind, "agent");
  assert.equal(entries[2]?.call?.kind, "checkpoint");
  assert.equal(status.logTail.lines[0], "done");
});

test("run-result observability entries are exported and remain additive", () => {
  type StatusExcludesFallbacks = "fallbacks" extends keyof WorkflowRunStatus ? never : true;
  type StatusExcludesCheckpoints = "checkpointsTaken" extends keyof WorkflowRunStatus ? never : true;
  const statusExcludesFallbacks: StatusExcludesFallbacks = true;
  const statusExcludesCheckpoints: StatusExcludesCheckpoints = true;
  const fallback: WorkflowRunFallback = {
    callIndex: 1,
    label: "review",
    phase: "Review",
    requestedSpec: "gpt-example[high]",
    resolvedModel: "gpt-example",
    backendId: "codex",
    kind: "modifier",
    message: 'review: model "gpt-example[high]: reasoning_effort "high" not advertised" unavailable — using the session default',
  };
  const checkpoint: WorkflowCheckpointTaken = {
    callIndex: 2,
    kind: "confirm",
    decision: true,
    source: "journal-replay",
  };
  const legacyResult: WorkflowRunResult = {
    runId: "mabc-def",
    status: "completed",
    meta: { name: "legacy", description: "legacy" },
    result: null,
    phases: [],
    agentCount: 0,
    durationMs: 1,
    logs: [],
  };
  const observedResult: WorkflowRunResult = {
    ...legacyResult,
    fallbacks: [fallback],
    checkpointsTaken: [checkpoint],
  };
  assert.equal(legacyResult.fallbacks, undefined);
  assert.equal(observedResult.fallbacks?.[0]?.kind, "modifier");
  assert.equal(observedResult.checkpointsTaken?.[0]?.source, "journal-replay");
  assert.equal(statusExcludesFallbacks, true);
  assert.equal(statusExcludesCheckpoints, true);
});

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
  WorkflowRunResult,
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

test("journal call attribution and the log tail are exported and legacy journals remain valid", () => {
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
  const tail: WorkflowLogTail = {
    lines: ["done"],
    totalLines: 1,
    omittedLines: 0,
    truncatedLines: 0,
    redactedLines: 0,
  };
  assert.equal(entries[0]?.call, undefined);
  assert.equal(entries[1]?.call?.kind, "agent");
  assert.equal(entries[2]?.call?.kind, "checkpoint");
  assert.equal(tail.lines[0], "done");
});

test("run-result observability entries are exported and remain additive", () => {
  const fallback: WorkflowRunFallback = {
    callIndex: 1,
    label: "review",
    phase: "Review",
    requestedSpec: "gpt-example[high]",
    backendId: "codex",
    kind: "continuation",
    continuation: { outcome: "reattached", method: "resume" },
    message: "continuation: reattached via session/resume",
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
  assert.equal(observedResult.fallbacks?.[0]?.kind, "continuation");
  assert.equal(observedResult.checkpointsTaken?.[0]?.source, "journal-replay");
});

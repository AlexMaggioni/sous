import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { afterFailedAttempt, HOST_HANDLED_CODES, type FailedAttempt } from "../src/failed-attempt.js";

// The rule on its own, with no run. Each row is one failed attempt and the move it leads to.

const stop = new WorkflowError("stopped by the user", WorkflowErrorCode.AGENT_CANCELLED, { recoverable: false });
const recoverable = new WorkflowError("flaky", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
const fatal = new WorkflowError("bad schema", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
const usageLimit = new WorkflowError("usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
const aborted = new WorkflowError("aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });

type Attempt = {
  hostStop?: WorkflowError;
  runStopped?: boolean;
  pausePending?: boolean;
  thrown: unknown;
  attempt: number;
  maxAttempts: number;
};
type Row = Attempt & { name: string; next: FailedAttempt["next"] };

const rows: Row[] = [
  // The order of the first three: the host's stop, then the run's stop, then a pending pause.
  { name: "a host stop comes before everything else", hostStop: stop, runStopped: true, pausePending: true, thrown: recoverable, attempt: 1, maxAttempts: 3, next: "host-stopped" },
  { name: "a run stop comes before a pause and a retry", runStopped: true, pausePending: true, thrown: recoverable, attempt: 1, maxAttempts: 3, next: "run-stopped" },
  { name: "a pending pause comes before a retry", pausePending: true, thrown: recoverable, attempt: 1, maxAttempts: 3, next: "pause-pending" },
  // Retries.
  { name: "a recoverable error with attempts left retries", thrown: recoverable, attempt: 1, maxAttempts: 2, next: "retry" },
  { name: "a recoverable error on the last attempt pauses the run", thrown: recoverable, attempt: 2, maxAttempts: 2, next: "pause-run" },
  { name: "a recoverable error with no retries pauses the run", thrown: recoverable, attempt: 1, maxAttempts: 1, next: "pause-run" },
  { name: "an error a retry cannot fix pauses the run at once", thrown: fatal, attempt: 1, maxAttempts: 3, next: "pause-run" },
  // Errors the host handles.
  { name: "a recoverable error the host handles still retries", thrown: aborted, attempt: 1, maxAttempts: 2, next: "retry" },
  { name: "a recoverable error the host handles returns null on the last attempt", thrown: aborted, attempt: 2, maxAttempts: 2, next: "return-null" },
  { name: "an error the host handles and a retry cannot fix goes up", thrown: usageLimit, attempt: 1, maxAttempts: 3, next: "throw" },
  // Values that are not WorkflowErrors.
  { name: "a plain error is a recoverable execution error", thrown: new Error("boom"), attempt: 1, maxAttempts: 2, next: "retry" },
  { name: "an abort error is a recoverable abort the host handles", thrown: new DOMException("gone", "AbortError"), attempt: 1, maxAttempts: 1, next: "return-null" },
];

const decide = (attempt: Attempt) =>
  afterFailedAttempt({
    hostStop: attempt.hostStop,
    runStopped: attempt.runStopped ?? false,
    pausePending: attempt.pausePending ?? false,
    thrown: attempt.thrown,
    label: "step",
    attempt: attempt.attempt,
    maxAttempts: attempt.maxAttempts,
  });

describe("after a failed attempt", () => {
  for (const row of rows) {
    it(row.name, () => {
      assert.equal(decide(row).next, row.next);
    });
  }

  it("gives the host's reason for a host stop, and the wrapped error from a retry on", () => {
    const stopped = decide({ hostStop: stop, thrown: recoverable, attempt: 1, maxAttempts: 1 });
    assert.deepEqual(stopped, { next: "host-stopped", reason: stop });
    const kept = decide({ thrown: fatal, attempt: 1, maxAttempts: 1 });
    assert.deepEqual(kept, { next: "pause-run", error: fatal });
    const wrapped = decide({ thrown: new Error("boom"), attempt: 1, maxAttempts: 2 });
    assert.ok(wrapped.next === "retry");
    assert.equal(wrapped.error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(wrapped.error.message, "boom");
    assert.equal(wrapped.error.agentLabel, "step");
  });

  it("reads the thrown value only after the host stop, the run stop and the pause", () => {
    let reads = 0;
    const thrown = {
      get message() {
        reads++;
        return "read";
      },
    };
    for (const before of [{ hostStop: stop }, { runStopped: true }, { pausePending: true }]) {
      decide({ ...before, thrown, attempt: 1, maxAttempts: 2 });
    }
    assert.equal(reads, 0);
    decide({ thrown, attempt: 1, maxAttempts: 2 });
    assert.ok(reads > 0);
  });

  it("pauses the run for every code but the five the host handles, which go up", () => {
    const handled: string[] = [];
    for (const code of Object.values(WorkflowErrorCode)) {
      const error = new WorkflowError(code, code, { recoverable: false });
      const next = decide({ thrown: error, attempt: 1, maxAttempts: 1 }).next;
      if (next === "throw") handled.push(code);
      else assert.equal(next, "pause-run", code);
    }
    assert.deepEqual(handled.sort(), [
      WorkflowErrorCode.AUTH_REQUIRED,
      WorkflowErrorCode.CHECKPOINT_REQUIRED,
      WorkflowErrorCode.PAUSE_REQUESTED,
      WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
      WorkflowErrorCode.WORKFLOW_ABORTED,
    ]);
    assert.equal(HOST_HANDLED_CODES.size, handled.length);
  });
});

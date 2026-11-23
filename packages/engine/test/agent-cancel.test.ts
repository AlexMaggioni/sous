import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StepRequest } from "../src/steps/agent-run.js";
import type { WorkflowCallRecord } from "../src/workflow-result.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  isStepFailedPause,
  runWorkflow,
  type WorkflowAgentAttemptControl,
} from "../src/workflow.js";

const parallelScript = `export const meta = { name: "agent-cancel", description: "per-agent cancellation" }
const values = await parallel([
  () => agent("peer", { label: "peer", retries: 3, resume: { filesystem: "read-only" } }),
  () => agent("cancel", { label: "cancel", retries: 3, resume: { filesystem: "read-only" } }),
])
return { values }`;

function cancelledByHost(): WorkflowError {
  return new WorkflowError(
    "agent call cancelled by host",
    WorkflowErrorCode.AGENT_CANCELLED,
    { recoverable: true },
  );
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function tempDirs(prefix: string): { cwd: string; root: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), `${prefix}-cwd-`));
  const root = mkdtempSync(join(tmpdir(), `${prefix}-root-`));
  return {
    cwd,
    root,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("engine host cancellation settles one call, bypasses retries, lets siblings finish, and pauses the run", async () => {
  const dirs = tempDirs("agent-cancel-engine");
  try {
    const invocations: string[] = [];
    const attempts = new Map<number, WorkflowAgentAttemptControl>();
    const journals: number[] = [];
    const ended: Array<{ callIndex: number; errorCode?: WorkflowErrorCode }> = [];
    const rows: WorkflowCallRecord[] = [];
    const runner = {
      async run(prompt: string, options: StepRequest): Promise<unknown> {
        invocations.push(prompt);
        if (prompt === "peer") return "peer-ok";
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      },
    };

    const running = runWorkflow(parallelScript, {
      cwd: dirs.cwd,
      persistenceRoot: dirs.root,
      persistLogs: false,
      runId: "engine-cancel",
      agent: runner,
      agentRetries: 3,
      onAgentAttempt: (attempt) => {
        attempts.set(attempt.callIndex, attempt);
        return () => attempts.delete(attempt.callIndex);
      },
      onAgentJournal: (entry) => journals.push(entry.index),
      onAgentEnd: (event) => ended.push({ callIndex: event.callIndex, errorCode: event.errorCode }),
      onCallRecord: (row) => rows.push(row),
    });
    await waitUntil(() => attempts.has(1), "the selected attempt should be registered");

    attempts.get(1)!.controller.abort(cancelledByHost());
    // The stopped step pauses the run. A pause, not an abort: the run-level signal stays untouched.
    await assert.rejects(running, (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.PAUSE_REQUESTED);
      assert.ok(isStepFailedPause(error));
      assert.equal((error.details as { code?: unknown }).code, WorkflowErrorCode.AGENT_CANCELLED);
      return true;
    });

    assert.equal(invocations.filter((prompt) => prompt === "cancel").length, 1, "host cancel must not retry");
    assert.equal(invocations.filter((prompt) => prompt === "peer").length, 1);
    assert.deepEqual(journals, [0], "a cancelled step is not a journal result, and the sibling's is");
    assert.equal(attempts.size, 0, "attempt registrations are cleared on settlement");
    assert.deepEqual(ended.find((event) => event.callIndex === 1), {
      callIndex: 1,
      errorCode: WorkflowErrorCode.AGENT_CANCELLED,
    });
    assert.equal(rows.find((record) => record.index === 0)?.outcome, "result");
    const cancelled = rows.find((record) => record.index === 1);
    assert.equal(cancelled?.outcome, "error");
    assert.equal(cancelled?.origin, "engine");
    assert.equal(cancelled?.error?.code, WorkflowErrorCode.AGENT_CANCELLED);
    assert.equal(cancelled?.error?.recoverable, true);
    assert.equal(cancelled?.aborted, undefined);
  } finally {
    dirs.cleanup();
  }
});

test("engine cancellation latch settles an abort-ignoring runner", async () => {
  const dirs = tempDirs("agent-cancel-latch");
  try {
    let control: WorkflowAgentAttemptControl | undefined;
    let cleaned = false;
    let invocations = 0;
    const rows: WorkflowCallRecord[] = [];
    const running = runWorkflow(
      `export const meta = { name: "cancel-latch", description: "ignore abort" }
return await agent("ignore", { label: "ignore", retries: 3 })`,
      {
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        persistLogs: false,
        runId: "cancel-latch",
        agent: {
          async run() {
            invocations++;
            return new Promise<never>(() => {});
          },
        },
        agentRetries: 3,
        onAgentAttempt: (attempt) => {
          control = attempt;
          return () => { cleaned = true; };
        },
        onCallRecord: (row) => rows.push(row),
      },
    );
    await waitUntil(() => control !== undefined, "the abort-ignoring attempt should be registered");
    control!.controller.abort(cancelledByHost());

    const settled = await Promise.race([
      running.then(() => undefined, (error: unknown) => error),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("cancellation latch did not settle")), 500);
      }),
    ]);
    assert.ok(isStepFailedPause(settled as WorkflowError), "the stopped step pauses the run");
    assert.equal(rows[0]?.error?.code, WorkflowErrorCode.AGENT_CANCELLED);
    assert.equal(invocations, 1);
    assert.equal(cleaned, true);
  } finally {
    dirs.cleanup();
  }
});

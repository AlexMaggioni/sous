import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { StepRequest } from "../src/steps/agent-run.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunPersistence } from "../src/runs/persistence/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

function memoryPersistence() {
  const states = new Map<string, PersistedRunState>();
  const saves: PersistedRunState[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const clone = (state: PersistedRunState) => structuredClone(state);
  const persistence: RunPersistence = {
    save(state) {
      const copy = clone(state);
      saves.push(copy);
      states.set(state.runId, copy);
    },
    load(runId) {
      const state = states.get(runId);
      return state ? clone(state) : null;
    },
    list() {
      return [...states.values()].map(clone);
    },
    delete(runId) {
      return states.delete(runId);
    },
    acquireRunLease(runId) {
      acquired.push(runId);
      return { runId, token: `${runId}-lease` };
    },
    releaseRunLease(lease) {
      released.push(lease.runId);
    },
    validateRunLease() {
      return true;
    },
  };
  return { persistence, states, saves, acquired, released };
}

function runnerFrom(impl: (prompt: string, options: StepRequest) => unknown | Promise<unknown>): AgentRunner {
  return { run: (prompt: string, options: StepRequest) => Promise.resolve(impl(prompt, options)) };
}

test("a checkpoint call is attributed in the journal", async () => {
  const store = memoryPersistence();
  const manager = new WorkflowManager({ persistence: store.persistence, agent: runnerFrom(() => "unused") });
  const checkpointOnly = await manager.runSync(
    'export const meta = { name: "checkpoint-metadata", description: "checkpoint", phases: [{ title: "Review" }] };\nphase("Review");\nreturn await checkpoint("continue?");',
    undefined, { confirm: async () => true },
  );
  assert.deepEqual(store.persistence.load(checkpointOnly.runId)?.journal?.[0]?.call, {
    kind: "checkpoint",
    label: "checkpoint",
    phase: "Review",
  });
});

test("journal attribution covers agents, checkpoints, and replay without changing identity", async () => {
  const store = memoryPersistence();
  let calls = 0;
  const runner = runnerFrom((prompt, options) => {
    calls++;
    options.onModelResolved?.("resolved/model");
    options.onSessionOpen?.({
      sessionId: `session-${calls}`,
      backendId: "actual-backend",
      cwd: "/cwd",
      reopen: { load: true, resume: true, list: true },
    });
    return `answer:${prompt}`;
  });
  const manager = new WorkflowManager({ persistence: store.persistence, agent: runner });
  const script = [
    'export const meta = { name: "metadata", description: "metadata", phases: [{ title: "Review" }] };',
    'phase("Review");',
    'const approved = await checkpoint("continue?", { });',
    'const answer = await agent("work", { label: "reviewer" });',
    'return { approved, answer };',
  ].join("\n");
  const paused = await manager.runSync(script);
  assert.equal(paused.status, "paused");
  const resumed = await manager.resumeInBackground(paused.runId, { confirm: async () => "yes" });
  assert.equal(resumed.accepted, true);
  assert.ok(resumed.promise);
  const result = await resumed.promise;
  assert.equal(result.status, "completed");
  const entries = store.persistence.load(paused.runId)?.journal ?? [];
  assert.deepEqual(entries[0]?.call, { kind: "checkpoint", label: "checkpoint", phase: "Review" });
  assert.deepEqual(entries[1]?.call, {
    kind: "agent",
    label: "reviewer",
    phase: "Review",
    model: "resolved/model",
    backendId: "actual-backend",
  });

  const replayMap = new Map(entries.map((entry) => [entry.index, entry] as const));
  const replayRunner = runnerFrom(() => {
    assert.fail("a matching enriched journal entry must replay without invoking the runner");
  });
  const replayed = await new WorkflowManager({ persistence: memoryPersistence().persistence, agent: replayRunner }).runSync(
    script,
    undefined,
    { resumeJournal: replayMap },
  );
  assert.equal(replayed.status, "completed");
  assert.equal(calls, 1);
});

test("failure reasons persist the actual WorkflowError message and code", async () => {
  const store = memoryPersistence();
  const manager = new WorkflowManager({
    persistence: store.persistence,
    agent: runnerFrom(() => {
      throw new WorkflowError("FAIL-CLOSED at review", WorkflowErrorCode.SCRIPT_ERROR, { recoverable: false });
    }),
  });
  // A failed step pauses the run, and the reason carries the step's own message.
  const paused = await manager.runSync(
    'export const meta = { name: "failure", description: "failure" };\nawait agent("fail");',
  );
  assert.equal(paused.status, "paused");
  assert.equal(store.persistence.load(paused.runId)?.pauseReason, "step_failed");
  assert.match(store.persistence.load(paused.runId)?.reason ?? "", /FAIL-CLOSED at review/);
  // A script that throws fails the run with its message and code.
  const result = await manager.runSync(
    'export const meta = { name: "failure", description: "failure" };\nthrow new Error("FAIL-CLOSED at review");',
  );
  assert.equal(result.status, "failed");
  assert.equal(store.persistence.load(result.runId)?.reason, "FAIL-CLOSED at review");
  assert.equal(store.persistence.load(result.runId)?.errorCode, WorkflowErrorCode.SCRIPT_ERROR);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { StepRequest } from "../src/steps/agent-run.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createWorkflowLogTail } from "../src/run-observability.js";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true");
}

function persisted(runId: string, status: PersistedRunState["status"]): PersistedRunState {
  return {
    runId,
    workflowName: `workflow-${status}`,
    script: "private script",
    args: { private: true },
    cwd: "/private/cwd",
    status,
    phases: ["Declared", "Dynamic"],
    currentPhase: "Dynamic",
    agents: [],
    logs: ["one", "two"],
    journal: [{ index: 0, hash: "private-hash", result: { ok: true } }],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("a checkpoint call is attributed in the journal and a completed run has no log tail", async () => {
  const store = memoryPersistence();
  const held = deferred<unknown>();
  const runner = runnerFrom(async (prompt, options) => {
    options.onModelResolved?.("resolved/model");
    options.onSessionOpen?.({
      sessionId: `private-${prompt}`,
      backendId: "actual-backend",
      cwd: "/private/cwd",
      reopen: { load: true, resume: false, list: true },
    });
    if (prompt === "hold") return held.promise;
    return { prompt, answer: true };
  });
  const manager = new WorkflowManager({ persistence: store.persistence, agent: runner });
  const checkpointOnly = await manager.runSync(
    'export const meta = { name: "checkpoint-metadata", description: "checkpoint", phases: [{ title: "Review" }] };\nphase("Review");\nreturn await checkpoint("continue?");',
    undefined, { confirm: async () => true },
  );
  assert.deepEqual(store.persistence.load(checkpointOnly.runId)?.journal?.[0]?.call, {
    kind: "checkpoint",
    label: "checkpoint",
    phase: "Review",
  });
  const script = [
    'export const meta = { name: "live", description: "live", phases: [{ title: "Plan" }, { title: "Review" }] };',
    'phase("Plan");',
    'log("planning");',
    'await agent("first", { label: "plan-agent" });',
    'phase("Dynamic");',
    'await agent("hold", { label: "review-agent" });',
    'return "done";',
  ].join("\n");
  const started = manager.startInBackground(script);
  await waitUntil(() => (manager.getRun(started.runId)?.rows.saved("running").journal.length ?? 0) === 1);

  held.resolve({ answer: "done" });
  const completed = await started.promise;
  assert.equal(completed.status, "completed");
  assert.equal(completed.logTail, undefined);
  assert.equal("logTail" in completed, false);
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

test("terminal results get exact redacted final-20 tails while completed results retain only full logs", async () => {
  const token = "ghp_abcdefgh12345678";
  const loggingPrefix =
    'for (let i = 1; i <= 25; i++) log(i === 10 ? `line-${i} ghp_abcdefgh12345678` : i === 11 ? `line-${i} ${"😀".repeat(1000)}` : `line-${i}`);';
  const manager = new WorkflowManager({ persistence: memoryPersistence().persistence, agent: runnerFrom(() => "ok") });
  const paused = await manager.runSync(
    `export const meta = { name: "paused", description: "paused" };\n${loggingPrefix}\nawait checkpoint("q", { });`,
  );
  assert.equal(paused.status, "paused");
  assert.equal(paused.logs.length, 25, "the compatibility logs remain complete and raw");
  assert.equal(paused.logs[9]?.includes(token), true);
  assert.equal(paused.logTail?.lines.length, 20);
  assert.equal(paused.logTail?.lines[0], "line-6");
  assert.equal(paused.logTail?.lines.at(-1), "line-25");
  assert.equal(paused.logTail?.omittedLines, 5);
  assert.equal(paused.logTail?.redactedLines, 1);
  assert.equal(paused.logTail?.truncatedLines, 1);
  assert.equal(paused.logTail?.lines.some((line) => line.includes(token)), false);

  const failed = await manager.runSync(
    `export const meta = { name: "failed", description: "failed" };\n${loggingPrefix}\nthrow new Error("boom");`,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.logTail?.lines.length, 20);
  assert.equal(failed.logTail?.lines[0], "line-6");

  const empty = await manager.runSync(
    'export const meta = { name: "empty", description: "empty" };\nthrow new Error("empty failure");',
  );
  assert.deepEqual(empty.logTail, createWorkflowLogTail([], 20));

  const controller = new AbortController();
  const entered = deferred<void>();
  const blocked = deferred<unknown>();
  const abortManager = new WorkflowManager({
    persistence: memoryPersistence().persistence,
    agent: runnerFrom(async () => {
      entered.resolve(undefined);
      return blocked.promise;
    }),
  });
  const abortPromise = abortManager.runSync(
    `export const meta = { name: "aborted", description: "aborted" };\n${loggingPrefix}\nawait agent("hold");`,
    undefined,
    { externalSignal: controller.signal },
  );
  await entered.promise;
  controller.abort();
  blocked.resolve("ignored");
  const aborted = await abortPromise;
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.logTail?.lines[0], "line-6");

  const completed = await manager.runSync(
    `export const meta = { name: "completed", description: "completed" };\n${loggingPrefix}\nreturn true;`,
  );
  assert.deepEqual(
    completed.logs.slice(0, 25),
    Array.from({ length: 25 }, (_, index) =>
      index === 9
        ? `line-${index + 1} ghp_abcdefgh12345678`
        : index === 10
          ? `line-${index + 1} ${"😀".repeat(1000)}`
          : `line-${index + 1}`,
    ),
  );
  assert.equal(completed.logTail, undefined);
  assert.equal("logTail" in completed, false);
});

test("terminal cause persistence supports new and legacy records", () => {
  const store = memoryPersistence();
  const current = persisted("cause-current", "failed");
  current.reason = "actual failure";
  current.errorCode = WorkflowErrorCode.SCRIPT_ERROR;
  current.journal = [
    { index: 0, hash: "hash", result: true, call: { kind: "checkpoint", label: "checkpoint", phase: "Review" } },
  ];
  store.persistence.save(current);
  const roundTrip = store.persistence.load(current.runId);
  assert.equal(roundTrip?.reason, "actual failure");
  assert.equal(roundTrip?.errorCode, WorkflowErrorCode.SCRIPT_ERROR);
  assert.equal(roundTrip?.journal?.[0]?.call?.kind, "checkpoint");

  const legacy = persisted("cause-legacy", "paused");
  legacy.pauseReason = "usage_limit";
  delete legacy.reason;
  delete legacy.errorCode;
  store.persistence.save(legacy);
  const legacyRoundTrip = store.persistence.load(legacy.runId);
  assert.equal(legacyRoundTrip?.pauseReason, "usage_limit");
  assert.equal(legacyRoundTrip?.reason, undefined);
  assert.equal(legacyRoundTrip?.errorCode, undefined);
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

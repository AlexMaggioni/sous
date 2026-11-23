import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/steps/agent-run.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// AgentUsage lives in src/steps/agent-run.ts (the seam). runSync is the consolidated
// path the MCP shell drives: it resolves
// to a TERMINAL WorkflowRunResult (status completed|paused|failed|aborted) even on
// abort/pause/fail, rather than throwing — so these abort tests assert run.status, not a
// thrown error. The manager still emits the same 'error'/'paused'/'stopped' events.

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Agent runner that reports fixed usage so token accounting is exercised. */
function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

/**
 * Agent that stays running until a single shared deferred resolve is called externally.
 * `entered` settles when the first run() call starts.
 */
function deferredAgent() {
  let deferredResolve: ((value: unknown) => void) | null = null;
  let deferredReject: ((err: Error) => void) | null = null;
  const promise = new Promise((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return {
    entered,
    resolve: (value: unknown = "done") => deferredResolve?.(value),
    reject: (err: Error) => deferredReject?.(err),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        enter();
        return promise;
      },
    },
  };
}

/**
 * Agent runner where EACH run() call gets its OWN deferred promise, resolved by index.
 * `entered(i)` settles when call i starts, also when a test asks before the call.
 */
function perCallDeferredAgent() {
  const resolves: Array<(v: unknown) => void> = [];
  const starts: Array<{ promise: Promise<void>; enter: () => void }> = [];
  const start = (i: number) => {
    if (!starts[i]) {
      let enter!: () => void;
      const promise = new Promise<void>((resolve) => {
        enter = resolve;
      });
      starts[i] = { promise, enter };
    }
    return starts[i]!;
  };
  let idx = 0;
  return {
    entered: (i: number) => start(i).promise,
    resolve: (i: number, v: unknown = "done") => resolves[i]?.(v),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        const i = idx++;
        const result = new Promise((resolve) => {
          resolves[i] = resolve;
        });
        start(i).enter();
        return result;
      },
    },
  };
}

const oneAgentScript = `export const meta = { name: 'tracked_demo', description: 'one agent' }
phase('Work')
const a = await agent('do it', { label: 'a' })
return { a }`;

const twoAgentScript = `export const meta = { name: 'tracked_demo_two', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

/** Run each manager test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-dw-abort-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "ap-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

// ─── Observer isolation ───────────────────────────────────────────────────────

test(
  "throwing manager event observers do not fail the run or block sibling listeners",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let siblingCalled = false;

    manager.on("agentStart", () => {
      throw new Error("host observer failed");
    });
    manager.on("agentStart", () => {
      siblingCalled = true;
    });

    const result = await manager.runSync(oneAgentScript);

    assert.equal(result.status, "completed");
    assert.equal(manager.getRun(result.runId)?.status, "completed");
    assert.equal(siblingCalled, true, "sibling observer still receives the event");
  }),
);

test(
  "manager event once listeners fire exactly once under isolated dispatch",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let starts = 0;

    manager.once("agentStart", () => {
      starts++;
    });

    const result = await manager.runSync(twoAgentScript);

    assert.equal(result.status, "completed");
    assert.equal(starts, 1, "once listener should self-remove after the first event");
    assert.equal(manager.listenerCount("agentStart"), 0);
  }),
);

// ─── Stop ─────────────────────────────────────────────────────────────────────

test(
  "stop emits 'stopped' event with runId",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let stoppedEvent = null as { runId: string } | null;
    manager.on("stopped", (ev: { runId: string }) => {
      stoppedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await da.entered;
    manager.stop(runId);

    assert.ok(stoppedEvent, "stopped event should fire");
    assert.equal(stoppedEvent?.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop returns false for already-stopped run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await da.entered;

    manager.stop(runId);
    assert.equal(manager.getRun(runId)?.status, "aborted");
    const secondStop = manager.stop(runId);
    assert.equal(secondStop, false, "second stop on same run should return false");
    assert.equal(manager.pause(runId), false, "cannot pause an already stopped/aborted run");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Pause ────────────────────────────────────────────────────────────────────

test(
  "pause is idempotent while pending and returns false once the run is paused",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await da.entered;

    assert.equal(manager.pause(runId), true);
    assert.equal(manager.pause(runId), true, "a repeat request while pending is the same request");

    da.resolve("a-done");
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");
    assert.equal(manager.pause(runId), false, "nothing is running once the run is paused");
  }),
);

test(
  "a pause requested before any call pauses immediately without executing anything",
  withTempCwd(async (cwd) => {
    const agent = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: agent.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(twoAgentScript);
    // Execution is deferred to the next macrotask; the request lands before the script starts.
    assert.equal(manager.pause(runId), true);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");
    const persisted = manager.getPersistence().list().find((r) => r.runId === runId);
    assert.equal(persisted?.journal?.length ?? 0, 0);
    assert.equal(persisted?.calls?.length ?? 0, 0, "an admission refused before allocation leaves no row");
    assert.equal(persisted?.pauseReason, "requested");

    // Resume runs everything live.
    const resumed = await manager.resumeInBackground(runId);
    if (!resumed.accepted) assert.fail("a paused run should be accepted for resume");
    await agent.entered(0);
    agent.resolve(0, "a");
    await agent.entered(1);
    agent.resolve(1, "b");
    await resumed.promise;
    assert.equal(manager.getRun(runId)?.status, "completed");
    assert.equal(JSON.stringify(manager.getRun(runId)?.result?.result), JSON.stringify({ a: "a", b: "b" }));
  }),
);

test(
  "a pause lets executing parallel calls finish and refuses the queued ones, which run again on resume",
  withTempCwd(async (cwd) => {
    const agent = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: agent.runner });
    manager.on("error", () => {});
    const script = `export const meta = { name: 'fan_out', description: 'three parallel agents' }
return await parallel([
  () => agent('one', { label: 'one' }),
  () => agent('two', { label: 'two' }),
  () => agent('three', { label: 'three' }),
])`;
    const { runId, promise } = manager.startInBackground(script, undefined, { concurrency: 2 });
    await Promise.all([agent.entered(0), agent.entered(1)]);
    assert.equal(manager.getRun(runId)?.callsAllocated, 3, "all three are allocated, two execute, one queues");

    assert.equal(manager.pause(runId), true);
    agent.resolve(0, "one-done");
    agent.resolve(1, "two-done");
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");

    const persisted = manager.getPersistence().list().find((r) => r.runId === runId);
    assert.deepEqual(
      persisted?.journal?.map((entry) => entry.index).sort(),
      [0, 1],
      "both executing calls journaled their results",
    );
    const queued = persisted?.calls?.find((call) => call.index === 2);
    assert.equal(queued?.aborted, true, "the queued call never started and is recorded as interrupted");
    assert.equal(queued?.error?.code, WorkflowErrorCode.PAUSE_REQUESTED);

    const resumed = await manager.resumeInBackground(runId);
    if (!resumed.accepted) assert.fail("a paused run should be accepted for resume");
    await agent.entered(2);
    agent.resolve(2, "three-done");
    await resumed.promise;
    assert.equal(manager.getRun(runId)?.status, "completed");
    assert.equal(JSON.stringify(manager.getRun(runId)?.result?.result), JSON.stringify(["one-done", "two-done", "three-done"]));
  }),
);

test(
  "a script that catches the pause signal still pauses instead of completing",
  withTempCwd(async (cwd) => {
    const agent = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: agent.runner });
    manager.on("error", () => {});
    const script = `export const meta = { name: 'swallow', description: 'catches the pause' }
const a = await agent('first', { label: 'a' })
let b = 'skipped'
try { b = await agent('second', { label: 'b' }) } catch (error) { log('caught ' + String(error)) }
return { a, b }`;
    const { runId, promise } = manager.startInBackground(script);
    await agent.entered(0);
    assert.equal(manager.pause(runId), true);
    agent.resolve(0, "a-done");
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused", "catching PAUSE_REQUESTED cannot keep the run going");
    assert.ok(manager.getRun(runId)?.snapshot.logs.some((line) => line.includes("caught WorkflowError: workflow paused by host request")));
  }),
);

test(
  "a stop interrupts the executing call, keeps the journal and saves the run aborted",
  withTempCwd(async (cwd) => {
    const agent = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: agent.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await agent.entered(0);
    agent.resolve(0, "a-done");
    await agent.entered(1);

    // Stop while agent b executes: it is interrupted, the run is aborted, and b's result is lost.
    assert.equal(manager.stop(runId), true);
    agent.resolve(1, "lost");
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "aborted");
    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.status, "aborted");
    assert.equal(persisted?.abortSignaled, true);
    assert.equal(persisted?.journal?.length, 1);
  }),
);

// ─── Resume ───────────────────────────────────────────────────────────────────

test(
  "resume full cycle: pause then resume then complete",
  withTempCwd(async (cwd) => {
    const agent = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: agent.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(twoAgentScript);
    await agent.entered(0);

    // Pause while agent a executes; it finishes and journals, b is refused.
    assert.equal(manager.pause(runId), true);
    agent.resolve(0, "a-done");
    await origPromise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Resume — a replays from the journal, b runs live.
    const resumed = await manager.resumeInBackground(runId);
    assert.equal(resumed.accepted, true, "resume should succeed");
    if (!resumed.accepted) assert.fail("resume should succeed");
    assert.equal(manager.getRun(runId)?.status, "running", "resumed run should be running");

    await agent.entered(1);
    agent.resolve(1, "resumed-done");
    await resumed.promise;

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run should complete successfully");
    const value = finalRun?.result?.result as { a?: unknown; b?: unknown } | undefined;
    assert.equal(value?.a, "a-done", "agent a replayed from the journal");
    assert.equal(value?.b, "resumed-done", "agent b ran live after resume");

    // The run should also appear in the persisted runs as completed
    const persisted = manager.getPersistence().list().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "completed");
  }),
);

test(
  "resumeInBackground rejects unknown and completed runs without a completion promise",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });

    const unknown = await manager.resumeInBackground("missing-run");
    assert.deepEqual(unknown, { accepted: false });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    const completed = await promise;
    assert.equal(completed.status, "completed");

    const alreadyCompleted = await manager.resumeInBackground(runId);
    assert.deepEqual(alreadyCompleted, { accepted: false });
  }),
);

// ─── Events ────────────────────────────────────────────────────────────────────

test(
  "manager emits 'resumed' and 'error' events",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    // The paused original emits 'error' when its in-flight agent later settles under
    // the aborted controller; register a sink so the EventEmitter never throws.
    manager.on("error", () => {});

    // Track resumed event
    let resumedEvent = null as { runId: string } | null;
    manager.on("resumed", (ev: { runId: string }) => {
      resumedEvent = ev;
    });

    // Track resumed event on the stop→resume cycle
    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.stop(runId);
    da.resolve("done");
    await origPromise.catch(() => {});
    await manager.resumeInBackground(runId);

    assert.ok(resumedEvent, "resumed event should fire on resume");
    assert.equal(resumedEvent?.runId, runId);

    // Now test error event on abort. runSync settles to a terminal aborted result;
    // the 'error' event still fires.
    let capturedError = null as { runId: string; error: WorkflowError } | null;
    const da2 = deferredAgent();
    const manager2 = new WorkflowManager({ cwd, agent: da2.runner });
    manager2.on("error", (ev: { runId: string; error: WorkflowError }) => {
      capturedError = ev;
    });

    const runPromise = manager2.runSync(oneAgentScript, undefined, { runId: "stopped-for-error" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(manager2.stop("stopped-for-error"), true);
    da2.resolve("done");

    const result = await runPromise;
    assert.equal(result.status, "aborted", "runSync settles to a terminal aborted result");

    assert.ok(capturedError, "error event should fire on abort");
    assert.ok(capturedError?.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal(capturedError?.error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
  }),
);

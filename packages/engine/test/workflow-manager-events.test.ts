import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { StepRequest } from "../src/steps/agent-run.js";
import type { EngineRunEventName, EngineRunEventPayloadMap } from "../src/run-events.js";
import { WorkflowError, WorkflowErrorCode, type AuthErrorContext } from "../src/errors.js";
import { RunEventLogError } from "../src/runs/persistence/run-event-persistence.js";
import {
  createRunPersistence,
  type PersistedRunState,
} from "../src/runs/persistence/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { eventLog } from "./helpers/event-log.js";
import { runsDir } from "./helpers/run-files.js";
import { deferred } from "./helpers/async.js";
import { withTempDirs } from "./helpers/temp.js";

const script = (body: string, name = "manager-events") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: 'manager event persistence' }\n${body}`;

function legacyState(runId: string, source: string): PersistedRunState {
  const now = new Date().toISOString();
  return {
    runId,
    workflowName: "legacy-events",
    script: source,
    status: "paused",
    phases: [],
    agents: [],
    logs: [],
    startedAt: now,
    updatedAt: now,
  };
}

test("manager appends dense events before delivery and public emit stays live-only", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    const manager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: { async run() { return "done"; } },
    });
    let appendObservedBeforeDelivery = false;
    let hostOnlyLogs = 0;
    let initialWatermarkObserved = false;
    manager.once("phase", ({ runId }) => {
      const initial = manager.getPersistence().load(runId);
      initialWatermarkObserved = initial?.eventSeq === 0 && /^[0-9a-f]{32}$/.test(initial.eventStreamId ?? "");
    });
    manager.on("log", (payload) => {
      if (payload.message === "host-only") {
        hostOnlyLogs++;
        return;
      }
      if (payload.message !== "persisted") return;
      appendObservedBeforeDelivery = eventLog(manager).readEvents(payload.runId).events.some(
        (record) => record.event.type === "log" && record.event.message === payload.message,
      );
    });
    manager.once("agentStart", (payload) => {
      manager.emit("log", { runId: payload.runId, scope: payload.scope, message: "host-only" });
    });

    const result = await manager.runSync(script(`phase('Build')\nlog('persisted')\nreturn await agent('work', { label: 'work' })`));
    const persisted = manager.getPersistence().load(result.runId);
    const events = eventLog(manager).readEvents(result.runId, { limit: 1_000 });

    assert.equal(result.status, "completed");
    assert.match(persisted?.eventStreamId ?? "", /^[0-9a-f]{32}$/);
    assert.equal(persisted?.eventSeq, events.endCursor);
    assert.deepEqual(events.events.map((record) => record.seq), events.events.map((_, index) => index + 1));
    assert.ok(events.events.every((record) => record.streamId === persisted?.eventStreamId));
    assert.ok(events.events.every((record) => record.runId === result.runId));
    assert.ok(events.events.every((record) => record.event.runId === result.runId));
    assert.ok(events.events.every((record) => record.event.scope === result.runId));
    assert.equal(events.events.at(-1)?.event.type, "complete");
    assert.equal(
      events.events.some((record) => record.event.type === "log" && record.event.message === "host-only"),
      false,
    );
    assert.equal(appendObservedBeforeDelivery, true);
    assert.equal(initialWatermarkObserved, true);
    assert.equal(hostOnlyLogs, 1);
  });
});

test("nested workflow observations use the parent stream and child callback scope", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    const child = script(`phase('Child')\nlog('child-log')\nreturn await agent('child', { label: 'child' })`, "child");
    const manager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      loadSavedWorkflow: (name) => name === "child" ? child : undefined,
      agent: { async run() { return "child-result"; } },
    });
    const liveScopes: string[] = [];
    manager.on("phase", ({ scope }) => liveScopes.push(scope));
    manager.on("log", ({ scope }) => liveScopes.push(scope));
    manager.on("tokenUsage", ({ scope }) => liveScopes.push(scope));

    const result = await manager.runSync(script(`return await workflow('child')`, "parent"));
    const childRunId = `${result.runId}-nested1`;
    const persisted = manager.getPersistence().load(result.runId);
    const childEvents = eventLog(manager).readEvents(result.runId, { limit: 1_000 }).events
      .filter((record) => record.event.scope === childRunId);
    const childTypes = new Set<string>(childEvents.map((record) => record.event.type));

    assert.ok(liveScopes.includes(childRunId));
    for (const type of ["phase", "log", "tokenUsage", "agentStart", "callRecord", "journal", "agentEnd"]) {
      assert.equal(childTypes.has(type), true, `missing child ${type}`);
    }
    assert.ok(childEvents.every((record) => record.runId === result.runId));
    assert.deepEqual(persisted?.journal, []);
    assert.deepEqual(persisted?.calls?.map((row) => [row.scope, row.index, row.outcome]), [[childRunId, 0, "result"]]);
    assert.equal(existsSync(join(runsDir(cwd, root), `${childRunId}.events.jsonl`)), false);
  });
});

test("append failure marks the snapshot incomplete once without changing the outcome", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    let writes = 0;
    const persistence = createRunPersistence(
      cwd,
      {
        writeSync: () => {
          writes++;
          const error = new Error("event disk full") as NodeJS.ErrnoException;
          error.code = "ENOSPC";
          throw error;
        },
      },
      { persistenceRoot: root },
    );
    const manager = new WorkflowManager({ cwd, persistence, agent: { async run() { return "unused"; } } });
    const originalWarn = console.warn;
    let warnings = 0;
    let result;
    try {
      console.warn = () => { warnings++; };
      result = await manager.runSync(script(`log('survives')\nreturn 42`));
    } finally {
      console.warn = originalWarn;
    }

    const persisted = persistence.load(result.runId);
    assert.equal(result.status, "completed");
    assert.equal(result.result, 42);
    assert.equal(writes, 1);
    assert.equal(warnings, 1);
    assert.equal(persisted?.eventSeq, 0);
    assert.equal(persisted?.eventLogIncomplete, true);
    assert.throws(() => persistence.readEvents(result.runId), (error: unknown) =>
      error instanceof RunEventLogError && error.code === "EVENT_LOG_INCOMPLETE");
  });
});

test("a requested pause settles after the executing call", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    const entered = deferred<void>();
    const finish = deferred<string>();
    const runner: AgentRunner = {
      async run() {
        entered.resolve();
        return await finish.promise;
      },
    };
    const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: runner });
    let liveErrors = 0;
    manager.on("error", () => liveErrors++);
    const livePaused: Array<{ runId: string; reason: string }> = [];
    manager.on("paused", (payload) => livePaused.push({ runId: payload.runId, reason: payload.reason }));
    const background = manager.startInBackground(
      script(`await agent('hold', { label: 'hold' })
return await agent('next', { label: 'next' })`),
    );
    await entered.promise;

    assert.equal(manager.pause(background.runId), true);
    assert.equal(manager.getPersistence().load(background.runId)?.status, "running", "the executing call is still finishing");
    assert.deepEqual(livePaused, [], "the request alone does not pause");
    finish.resolve("held");
    await assert.rejects(background.promise);
    const paused = manager.getPersistence().load(background.runId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.pauseReason, "requested");
    assert.equal(paused?.reason, "requested");
    assert.equal(paused?.errorCode, WorkflowErrorCode.PAUSE_REQUESTED);
    assert.equal(paused?.journal?.length, 1, "the executing call journaled before the pause");
    assert.equal(paused?.calls?.length, 1, "the refused second call was never allocated");
    assert.equal(paused?.calls?.[0]?.outcome, "result");
    assert.deepEqual(livePaused, [{ runId: background.runId, reason: "requested" }]);
    assert.equal(liveErrors, 0, "a requested pause is not an error");
    const pausedRecords = eventLog(manager).readEvents(background.runId, { limit: 1_000 }).events;
    assert.equal(pausedRecords.some((record) => record.event.type === "error"), false);
    const pausedEvent = pausedRecords.find((record) => record.event.type === "paused")?.event;
    assert.equal(pausedEvent?.type === "paused" ? pausedEvent.reason : undefined, "requested");
  });
});

test("a failed step, a stopped step and a time limit pause with the same reason in the event as in the state", async () => {
  const cases: Array<{ want: string; stop?: { label?: string; pauseReason?: "time_limit"; message?: string } }> = [
    { want: "step_failed" },
    { want: "step_stopped", stop: { label: "held" } },
    { want: "time_limit", stop: { pauseReason: "time_limit", message: "the run reached its time limit" } },
  ];
  for (const { want, stop } of cases) {
    await withTempDirs(async ({ cwd, root }) => {
      const entered = deferred<void>();
      const runner: AgentRunner = {
        async run(_prompt: string, options: StepRequest): Promise<unknown> {
          if (!stop) throw new Error("the build is broken");
          entered.resolve();
          return await new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          });
        },
      };
      const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: runner });
      const live: string[] = [];
      manager.on("paused", (payload) => live.push(payload.reason));
      const background = manager.startInBackground(script(`return await agent('held', { label: 'held', retries: 0 })`));
      if (stop) {
        await entered.promise;
        assert.equal(manager.cancelAgentSteps(background.runId, stop), 1);
      }
      await assert.rejects(background.promise);

      const state = manager.getPersistence().load(background.runId);
      assert.equal(state?.status, "paused", want);
      assert.equal(state?.pauseReason, want);
      const persisted = eventLog(manager).readEvents(background.runId, { limit: 1_000 }).events
        .filter((record) => record.event.type === "paused")
        .map((record) => (record.event.type === "paused" ? record.event.reason : undefined));
      assert.deepEqual(persisted, [want], "the saved event says what the state says");
      assert.deepEqual(live, [want], "the live event says what the state says");
    });
  }
});

test("automatic error persists without a listener", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    const failedManager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: { async run() { return "unused"; } },
    });
    const failed = await failedManager.runSync(script(`throw new Error('boom')`, "failed-events"));
    const failureRecords = eventLog(failedManager).readEvents(failed.runId, { limit: 1_000 });
    const failure = failureRecords.events.at(-1)?.event;
    assert.equal(failed.status, "failed");
    assert.equal(failure?.type, "error");
    if (failure?.type !== "error") assert.fail("terminal error event was not persisted");
    assert.equal(failure.scope, failed.runId);
    assert.equal(failure.errorRecord.form, "workflow-error");
  });
});

test("resume replay republishes execution observations without cached journal events", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    let calls = 0;
    const runner: AgentRunner = {
      async run() {
        calls++;
        return "cached";
      },
    };
    const source = script(
      `const value = await agent('cached', { label: 'cached' })
const decision = await checkpoint('continue', { })
return { value, decision }`,
      "replay-events",
    );
    const first = new WorkflowManager({ cwd, persistenceRoot: root, agent: runner });
    const paused = await first.runSync(source);
    assert.equal(paused.status, "paused");
    assert.ok(paused.checkpointContext);
    const before = first.getPersistence().load(paused.runId);
    assert.ok(before?.eventSeq);

    const second = new WorkflowManager({ cwd, persistenceRoot: root, agent: runner });
    const resumed = await second.resumeInBackground(paused.runId, {
      confirm: async () => "approved",
    });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("replay resume should be accepted");
    assert.equal((await resumed.promise).status, "completed");

    const suffix = eventLog(second).readEvents(paused.runId, {
      after: before.eventSeq,
      limit: 1_000,
      streamId: before.eventStreamId,
    }).events.map((record) => record.event);
    const cached = suffix.filter((event) =>
      ((event.type === "agentStart" || event.type === "agentEnd") && event.callIndex === 0) ||
      (event.type === "callRecord" && event.record.index === 0));
    const checkpoint = suffix.filter((event) =>
      event.type === "callRecord" && event.record.kind === "checkpoint" && event.record.index === 1);

    assert.equal(suffix[0]?.type, "resumed");
    assert.deepEqual(cached.map((event) => event.type), ["agentStart", "callRecord", "agentEnd"]);
    assert.equal(cached[1]?.type === "callRecord" ? cached[1].record.origin : undefined, "journal-replay");
    assert.equal(checkpoint.length, 1);
    assert.equal(suffix.some((event) => event.type === "journal" && event.entry.index === 0), false);
    assert.equal(calls, 1);
  });
});

test("legacy resume upgrades under lease and begins a new event stream at resumed", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    const runId = "legacy-manager-events";
    const source = script(`return 'resumed'`, "legacy-events");
    const persistence = createRunPersistence(cwd, undefined, { persistenceRoot: root });
    const lease = persistence.acquireRunLease(runId);
    assert.ok(lease);
    persistence.save(legacyState(runId, source));
    persistence.releaseRunLease(lease);
    assert.throws(() => persistence.readEvents(runId), (error: unknown) =>
      error instanceof RunEventLogError && error.code === "EVENT_LOG_UNAVAILABLE");

    const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: { async run() { return "unused"; } } });
    const resumed = await manager.resumeInBackground(runId);
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("legacy resume should be accepted");
    const result = await resumed.promise;
    const persisted = manager.getPersistence().load(runId);
    const records = eventLog(manager).readEvents(runId, { limit: 1_000 });

    assert.equal(result.status, "completed");
    assert.match(persisted?.eventStreamId ?? "", /^[0-9a-f]{32}$/);
    assert.equal(records.events[0]?.seq, 1);
    assert.equal(records.events[0]?.event.type, "resumed");
    assert.equal(persisted?.eventSeq, records.endCursor);
  });
});

test("a running run whose lock another owner took and deleted never recreates its files", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    const entered = deferred<void>();
    const outcome = deferred<unknown>();
    const manager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: {
        async run() {
          entered.resolve();
          return await outcome.promise as never;
        },
      },
    });
    const background = manager.startInBackground(script(`return await agent('hold', { label: 'hold' })`));
    await entered.promise;
    const persistence = manager.getPersistence();
    const eventPath = join(runsDir(cwd, root), `${background.runId}.events.jsonl`);
    assert.equal(existsSync(eventPath), true);

    // The lock file goes away, so another owner takes the lease and deletes the run, as sous's delete does.
    unlinkSync(join(runsDir(cwd, root), `${background.runId}.lock`));
    const other = persistence.acquireRunLease(background.runId);
    assert.ok(other, "another owner takes the free lease");
    assert.equal(persistence.delete(background.runId), true);
    persistence.releaseRunLease(other);

    outcome.resolve("late-result");
    assert.equal((await background.promise).status, "completed");
    assert.equal(persistence.load(background.runId), null);
    assert.equal(existsSync(eventPath), false);
  });
});

const EXECUTION_EVENT_NAMES = [
  "log",
  "phase",
  "agentStart",
  "agentEnd",
  "agentHistory",
  "tokenUsage",
  "journal",
  "callRecord",
  "complete",
] as const satisfies readonly EngineRunEventName[];

// The EXACT live payload key set the manager emits for each of the 13 §2.2 engine event names.
// Keys are copied by `Object.assign({ type }, payload)`, so a key present in the emission literal
// counts even when its value is undefined. Every array is pre-sorted to match Object.keys(...).sort().
const EXPECTED_EVENT_KEYS: Record<string, string[]> = {
  log: ["message", "runId", "scope"],
  phase: ["runId", "scope", "title"],
  agentStart: ["callIndex", "configOptions", "label", "model", "path", "phase", "prompt", "runId", "scope"],
  agentEnd: [
    "backendId", "callIndex", "label", "model", "modelResolved", "phase",
    "provenance", "result", "runId", "scope", "session", "tokens", "usage", "worktree",
  ],
  agentHistory: ["callIndex", "history", "label", "phase", "runId", "scope"],
  tokenUsage: ["runId", "scope", "usage"],
  journal: ["entry", "runId", "scope"],
  callRecord: ["record", "runId", "scope"],
  complete: ["result", "runId", "scope"],
  paused: ["error", "errorRecord", "reason", "runId", "scope"],
  error: ["error", "errorRecord", "runId", "scope"],
  stopped: ["runId", "scope"],
  resumed: ["runId", "scope"],
};

function captureEventKeys(
  manager: WorkflowManager,
  names: readonly EngineRunEventName[],
): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const name of names) {
    manager.on(name, (payload) => {
      if (!seen.has(name)) seen.set(name, Object.keys(payload as object).sort());
    });
  }
  return seen;
}

test("each manager event carries exactly its §2.2 payload key set", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    // Scenario 1 — a successful agent run drives the nine execution/lifecycle events. The runner
    // reports usage (→ tokenUsage and agentEnd.usage) and history (→ agentHistory).
    const historyRunner: AgentRunner = {
      async run(_prompt, options) {
        options?.onUsage?.({ input: 3, output: 5, cacheRead: 0, cacheWrite: 0, total: 8, cost: 0 });
        options?.onHistory?.([{ role: "assistant", kind: "text", text: "did the work" }]);
        return "work-result";
      },
    };
    const okManager = new WorkflowManager({ cwd, persistenceRoot: root, agent: historyRunner });
    const execKeys = captureEventKeys(okManager, EXECUTION_EVENT_NAMES);
    const okResult = await okManager.runSync(
      script(`phase('Build')\nlog('note')\nreturn await agent('work', { label: 'work' })`, "exec-events"),
    );
    assert.equal(okResult.status, "completed");

    // Scenario 2 — a thrown fault drives the listener-gated error event.
    const errorManager = new WorkflowManager({ cwd, persistenceRoot: root, agent: { async run() { return "unused"; } } });
    const errorKeys = captureEventKeys(errorManager, ["error"]);
    const failed = await errorManager.runSync(script(`throw new Error('boom')`, "error-events"));
    assert.equal(failed.status, "failed");

    // Scenario 3 — a requested pause, then a warm stop of that same paused run.
    const entered = deferred<void>();
    const finish = deferred<string>();
    const holdManager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: {
        async run() {
          entered.resolve();
          return await finish.promise;
        },
      },
    });
    const pauseStopKeys = captureEventKeys(holdManager, ["paused", "stopped"]);
    const background = holdManager.startInBackground(
      script(`await agent('hold', { label: 'hold' })
return await agent('next', { label: 'next' })`, "hold-events"),
    );
    await entered.promise;
    assert.equal(holdManager.pause(background.runId), true);
    finish.resolve("held");
    await assert.rejects(background.promise);
    assert.equal(holdManager.stop(background.runId), true);

    // Scenario 4 — resume a usage-limit-paused run so a fresh manager emits resumed.
    const pausingManager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: {
        async run() {
          throw new WorkflowError("usage exhausted", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
        },
      },
    });
    const pausedRun = await pausingManager.runSync(
      script(`return await agent('resume-me', { label: 'resume-me' })`, "resume-events"),
    );
    assert.equal(pausedRun.status, "paused");
    const resumeManager = new WorkflowManager({ cwd, persistenceRoot: root, agent: { async run() { return "recovered"; } } });
    const resumeKeys = captureEventKeys(resumeManager, ["resumed"]);
    const resumed = await resumeManager.resumeInBackground(pausedRun.runId);
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("usage-limit resume should be accepted");
    await resumed.promise;

    // Each of the 13 §2.2 engine event names carries exactly its frozen payload key set.
    const actual = new Map<string, string[]>([...execKeys, ...errorKeys, ...pauseStopKeys, ...resumeKeys]);
    for (const [name, expected] of Object.entries(EXPECTED_EVENT_KEYS)) {
      assert.deepEqual(actual.get(name), expected, `event ${name} payload keys`);
    }
  });
});

test("automatic usage_limit and auth_required settlements carry reason + errorRecord on live and persisted surfaces", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    // usage_limit — the live paused payload carries reason + errorRecord + resetHint (and no
    // authContext); the persisted record projects the same and drops the raw WorkflowError.
    const usageManager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: {
        async run() {
          throw new WorkflowError("quota exhausted", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
            resetHint: "retry after 17:00 UTC",
          });
        },
      },
    });
    let liveUsage: EngineRunEventPayloadMap["paused"] | undefined;
    usageManager.on("paused", (payload) => {
      liveUsage = payload;
    });
    const usageResult = await usageManager.runSync(script(`return await agent('x', { label: 'x' })`, "usage-limit-events"));
    assert.equal(usageResult.status, "paused");

    if (!liveUsage || liveUsage.reason !== "usage_limit") assert.fail("live usage-limit pause missing reason");
    assert.equal(liveUsage.resetHint, "retry after 17:00 UTC");
    assert.equal(liveUsage.errorRecord.form, "workflow-error");
    assert.equal(liveUsage.errorRecord.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
    assert.equal("authContext" in liveUsage, false);

    const usagePersisted = eventLog(usageManager).readEvents(usageResult.runId, { limit: 1_000 }).events.at(-1)?.event;
    if (usagePersisted?.type !== "paused" || usagePersisted.reason !== "usage_limit") assert.fail("persisted usage-limit pause missing reason");
    assert.equal(usagePersisted.resetHint, "retry after 17:00 UTC");
    assert.equal(usagePersisted.errorRecord.form, "workflow-error");
    assert.equal(usagePersisted.errorRecord.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
    assert.equal("error" in usagePersisted, false);

    // auth_required — live and persisted carry reason + errorRecord + authContext (and no resetHint).
    const authContext: AuthErrorContext = {
      backendId: "claude",
      methods: [{ id: "oauth", type: "agent", name: "Sign in" }],
    };
    const authManager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: {
        async run() {
          throw new WorkflowError("auth needed", WorkflowErrorCode.AUTH_REQUIRED, { recoverable: false, authContext });
        },
      },
    });
    let liveAuth: EngineRunEventPayloadMap["paused"] | undefined;
    authManager.on("paused", (payload) => {
      liveAuth = payload;
    });
    const authResult = await authManager.runSync(script(`return await agent('y', { label: 'y' })`, "auth-required-events"));
    assert.equal(authResult.status, "paused");

    if (!liveAuth || liveAuth.reason !== "auth_required") assert.fail("live auth pause missing reason");
    assert.equal(liveAuth.runId, authResult.runId);
    assert.equal(liveAuth.error.code, WorkflowErrorCode.AUTH_REQUIRED);
    assert.deepEqual(liveAuth.authContext, authContext);
    assert.equal(liveAuth.errorRecord.form, "workflow-error");
    assert.equal(liveAuth.errorRecord.code, WorkflowErrorCode.AUTH_REQUIRED);
    assert.equal("resetHint" in liveAuth, false);

    const authPersisted = eventLog(authManager).readEvents(authResult.runId, { limit: 1_000 }).events.at(-1)?.event;
    if (authPersisted?.type !== "paused" || authPersisted.reason !== "auth_required") assert.fail("persisted auth pause missing reason");
    assert.deepEqual(authPersisted.authContext, authContext);
    assert.equal(authPersisted.errorRecord.form, "workflow-error");
    assert.equal(authPersisted.errorRecord.code, WorkflowErrorCode.AUTH_REQUIRED);
    assert.equal("error" in authPersisted, false);
  });
});

test("a step's history report lands on that step, found by its scope and call index", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    const history = [{ role: "assistant" as const, kind: "text" as const, text: "second" }];
    const manager = new WorkflowManager({
      cwd,
      persistenceRoot: root,
      agent: {
        async run(prompt, options) {
          if (prompt === "b") options?.onHistory?.(history);
          return prompt;
        },
      },
    });
    const result = await manager.runSync(
      script(`await agent('a', { label: 'same' })\nreturn await agent('b', { label: 'same' })`, "history-step"),
    );
    assert.equal(result.status, "completed");
    const steps = manager.getRun(result.runId)?.snapshot.agents ?? [];
    assert.deepEqual(steps.map((step) => [step.callIndex, step.history]), [[0, undefined], [1, history]]);
  });
});

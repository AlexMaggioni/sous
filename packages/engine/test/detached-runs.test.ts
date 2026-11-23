import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUsage } from "../src/steps/agent-run.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { runWorkflow } from "../src/workflow.js";
import { deferred, waitUntil } from "./helpers/async.js";
import { memoryPersistence } from "./helpers/memory-persistence.js";
import { runnerFrom } from "./helpers/runners.js";

const TWO_AGENT_SCRIPT = [
  'export const meta = { name: "usage-live", description: "usage" };',
  'const first = await agent("first", { label: "first" });',
  'const second = await agent("second", { label: "second" });',
  "return { first, second };",
].join("\n");

test("live attempts emit fresh cumulative usage snapshots and persist them before settlement", async () => {
  const second = deferred<string>();
  let calls = 0;
  const usageByCall: AgentUsage[] = [
    { input: 10, output: 5, total: 15, cost: 0.1, cacheRead: 3, cacheWrite: 1 },
    { input: 20, output: 7, total: 27, cost: 0.2, cacheRead: 4, cacheWrite: 2 },
  ];
  const runner = runnerFrom(async (_prompt, options) => {
    const index = calls++;
    options.onUsage?.(usageByCall[index]);
    return index === 0 ? "first-result" : await second.promise;
  });
  const directSnapshots: number[] = [];
  const directSecond = deferred<string>();
  let directCalls = 0;
  const directRun = runWorkflow(TWO_AGENT_SCRIPT, {
    agent: runnerFrom(async (_prompt, options) => {
      const index = directCalls++;
      options.onUsage?.(usageByCall[index]);
      return index === 0 ? "first-result" : await directSecond.promise;
    }),
    persistLogs: false,
    onTokenUsage: (usage) => directSnapshots.push(usage.total),
  });
  await waitUntil(() => directCalls === 2, "direct workflow did not reach the second agent");
  assert.deepEqual(directSnapshots, [15]);
  directSecond.resolve("second-result");
  const directResult = await directRun;
  assert.deepEqual(directSnapshots, [15, 42, 42], "live attempts plus the unchanged final snapshot are emitted");
  assert.equal(directResult.tokenUsage?.total, 42);

  const store = memoryPersistence();
  const manager = new WorkflowManager({ persistence: store.persistence, agent: runner });
  const managerSnapshots: number[] = [];
  manager.on("tokenUsage", (event: { usage: { total: number } }) => managerSnapshots.push(event.usage.total));
  const started = manager.startInBackground(TWO_AGENT_SCRIPT);
  await waitUntil(() => calls === 2, "managed workflow did not reach the second agent");
  assert.equal(manager.getRun(started.runId)?.snapshot.tokenUsage?.total, 15);
  assert.equal(store.persistence.load(started.runId)?.tokenUsage?.total, 15);
  second.resolve("second-result");
  const result = await started.promise;
  assert.deepEqual(managerSnapshots, [15, 42, 42]);
  assert.equal(manager.getRun(started.runId)?.snapshot.tokenUsage?.total, 42);
  assert.deepEqual(result.tokenUsage, {
    input: 30,
    output: 12,
    total: 42,
    cost: 0.30000000000000004,
    cacheRead: 7,
    cacheWrite: 3,
  });
  assert.equal(new WorkflowManager({ persistence: store.persistence, agent: runner }).getPersistence().load(started.runId)?.tokenUsage?.total, 42);
});

test("usage includes estimates, failed retries, provider/auth pauses, and terminal failures", async () => {
  const estimateSnapshots: number[] = [];
  const estimated = await runWorkflow(
    'export const meta = { name: "estimate", description: "estimate" }; return await agent("estimate me");',
    {
      agent: runnerFrom(() => "estimated result"),
      persistLogs: false,
      onTokenUsage: (usage) => estimateSnapshots.push(usage.total),
    },
  );
  assert.ok(estimateSnapshots[0] > 0);
  assert.equal(estimateSnapshots.at(-1), estimated.tokenUsage?.total);

  let retryCalls = 0;
  const retrySnapshots: number[] = [];
  const retried = await runWorkflow(
    'export const meta = { name: "retry-usage", description: "retry" }; return await agent("retry", { retries: 1 });',
    {
      agent: runnerFrom((_prompt, options) => {
        retryCalls++;
        options.onUsage?.({ input: 2, output: 1, total: 3, cost: 0.01, cacheRead: 0, cacheWrite: 0 });
        if (retryCalls === 1) {
          throw new WorkflowError("retry", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
        }
        return "ok";
      }),
      persistLogs: false,
      onTokenUsage: (usage) => retrySnapshots.push(usage.total),
    },
  );
  assert.deepEqual(retrySnapshots, [3, 6, 6]);
  assert.equal(retried.tokenUsage?.total, 6);

  for (const fixture of [
    { code: WorkflowErrorCode.PROVIDER_USAGE_LIMIT, status: "paused" },
    { code: WorkflowErrorCode.AUTH_REQUIRED, status: "paused" },
    // A failed step pauses the run.
    { code: WorkflowErrorCode.SCRIPT_ERROR, status: "paused" },
    // A script that throws after its step fails the run.
    { code: undefined, status: "failed" },
  ] as const) {
    const store = memoryPersistence();
    const manager = new WorkflowManager({
      persistence: store.persistence,
      agent: runnerFrom((_prompt, options) => {
        options.onUsage?.({ input: 8, output: 2, total: 10, cost: 0.5, cacheRead: 1, cacheWrite: 0 });
        if (fixture.code === undefined) return "done";
        throw new WorkflowError("terminal", fixture.code, { recoverable: false });
      }),
    });
    const result = await manager.runSync(
      fixture.code === undefined
        ? 'export const meta = { name: "terminal-usage", description: "terminal" }; await agent("stop"); throw new Error("terminal");'
        : 'export const meta = { name: "terminal-usage", description: "terminal" }; return await agent("stop");',
    );
    assert.equal(result.status, fixture.status);
    assert.equal(result.tokenUsage?.total, 10);
    assert.equal(store.persistence.load(result.runId)?.tokenUsage?.total, 10);
    assert.equal(new WorkflowManager({ persistence: store.persistence }).getPersistence().load(result.runId)?.tokenUsage?.cost, 0.5);
  }
});


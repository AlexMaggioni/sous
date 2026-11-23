import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRunner } from "../src/steps/agent-runner.js";
import { WorkflowManager } from "../src/workflow-manager.js";

function fixture(runner: AgentRunner) {
  const cwd = mkdtempSync(join(tmpdir(), "same-run-cwd-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "same-run-store-"));
  return {
    manager: new WorkflowManager({ cwd, persistenceRoot, agent: runner }),
    cleanup() {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(persistenceRoot, { recursive: true, force: true });
    },
  };
}

test("continuation keeps one run id, immutable inputs, config, and cumulative usage", async () => {
  let betaFails = true;
  const prompts: string[] = [];
  const runner: AgentRunner = {
    async run(prompt, options) {
      prompts.push(prompt);
      if (prompt === "alpha") {
        options.onUsage?.({ input: 4, output: 6, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0.1 });
        return "alpha-result";
      }
      if (betaFails) {
        betaFails = false;
        options.onUsage?.({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0.03 });
        throw new Error("beta failed once");
      }
      options.onUsage?.({ input: 2, output: 5, cacheRead: 0, cacheWrite: 0, total: 7, cost: 0.07 });
      return "beta-result";
    },
  };
  const testRun = fixture(runner);
  try {
    const script = `export const meta = { name: "same-run-usage", description: "same run usage" };
const alpha = await agent("alpha", { label: "alpha", model: "claude/opus" });
const beta = await agent("beta", { label: "beta", model: "codex/gpt" });
if (beta === null) throw new Error("beta is required");
return { alpha, beta, marker: args.marker };`;
    const first = await testRun.manager.runSync(script, { marker: "original" }, {
      runId: "same-run-usage",
    });
    assert.equal(first.status, "failed");
    assert.equal(first.tokenUsage?.total, 13);
    const beforeEvents = testRun.manager.getPersistence().readEvents(first.runId, { limit: 1_000 });

    const started = await testRun.manager.resumeInBackground(first.runId);
    assert.equal(started.accepted, true);
    if (!started.accepted) assert.fail("continuation refused");
    const completed = await started.promise;

    assert.equal(completed.runId, first.runId);
    assert.equal(completed.status, "completed");
    assert.deepEqual(structuredClone(completed.result), {
      alpha: "alpha-result",
      beta: "beta-result",
      marker: "original",
    });
    assert.equal(completed.tokenUsage?.total, 20);
    assert.equal(completed.tokenUsage?.cost, 0.2);
    assert.deepEqual(prompts, ["alpha", "beta", "beta"]);
    const continuationEvents = testRun.manager.getPersistence().readEvents(first.runId, {
      after: beforeEvents.endCursor,
      limit: 1_000,
      streamId: beforeEvents.streamId,
    });
    assert.equal(continuationEvents.streamId, beforeEvents.streamId);
    assert.equal(continuationEvents.events[0]?.event.type, "resumed");

    const persisted = testRun.manager.getPersistence().load(first.runId);
    assert.equal(persisted?.continuation?.generation, 1);
    assert.equal(persisted?.continuation?.replayedPrefix, 1);
    assert.deepEqual(persisted?.calls?.map((call) => call.modelRequested), ["claude/opus", "codex/gpt"]);
    assert.deepEqual(persisted?.args, { marker: "original" });
    assert.equal(persisted?.tokenUsage?.total, 20);
  } finally {
    testRun.cleanup();
  }
});

test("the first leased checkpoint answer wins; repeats are idempotent and conflicts stay ignored", async () => {
  const testRun = fixture({ async run() { return "unused"; } });
  try {
    const script = `export const meta = { name: "checkpoint-race", description: "checkpoint race" };
return await checkpoint("ship?", { kind: "select", choices: ["ship", "hold"], });`;
    const paused = await testRun.manager.runSync(script, undefined, {
      runId: "checkpoint-race",
    });
    assert.equal(paused.status, "paused");

    const [first, conflicting] = await Promise.all([
      testRun.manager.resumeInBackground(paused.runId, { checkpointReplies: { 0: "ship" } }),
      testRun.manager.resumeInBackground(paused.runId, { checkpointReplies: { 0: "hold" } }),
    ]);
    assert.equal(first.accepted, true);
    if (!first.accepted) assert.fail("first answer refused");
    assert.equal(conflicting.accepted, false);
    const completed = await first.promise;
    assert.equal(completed.result, "ship");

    const repeated = await testRun.manager.resumeInBackground(paused.runId, {
      checkpointReplies: { 0: "ship" },
    });
    assert.equal(repeated.accepted, false);

    const persisted = testRun.manager.getPersistence().load(paused.runId);
    assert.equal(persisted?.journal?.find((entry) => entry.index === 0)?.result, "ship");
  } finally {
    testRun.cleanup();
  }
});

test("a mismatched checkpoint batch never reports or persists a provisional answer", async () => {
  const testRun = fixture({ async run() { return "unused"; } });
  try {
    const script = `export const meta = { name: "checkpoint-batch", description: "checkpoint batch" };
return await checkpoint("ship?", { });`;
    const paused = await testRun.manager.runSync(script, undefined, {
      runId: "checkpoint-batch",
    });
    assert.equal(paused.status, "paused");

    const refused = await testRun.manager.resumeInBackground(paused.runId, {
      checkpointReplies: { 0: true, 1: false },
    });
    assert.deepEqual(refused, { accepted: false });
    assert.equal(
      testRun.manager.getPersistence().load(paused.runId)?.journal?.some((entry) => entry.index === 0),
      false,
    );

    const continued = await testRun.manager.resumeInBackground(paused.runId, {
      checkpointReplies: { 0: true },
    });
    assert.equal(continued.accepted, true);
    if (continued.accepted) assert.equal((await continued.promise).result, true);
  } finally {
    testRun.cleanup();
  }
});

test("a repeated earlier answer never moves the run past a later pending checkpoint", async () => {
  const testRun = fixture({ async run() { return "unused"; } });
  try {
    const script = `export const meta = { name: "two-gates", description: "two gates" };
const first = await checkpoint("first?", { kind: "confirm" });
const second = await checkpoint("second?", { kind: "confirm" });
return { first, second };`;
    const paused = await testRun.manager.runSync(script, undefined, {
      runId: "two-gates",
    });
    assert.equal(paused.status, "paused");
    assert.equal(paused.checkpointContext?.callIndex, 0);

    const answered = await testRun.manager.resumeInBackground("two-gates", {
      checkpointReplies: { 0: false },
    });
    assert.equal(answered.accepted, true);
    if (!answered.accepted) assert.fail("answer refused");
    await answered.promise.catch(() => undefined);
    const pausedAgain = testRun.manager.getPersistence().load("two-gates");
    assert.equal(pausedAgain?.pauseReason, "checkpoint_required");
    assert.equal(pausedAgain?.checkpointContext?.callIndex, 1);

    // A repeat of answer 0 is not an answer for checkpoint 1. The run must stay paused rather
    // than resolve the second gate to its authored default.
    const repeated = await testRun.manager.resumeInBackground("two-gates", { checkpointReplies: { 0: false } });
    if (!repeated.accepted) assert.fail("the repeat should re-pause the run");
    await assert.rejects(repeated.promise, /checkpoint "second\?" awaits a human decision/);
    assert.equal(testRun.manager.getPersistence().load("two-gates")?.status, "paused");

    const conflicting = await testRun.manager.resumeInBackground("two-gates", { checkpointReplies: { 0: true } });
    if (!conflicting.accepted) assert.fail("the conflict should re-pause the run");
    await assert.rejects(conflicting.promise, /checkpoint "second\?" awaits a human decision/);

    const finished = await testRun.manager.resumeInBackground("two-gates", { checkpointReplies: { 0: false, 1: false } });
    assert.equal(finished.accepted, true);
    if (!finished.accepted) assert.fail("answers refused");
    const completed = await finished.promise;
    assert.equal(completed.status, "completed");
    assert.deepEqual(structuredClone(completed.result), { first: false, second: false });
  } finally {
    testRun.cleanup();
  }
});

test("SDK same-ID recovery keeps the persisted default model and replays the journaled prefix", async () => {
  const models: Array<string | undefined> = [];
  let failBeta = true;
  const testRun = fixture({
    async run(prompt, options) {
      models.push(options.model);
      if (prompt === "beta" && failBeta) {
        failBeta = false;
        throw new Error("beta failed once");
      }
      return `ok:${prompt}`;
    },
  });
  try {
    const script = `export const meta = { name: "default-model", description: "default model" };
const alpha = await agent("alpha");
const beta = await agent("beta");
if (beta === null) throw new Error("beta is required");
return { alpha, beta };`;
    const first = await testRun.manager.runSync(script, undefined, { runId: "default-model", defaultModel: "codex/gpt" });
    assert.equal(first.status, "failed");
    assert.equal(testRun.manager.getPersistence().load("default-model")?.defaultModel, "codex/gpt");

    const resumed = await testRun.manager.resumeInBackground("default-model");
    assert.equal(resumed.accepted, true);
    const completed = await resumed.promise!;
    assert.equal(completed.status, "completed");
    assert.deepEqual(models, ["codex/gpt", "codex/gpt", "codex/gpt"], "alpha replays; beta re-runs under the persisted default");
  } finally {
    testRun.cleanup();
  }
});

test("a fresh manager preserves actual authored configuration on cold continuation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "same-run-cold-cwd-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "same-run-cold-store-"));
  const dispatched: Array<{ model?: string; mode?: string; configOptions?: unknown }> = [];
  let failBeta = true;
  const runner: AgentRunner = {
    async run(prompt, options) {
      dispatched.push({ model: options.model, mode: options.mode, configOptions: (options as Record<string, unknown>).configOptions });
      if (prompt === "beta" && failBeta) {
        failBeta = false;
        throw new Error("beta failed once");
      }
      return `ok:${prompt}`;
    },
  };
  try {
    const script = `export const meta = { name: "cold-dispatch", description: "cold dispatch" };
const alpha = await agent("alpha", { label: "alpha", model: "claude/opus", mode: "bypassPermissions", configOptions: { effort: "high", verbose: true } });
const beta = await agent("beta", { label: "beta", model: "codex/gpt", mode: "agent", configOptions: { reasoning_effort: "xhigh" } });
if (beta === null) throw new Error("beta is required");
return { alpha, beta };`;
    const warm = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
    const first = await warm.runSync(script, undefined, {
      runId: "cold-dispatch",
    });
    assert.equal(first.status, "failed");
    assert.deepEqual(dispatched.map((call) => call.model), ["claude/opus", "codex/gpt"]);

    const cold = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
    const started = await cold.resumeInBackground("cold-dispatch");
    assert.equal(started.accepted, true);
    if (!started.accepted) assert.fail("continuation refused");
    const completed = await started.promise;
    assert.equal(completed.status, "completed");
    assert.equal(dispatched.length, 3, "alpha replays from the journal; only beta runs live");
    // No step reads configOptions. The call record keeps them.
    assert.deepEqual(structuredClone(dispatched[2]), {
      model: "codex/gpt",
      mode: "agent",
      configOptions: undefined,
    });
    assert.deepEqual(
      completed.calls?.filter((call) => call.label === "beta").map((call) => call.configOptionsRequested),
      [{ reasoning_effort: "xhigh" }],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

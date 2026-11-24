import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { judge } from "../src/runs/rule.js";
import type { StepRequest } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import { createSteps, type StepsOptions } from "../src/steps/steps.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { deferred } from "./helpers/async.js";
import { eventLog } from "./helpers/event-log.js";
import { memoryPersistence } from "./helpers/memory-persistence.js";
import { runnerFrom } from "./helpers/runners.js";
import { withTempDirs } from "./helpers/temp.js";

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

  const replayRunner = runnerFrom(() => {
    assert.fail("a matching enriched journal entry must replay without invoking the runner");
  });
  const replayed = await new WorkflowManager({ persistence: store.persistence, agent: replayRunner }).runSync(
    script,
    undefined,
    { resumeFromRunId: paused.runId },
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

// Piece 14. A budget pause has its own reason, in the state, the saved event, the live event and
// the word.
const budgetScript = (body: string) => `export const meta = { name: "budget", description: "budget" };\n${body}`;
const BUDGET = "the run reached its budget of 1500 tokens";

test("a budget pause projects as paused: budget", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    const entered = deferred<void>();
    const runner: AgentRunner = {
      async run(_prompt: string, options: StepRequest): Promise<unknown> {
        entered.resolve();
        return await new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      },
    };
    const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: runner });
    const live: string[] = [];
    manager.on("paused", (payload) => live.push(payload.reason));
    const background = manager.startInBackground(budgetScript(`return await agent('held', { label: 'held', retries: 0 })`));
    await entered.promise;
    const stop = { pauseReason: "budget" as const, message: BUDGET };
    assert.equal(manager.cancelAgentSteps(background.runId, stop), 1);
    await assert.rejects(background.promise);

    const state = manager.getPersistence().load(background.runId);
    assert.equal(state?.status, "paused");
    assert.equal(state?.pauseReason, "budget");
    const persisted = eventLog(manager).readEvents(background.runId, { limit: 1_000 }).events
      .filter((record) => record.event.type === "paused")
      .map((record) => (record.event.type === "paused" ? record.event.reason : undefined));
    assert.deepEqual(persisted, ["budget"], "the saved event says what the state says");
    assert.deepEqual(live, ["budget"], "the live event says what the state says");
    const verdict = judge({ state: state!, alive: false, openQuestions: 0 });
    assert.deepEqual([verdict.word, verdict.exit, verdict.pause?.reason], ["paused: budget", 2, "budget"]);
  });
});

test("a step the gate stops on budget pauses the run with that reason, and no retry runs it", async () => {
  await withTempDirs(async ({ cwd, root }) => {
    const ran: string[] = [];
    let open = true;
    let askedClosed = 0;
    const options = {
      cwd,
      inner: { run: async (prompt: string) => { ran.push(prompt); return `${prompt} done`; } },
      gate: () => {
        if (open) return undefined;
        askedClosed += 1;
        return { pauseReason: "budget" as const, message: BUDGET };
      },
    };
    const steps = createSteps(options as StepsOptions);
    const runner: AgentRunner = {
      route: (ask) => steps.route(ask),
      run: async (prompt, request) => {
        const answer = await steps.run(prompt, request);
        open = false;
        return answer;
      },
    };
    const manager = new WorkflowManager({ cwd, persistenceRoot: root, agent: runner });
    const result = await manager.runSync(budgetScript([
      "const a = await agent('a', { label: 'a' })",
      "const b = await agent('b', { label: 'b', retries: 2 })",
      "return [a, b]",
    ].join("\n")));
    await steps.dispose();

    assert.equal(result.status, "paused");
    const state = manager.getPersistence().load(result.runId);
    assert.equal(state?.pauseReason, "budget");
    assert.deepEqual(ran, ["a"], "step b never reached the agent");
    assert.equal(askedClosed, 1, "a retry would ask the gate again");
  });
});

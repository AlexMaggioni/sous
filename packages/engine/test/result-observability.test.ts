import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { StepRequest } from "../src/steps/agent-run.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const SCRIPT = `export const meta = { name: 'fallbacks', description: 'fallbacks', phases: [{ title: 'Review' }] }
const first = await agent('one', { label: 'whole', model: 'missing-model' })
const second = await agent('two', { label: 'modifier', phase: 'Review', model: 'gpt-example[high]' })
const decision = await checkpoint('Release?', { kind: 'confirm' })
return { first, second, decision }`;

function sessionRunner(): AgentRunner {
  let call = 0;
  return {
    run: async (_prompt: string, options: StepRequest) => {
      options.onSessionOpen?.({
        sessionId: `session-${call}`,
        backendId: "codex",
        cwd: "/workspace",
        reopen: { load: true, resume: true, list: true },
      });
      if (call > 0) options.onModelResolved?.("gpt-example");
      call++;
      return "ok";
    },
  };
}

test("manager persists checkpoint observability and replay-only executions omit fallbacks", async () => {
  const persistenceRoot = mkdtempSync(join(tmpdir(), "sous-result-observability-"));
  const cwd = mkdtempSync(join(tmpdir(), "sous-result-observability-cwd-"));
  try {
    const manager = new WorkflowManager({ cwd, persistenceRoot, agent: sessionRunner() });
    const first = await manager.runSync(SCRIPT, undefined, { confirm: async () => false });
    assert.equal(first.status, "completed");

    const persisted = manager.getPersistence().load(first.runId);
    assert.deepEqual(persisted?.fallbacks, first.fallbacks);
    assert.deepEqual(persisted?.checkpointsTaken, [
      { callIndex: 2, kind: "confirm", decision: false, source: "live" },
    ]);

    let replayCalls = 0;
    const replay = new WorkflowManager({
      cwd,
      persistenceRoot,
      agent: {
        async run() {
          replayCalls++;
          return "unexpected";
        },
      },
    });
    const replayed = await replay.runSync(SCRIPT, undefined, { resumeFromRunId: first.runId });
    assert.equal(replayed.status, "completed");
    assert.equal(replayCalls, 0);
    assert.equal(replayed.fallbacks, undefined, "fallback entries arise only from live calls in this execution");
    assert.deepEqual(replayed.checkpointsTaken, [
      { callIndex: 2, kind: "confirm", decision: false, source: "journal-replay" },
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

test("a reuse run that fails before its engine returns lists its root call rows in the order they settled", async () => {
  const persistenceRoot = mkdtempSync(join(tmpdir(), "sous-result-settled-"));
  const cwd = mkdtempSync(join(tmpdir(), "sous-result-settled-cwd-"));
  try {
    const source = await new WorkflowManager({ cwd, persistenceRoot, agent: { run: async () => "source" } }).runSync(
      `export const meta = { name: 'settled', description: 'settled' }\nreturn await agent('source')`,
    );
    assert.equal(source.status, "completed");

    let fastDone!: () => void;
    const fastSettled = new Promise<void>((resolve) => { fastDone = resolve; });
    const manager = new WorkflowManager({
      cwd,
      persistenceRoot,
      agent: {
        run: async (prompt: string) => {
          if (prompt === "slow") await fastSettled;
          else fastDone();
          return prompt;
        },
      },
    });
    const reuse = await manager.runSync(
      `export const meta = { name: 'settled', description: 'settled' }
await Promise.all([agent('slow'), agent('fast')])
throw new Error('stop after both steps')`,
      undefined,
      { resumeFromRunId: source.runId },
    );

    assert.equal(reuse.status, "failed");
    assert.deepEqual(reuse.calls?.map((row) => row.index), [1, 0], "the fast step at index 1 settled first");
    const saved = manager.getPersistence().load(reuse.runId);
    assert.deepEqual(saved?.calls?.map((row) => row.index), [0, 1], "the saved state keeps its rows by index");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

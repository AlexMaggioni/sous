import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowManager } from "../src/workflow-manager.js";

test("settled history yields to another owner's continuation even when both generations pause", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-owner-inspection-"));
  const persistenceRoot = join(cwd, "store");
  const runner = { async run() { return "unused"; } };
  const first = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
  const second = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
  try {
    const initial = await first.runSync(`export const meta = { name: "owner-inspection", description: "same-run ownership" };
const first = await checkpoint("First?");
const second = await checkpoint("Second?");
return [first, second];`);
    assert.equal(initial.status, "paused");
    const cached = first.getRun(initial.runId);
    assert.ok(cached, "the originating SDK retains its own settled history");
    assert.equal(first.getRun(initial.runId), cached);

    const next = await second.resumeInBackground(initial.runId, {
      confirm: async (prompt) => (prompt === "First?" ? true : undefined),
    });
    assert.ok(next.accepted);
    await assert.rejects(next.promise);
    assert.equal(second.getPersistence().load(initial.runId)?.status, "paused");
    assert.equal(first.getRun(initial.runId), undefined, "an older cached pause does not represent the new owner");

    const last = await second.resumeInBackground(initial.runId, { confirm: async () => false });
    assert.ok(last.accepted);
    await last.promise;
    assert.equal(first.getPersistence().load(initial.runId)?.status, "completed");
    assert.equal(second.getRun(initial.runId)?.status, "completed", "the current SDK keeps its completed history");
    second.getPersistence().delete(initial.runId);
    assert.equal(second.getRun(initial.runId)?.status, "completed", "removing durable artifacts does not erase SDK memory history");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("another manager's whole stop supersedes a cached pause in the same generation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-owner-stop-"));
  const persistenceRoot = join(cwd, "store");
  const runner = { async run() { return "unused"; } };
  const first = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
  const second = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
  try {
    const paused = await first.runSync('export const meta = { name: "owner-stop", description: "same-generation stop" }; return await checkpoint("Continue?");');
    assert.equal(paused.status, "paused");
    const originalGeneration = first.getRun(paused.runId)?.continuation?.generation;
    assert.equal(second.stopPersistedRun(paused.runId).outcome, "stopped");
    assert.equal(first.getPersistence().load(paused.runId)?.continuation?.generation, originalGeneration);
    assert.equal(first.getRun(paused.runId), undefined, "a same-generation foreign stop replaces the old pause");
    assert.equal(first.getPersistence().load(paused.runId)?.status, "aborted");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

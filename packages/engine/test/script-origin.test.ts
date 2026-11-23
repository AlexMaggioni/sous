import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { createRunPersistence, inlineScriptFile, type PersistedRunState, type RunPersistence } from "../src/runs/persistence/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const runner: AgentRunner = { async run() { return "unused"; } };
const script = (name: string) => `export const meta = { name: '${name}', description: 'script origin' }\nreturn 42`;

async function inStore(fn: (paths: { cwd: string; persistenceRoot: string; root: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "workflow-script-origin-"));
  try {
    await fn({ cwd: root, persistenceRoot: join(root, "storage"), root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an inline run records its origin and writes no script copy, and delete removes an old copy", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    const source = script("inline");
    const run = await manager.runSync(source);
    const persistence = manager.getPersistence();
    const location = inlineScriptFile(persistence.getRunsDir(), run.runId);
    assert.deepEqual(persistence.load(run.runId)?.scriptOrigin, { kind: "inline" }, "runs default to an inline origin");
    assert.equal(persistence.load(run.runId)?.script, source);
    assert.equal(existsSync(location), false, "the state holds the script, so no copy is written");

    // An older engine wrote a copy next to the state. Deleting the run removes it.
    writeFileSync(location, source);
    assert.equal(manager.deleteRun(run.runId), true);
    assert.equal(existsSync(location), false, "deleting the run removes an old inline copy");
  });
});

test("a path origin records the caller's file, writes no copy, and delete never touches the caller's file", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    const scriptPath = join(paths.root, "flow.workflow.js");
    const source = script("path");
    writeFileSync(scriptPath, source);
    const run = await manager.runSync(source, undefined, { scriptOrigin: { kind: "path", path: scriptPath } });
    const persistence = manager.getPersistence();
    assert.deepEqual(persistence.load(run.runId)?.scriptOrigin, { kind: "path", path: scriptPath });
    assert.equal(existsSync(inlineScriptFile(persistence.getRunsDir(), run.runId)), false, "a path run has no store copy");
    writeFileSync(scriptPath, `${source}\n// edited in place`);
    assert.equal(persistence.load(run.runId)?.script, source, "the admitted record is untouched by the edit");
    assert.equal(manager.deleteRun(run.runId), true);
    assert.equal(existsSync(scriptPath), true, "deleting the run never touches the caller's file");
  });
});

test("a script origin must be inline or an absolute path", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    for (const origin of [
      { kind: "path", path: "relative/flow.js" },
      { kind: "url", path: "/abs" },
      { kind: "inline", path: "/abs" },
      { kind: "path" },
    ]) {
      await assert.rejects(
        manager.runSync(script("bad"), undefined, { scriptOrigin: origin as never }),
        (error: unknown) => (error as { code?: string }).code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      );
    }
  });
});

test("a failed initial save rejects and leaves no script file", async () => {
  await inStore(async (paths) => {
    const disk = createRunPersistence(paths.cwd, undefined, { persistenceRoot: paths.persistenceRoot });
    let failSave = false;
    const manager = new WorkflowManager({
      ...paths,
      agent: runner,
      persistence: { ...disk, save(state) { if (failSave) throw new Error("disk unavailable"); disk.save(state); } },
    });
    // A reuse start saves before it returns, so a failed save surfaces here.
    const source = await manager.runSync(script("source"));
    failSave = true;
    await assert.rejects(manager.runSync(script("orphan"), undefined, { runId: "orphan", resumeFromRunId: source.runId }), /failed to persist/);
    assert.deepEqual(readdirSync(disk.getRunsDir()).filter((name) => name.endsWith(".script.js")), []);
  });
});

test("a custom persistence records the origin, and the manager touches no file of its own", async () => {
  await inStore(async (paths) => {
    const records = new Map<string, PersistedRunState>();
    const custom: RunPersistence = {
      save(state) { records.set(state.runId, structuredClone(state)); },
      load(runId) { const state = records.get(runId); return state ? structuredClone(state) : null; },
      list() { return [...records.values()]; },
      delete(runId) { return records.delete(runId); },
      acquireRunLease(runId) { return { runId, token: runId }; },
      releaseRunLease() {},
      getRunsDir() { return join(paths.root, "never-created"); },
    };
    const manager = new WorkflowManager({ agent: runner, persistence: custom });
    const { promise, runId } = manager.startInBackground(script("memory"), undefined, {});
    await promise;
    assert.equal(records.get(runId)?.status, "completed");
    assert.deepEqual(records.get(runId)?.scriptOrigin, { kind: "inline" }, "the origin is recorded without a copy");
    assert.equal(existsSync(join(paths.root, "never-created")), false, "nothing touches the real filesystem");
  });
});

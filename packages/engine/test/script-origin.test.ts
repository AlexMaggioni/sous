import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import { createRunPersistence, inlineScriptFile } from "../src/runs/persistence/run-persistence.js";
import { runsDir } from "./helpers/run-files.js";
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

test("an inline run writes no script copy, and delete removes an old copy", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    const source = script("inline");
    const run = await manager.runSync(source);
    const persistence = manager.getPersistence();
    const location = inlineScriptFile(runsDir(paths.cwd, paths.persistenceRoot), run.runId);
    assert.equal(persistence.load(run.runId)?.script, source);
    assert.equal(existsSync(location), false, "the state holds the script, so no copy is written");

    // An older engine wrote a copy next to the state. Deleting the run removes it.
    writeFileSync(location, source);
    assert.equal(persistence.delete(run.runId), true);
    assert.equal(existsSync(location), false, "deleting the run removes an old inline copy");
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
    assert.deepEqual(readdirSync(runsDir(paths.cwd, paths.persistenceRoot)).filter((name) => name.endsWith(".script.js")), []);
  });
});

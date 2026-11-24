import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunPersistence } from "../src/runs/persistence/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/runs/persistence/project-paths.js";

const SCRIPT = [
  'export const meta = { name: "crash-recovery", description: "crash recovery" };',
  'const first = await agent("first", { label: "first" });',
  'const second = await agent("second", { label: "second" });',
  "return { first, second };",
].join("\n");

async function waitForChildOutput(child: ChildProcess, needle: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`child did not emit ${needle}; stdout=${output}`));
    }, 10_000);
    const settled = (callback: () => void) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      callback();
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(needle)) settled(resolve);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settled(() => reject(new Error(`child exited before readiness: code=${code} signal=${signal}`)));
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

test("SIGKILL crash residue is lazily paused and resumes under its own id", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sous-crash-cwd-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "sous-crash-runs-"));
  const sourceRunId = "sigkill-source";
  const livePrompts: string[] = [];
  const manager = new WorkflowManager({
    cwd,
    persistenceRoot,
    agent: {
      async run(prompt: string) {
        livePrompts.push(prompt);
        return `parent:${prompt}`;
      },
    },
  });
  const fixture = join(import.meta.dirname, "fixtures", "stale-lock-child.ts");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fixture,
      cwd,
      persistenceRoot,
      sourceRunId,
      Buffer.from(SCRIPT, "utf8").toString("base64url"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForChildOutput(child, "SECOND_AGENT_STARTED");
    const persistence = createRunPersistence(cwd, undefined, { persistenceRoot });
    const crashed = persistence.load(sourceRunId);
    assert.equal(crashed?.status, "running");
    assert.equal(crashed?.journal?.length, 1);
    assert.equal(crashed?.resume?.format, "identity-v1");
    assert.equal(crashed?.resume?.terminalEnvironment, undefined);
    const lockPath = join(workflowProjectPaths(cwd, { persistenceRoot }).runsDir, `${sourceRunId}.lock`);
    assert.equal(existsSync(lockPath), true);

    const exited = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    await exited;

    // A new run may not reuse the crashed run. The refusal still reconciles it to paused first.
    await assert.rejects(
      manager.runSync(SCRIPT, undefined, { runId: "sigkill-reused", resumeFromRunId: sourceRunId }),
      new RegExp(`resume source ${sourceRunId} is paused`),
    );
    const reconciled = persistence.load(sourceRunId);
    assert.equal(reconciled?.status, "paused");
    assert.equal(reconciled?.pauseReason, "interrupted");
    assert.match(reconciled?.reason ?? "", new RegExp(`PID ${child.pid} exited`));
    assert.equal(existsSync(lockPath), false);

    const continued = await manager.resumeInBackground(sourceRunId);
    assert.ok(continued.accepted);
    const resumed = await continued.promise;
    assert.equal(resumed.status, "completed");
    const result = resumed.result as Record<string, unknown>;
    assert.equal(result.first, "child:first");
    assert.equal(result.second, "parent:second");
    assert.deepEqual(livePrompts, ["second"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { WorkflowCallRecord } from "../src/workflow-result.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunLease, RunPersistence } from "../src/runs/persistence/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { hashCheckpointInputs } from "../src/checkpoint-call.js";
import { isStepFailedPause, runWorkflow } from "../src/workflow.js";
import { deferred } from "./helpers/async.js";
import { initGitRepo } from "./helpers/git.js";
import { tempDirs } from "./helpers/temp.js";

const script = (body: string, name = "incremental-recording") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: 'incremental recording' }\n${body}`;

describe("checkpoint input recording and byte compatibility", () => {
  it("records fingerprints on resolved and waiting asks", async () => {
    let seenOptions: unknown;
    const result = await runWorkflow(script(`
let reads = 0
const options = {
  get choices() { reads++; return ["yes", "no"] },
  get answeredBy() { reads++; return undefined },
}
const answer = await ask("confirmed", options)
return [answer, reads]`), {
      agent: { async run() { return "unused"; } }, persistLogs: false,
      confirm: async (_prompt, options) => { seenOptions = options; return "yes"; },
    });
    assert.deepEqual([...(result.result as unknown[])], ["yes", 2]);
    assert.deepEqual(JSON.parse(JSON.stringify(seenOptions)), { kind: "select", choices: ["yes", "no"] });
    assert.equal(result.calls?.[0].inputsHash, hashCheckpointInputs({}));
    assert.equal(result.calls?.[0].checkpointDecision, "explicit-v1");
    const waiting: WorkflowCallRecord[] = [];
    await assert.rejects(runWorkflow(script(`try { await ask("paused") } catch {}
return "caught"`), {
      agent: { async run() { return "unused"; } }, persistLogs: false, onCallRecord: row => waiting.push(row),
    }), (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_REQUIRED);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].inputsHash, hashCheckpointInputs({}));
    assert.equal(waiting[0].error?.code, WorkflowErrorCode.CHECKPOINT_REQUIRED);
    assert.equal(waiting[0].checkpointDecision, undefined);
  });
});

describe("quiescence accounting", () => {
  it("reports logical, raw-runner, nested, and root-allocation transitions in exact order", async () => {
    const activities: number[] = [];
    const allocations: number[] = [];
    await runWorkflow(
      script(`
await agent("settled")
await ask("engine")
return "done"`),
      {
        agent: { async run() { return "ok"; } },
        persistLogs: false,
        confirm: async () => true,
        resumeCounts: { active: (active) => activities.push(active), allocated: (allocated) => allocations.push(allocated) },
      },
    );
    assert.deepEqual(activities, [1, 2, 1, 0, 1, 0]);
    assert.deepEqual(allocations, [1, 2]);

    const blocked = deferred<string>();
    const nestedActivities: number[] = [];
    const child = script(`await args\nreturn "child"`, "blocked-child");
    await runWorkflow(script(`void workflow(${JSON.stringify(child)}, args)\nreturn "root"`, "floated-child"), {
      args: blocked.promise,
      agent: { async run() { return "unused"; } },
      persistLogs: false,
      resumeCounts: { active: (active) => nestedActivities.push(active) },
    });
    assert.deepEqual(nestedActivities, [1]);
    blocked.resolve("ready");
    for (let attempt = 0; attempt < 50 && nestedActivities.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.deepEqual(nestedActivities, [1, 0]);
  });

  it("counts a code step as activity like an agent, and a call refused before it takes an index not at all", async () => {
    // The activity counts, with the script's log line between them.
    const seen: Array<number | string> = [];
    const allocations: number[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "activity-code-"));
    const result = await runWorkflow<string[]>(
      // The code step is still running when the other two calls are refused. A refused call
      // that counted as activity would lower the count before the log line.
      script(`
const running = js("return 1")
const refused = []
try { await agent("bad", { notAnOption: true }) } catch { refused.push("agent") }
try { await ask(42) } catch { refused.push("ask") }
log("refused")
await running
return refused`),
      {
        agent: { async run() { return "unused"; } },
        cwd,
        persistLogs: false,
        resumeCounts: { active: (active) => seen.push(active), allocated: (allocated) => allocations.push(allocated) },
        onLog: (message) => seen.push(message),
      },
    );
    assert.deepEqual([...result.result], ["agent", "ask"]);
    assert.deepEqual(seen, [1, 2, "refused", 1, 0]);
    assert.deepEqual(allocations, [1]);
  });

  it("decrements a synchronously throwing runner unit", async () => {
    const syncActivities: number[] = [];
    // The failed step pauses the run, even though the script catches the error.
    await assert.rejects(
      runWorkflow(script(`try { await agent("sync") } catch {}\nreturn "caught"`), {
        agent: { run() { throw new Error("sync"); } } as AgentRunner,
        persistLogs: false,
        resumeCounts: { active: (active) => syncActivities.push(active) },
      }),
      (error: unknown) => isStepFailedPause(error as { code?: unknown; details?: unknown }),
    );
    assert.deepEqual(syncActivities, [1, 2, 1, 0]);
  });
});

describe("managed identity-v1 persistence", () => {
  it("records the folder's git state at the end of a run that changed a tracked file", async () => {
    const dirs = tempDirs();
    try {
      initGitRepo(dirs.cwd, "tracked.txt", "clean\n");
      const gitManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: {
          async run() {
            writeFileSync(join(dirs.cwd, "tracked.txt"), "changed\n");
            return "changed";
          },
        },
      });
      const gitRun = await gitManager.runSync(script(`return await agent("writer")`, "git-writer"));
      const persisted = gitManager.getPersistence().load(gitRun.runId);
      assert.ok(persisted?.resume?.terminalEnvironment?.git);
      assert.notEqual(
        persisted.resume.terminalEnvironment.git.dirtyDigest,
        persisted.environment?.git?.dirtyDigest,
      );
    } finally {
      dirs.cleanup();
    }
  });

  it("records a failed run's call rows densely", async () => {
    const dirs = tempDirs();
    try {
      // In a git checkout a run that called an agent still records its terminal state.
      initGitRepo(dirs.cwd, "tracked.txt", "clean\n");
      const failedManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "ok"; } },
      });
      const failed = await failedManager.runSync(
        script(`await agent("safe")\nthrow new Error("script")`, "dense-failure"),
      );
      const failedState = failedManager.getPersistence().load(failed.runId);
      assert.equal(failed.status, "failed");
      assert.equal(failedState?.callsAllocated, 1);
      assert.deepEqual(failedState?.calls?.map((row) => row.index), [0]);
      assert.ok(failedState?.resume?.terminalEnvironment?.git);
    } finally {
      dirs.cleanup();
    }
  });
});

describe("critical legacy marking", () => {
  function failingPersistence(root: string): {
    persistence: RunPersistence;
    states: Map<string, PersistedRunState>;
    failSave: (value: boolean) => void;
  } {
    mkdirSync(root, { recursive: true });
    const states = new Map<string, PersistedRunState>();
    const leases = new Set<string>();
    let failing = false;
    const persistence: RunPersistence = {
      save(state) {
        if (failing) throw new Error("save failed");
        states.set(state.runId, structuredClone(state));
      },
      load(runId) { return states.get(runId) ? structuredClone(states.get(runId)!) : null; },
      list() { return [...states.values()].map((state) => structuredClone(state)); },
      delete(runId) { return states.delete(runId); },
      acquireRunLease(runId) {
        if (leases.has(runId)) return null;
        leases.add(runId);
        return { runId, token: runId };
      },
      releaseRunLease(lease: RunLease) { leases.delete(lease.runId); },
      validateRunLease() { return true; },
    };
    return { persistence, states, failSave: (value) => { failing = value; } };
  }

  it("starts no same-ID execution when the permanent write fails", async () => {
    const dirs = tempDirs();
    try {
      const sameStore = failingPersistence(join(dirs.root, "same-id"));
      const now = new Date().toISOString();
      sameStore.persistence.save({
        runId: "same-id",
        workflowName: "same-id",
        script: script(`return await agent("x")`, "same-id"),
        status: "paused",
        phases: [],
        agents: [],
        logs: [],
        journal: [],
        startedAt: now,
        updatedAt: now,
      });
      sameStore.failSave(true);
      let sameCalls = 0;
      const sameManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: sameStore.persistence,
        agent: { async run() { sameCalls++; return "live"; } },
      });
      await assert.rejects(
        sameManager.resumeInBackground("same-id"),
        (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR,
      );
      assert.equal(sameCalls, 0);
      sameStore.failSave(false);
      const sameLease = sameStore.persistence.acquireRunLease("same-id");
      assert.ok(sameLease, "failed same-ID marker save releases the run lease");
      sameStore.persistence.releaseRunLease(sameLease);
    } finally {
      dirs.cleanup();
    }
  });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { JournalEntry, WorkflowCallRecord } from "../src/workflow-result.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { OccurrenceResume } from "../src/resume.js";
import type { PersistedRunState, RunLease, RunPersistence } from "../src/runs/persistence/run-persistence.js";
import { runsDir } from "./helpers/run-files.js";
import { normalizeResumeSeed } from "../src/resume-matcher.js";
import { resumeRows } from "../src/resume-rows.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { tempPlaces } from "./helpers/places.js";
import { hashCheckpointInputs } from "../src/checkpoint-call.js";
import { isStepFailedPause, runWorkflow } from "../src/workflow.js";

const script = (body: string, name = "incremental-recording") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: 'incremental recording' }\n${body}`;

function tempDirs(): { cwd: string; root: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "incremental-recording-cwd-"));
  const root = mkdtempSync(join(tmpdir(), "incremental-recording-root-"));
  return {
    cwd,
    root,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function initGitRepo(cwd: string): void {
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Tests"]);
  writeFileSync(join(cwd, "tracked.txt"), "clean\n");
  execFileSync("git", ["-C", cwd, "add", "tracked.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function resultRow(overrides: Partial<WorkflowCallRecord> = {}): WorkflowCallRecord {
  return {
    index: 0,
    kind: "agent",
    hash: "a".repeat(64),
    outcome: "result",
    origin: "runner",
    scope: "source",
    ...overrides,
  };
}

describe("resume authoring declaration and safety recording", () => {
});

describe("checkpoint input recording and byte compatibility", () => {
  it("captures option getters once and records fingerprints on resolved and waiting checkpoints", async () => {
    let seenOptions: unknown;
    const result = await runWorkflow(script(`
let reads = 0
const options = {
  get kind() { reads++; return "select" },
  get choices() { reads++; return ["yes", "no"] },
  get timeoutMs() { reads++; return 50 },
}
await checkpoint("confirmed", options)
return reads`), {
      agent: { async run() { return "unused"; } }, persistLogs: false,
      confirm: async (_prompt, options) => { seenOptions = options; return "yes"; },
    });
    assert.equal(result.result, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(seenOptions)), { kind: "select", choices: ["yes", "no"], timeoutMs: 50 });
    assert.equal(result.calls?.[0].inputsHash, hashCheckpointInputs({ timeoutMs: 50 }));
    assert.equal(result.calls?.[0].checkpointDecision, "explicit-v1");
    const waiting: WorkflowCallRecord[] = [];
    await assert.rejects(runWorkflow(script(`try { await checkpoint("paused", { timeoutMs: 75 }) } catch {}
return "caught"`), {
      agent: { async run() { return "unused"; } }, persistLogs: false, onCallRecord: row => waiting.push(row),
    }), (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_REQUIRED);
    assert.equal(waiting[0].inputsHash, hashCheckpointInputs({ timeoutMs: 75 }));
    assert.equal(waiting[0].error?.code, WorkflowErrorCode.CHECKPOINT_REQUIRED);
    assert.equal(waiting[0].checkpointDecision, undefined);
  });
});

describe("filesystem taint and quiescence accounting", () => {
  it("fires every recording-side taint trigger and leaves proven engine-only paths clean", async () => {
    const tainted: string[] = [];
    const run = async (
      name: string,
      body: string,
      options: Partial<Parameters<typeof runWorkflow>[1]> = {},
    ) => {
      let calls = 0;
      await runWorkflow(script(body, name), {
        agent: { async run() { return "live"; } },
        persistLogs: false,
        ...options,
        onResumeFilesystemTainted: () => { calls++; },
      });
      if (calls > 0) tainted.push(name);
      return calls;
    };
    assert.equal(await run("unannotated", `return await agent("write")`), 1);
    assert.equal(
      await run("confirm", `return await checkpoint("host")`, { confirm: async () => true }),
      1,
    );
    let waitingTaints = 0;
    await assert.rejects(runWorkflow(script(`return await checkpoint("engine")`), {
      agent: { async run() { return "unused"; } }, persistLogs: false,
      onResumeFilesystemTainted: () => { waitingTaints++; },
    }), (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_REQUIRED);
    assert.equal(waitingTaints, 0);
    const child = script(`return "child"`, "child");
    assert.equal(await run("nested", `return await workflow(${JSON.stringify(child)})`), 1);
    assert.equal(
      await run(
        "degraded",
        `return await agent("worktree", { isolation: "worktree" })`,
        { cwd: mkdtempSync(join(tmpdir(), "taint-degraded-")) },
      ),
      1,
    );
    assert.deepEqual(tainted, ["unannotated", "confirm", "nested", "degraded"]);
  });

  it("reports logical, raw-runner, nested, and root-allocation transitions in exact order", async () => {
    const activities: number[] = [];
    const allocations: number[] = [];
    await runWorkflow(
      script(`
await agent("settled")
await checkpoint("engine")
return "done"`),
      {
        agent: { async run() { return "ok"; } },
        persistLogs: false,
        confirm: async () => true,
        onResumeActivity: (active) => activities.push(active),
        onResumeCallAllocated: (allocated) => allocations.push(allocated),
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
      onResumeActivity: (active) => nestedActivities.push(active),
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
try { await checkpoint(42) } catch { refused.push("checkpoint") }
log("refused")
await running
return refused`),
      {
        agent: { async run() { return "unused"; } },
        cwd,
        persistLogs: false,
        onResumeActivity: (active) => seen.push(active),
        onLog: (message) => seen.push(message),
        onResumeCallAllocated: (allocated) => allocations.push(allocated),
      },
    );
    assert.deepEqual([...result.result], ["agent", "checkpoint"]);
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
        onResumeActivity: (active) => syncActivities.push(active),
      }),
      (error: unknown) => isStepFailedPause(error as { code?: unknown; details?: unknown }),
    );
    assert.deepEqual(syncActivities, [1, 2, 1, 0]);
  });
});

describe("managed identity-v1 persistence", () => {
  it("pins initial and terminal marker, format, allocation, and key-arm JSON", async () => {
    const dirs = tempDirs();
    const pending = deferred<string>();
    try {
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "workspace-v1",
        agent: { async run() { return await pending.promise; } },
      });
      const started = manager.startInBackground(
        script(`return await agent("safe")`, "json-fixture"),
      );
      const runFile = join(runsDir(dirs.cwd, dirs.root), `${started.runId}.json`);
      const initial = JSON.parse(readFileSync(runFile, "utf8")) as PersistedRunState;
      const initialFixture = JSON.parse(
        readFileSync(join(import.meta.dirname, "fixtures", "identity-v1-initial.json"), "utf8"),
      );
      assert.deepEqual(
        {
          resume: initial.resume,
          runtime: { checkpointInputsFormat: initial.runtime?.checkpointInputsFormat },
          callsAllocated: initial.callsAllocated,
        },
        initialFixture,
      );
      assert.equal(Object.hasOwn(initial.resume ?? {}, "terminalEnvironment"), false);

      pending.resolve("done");
      await started.promise;
      const terminal = JSON.parse(readFileSync(runFile, "utf8")) as PersistedRunState;
      const terminalFixture = JSON.parse(
        readFileSync(join(import.meta.dirname, "fixtures", "identity-v1-terminal.json"), "utf8"),
      );
      assert.deepEqual(
        {
          resume: terminal.resume,
          runtime: { checkpointInputsFormat: terminal.runtime?.checkpointInputsFormat },
          callsAllocated: terminal.callsAllocated,
        },
        terminalFixture,
      );
    } finally {
      dirs.cleanup();
    }
  });

  it("omits unsafe key arms, captures tainted git terminal state, and preserves zero-call keys", async () => {
    const dirs = tempDirs();
    try {
      const keyManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "static-key",
        agent: { async run() { return "ok"; } },
      });
      const unsafe = await keyManager.runSync(script(`return await agent("writer")`, "unsafe-key"));
      assert.deepEqual(keyManager.getPersistence().load(unsafe.runId)?.resume, { format: "identity-v1" });
      const confirmed = await keyManager.runSync(
        script(`return await checkpoint("host")`, "confirm-key"),
        undefined,
        { confirm: async () => true },
      );
      const child = script(`return "child"`, "key-child");
      const nested = await keyManager.runSync(
        script(`return await workflow(${JSON.stringify(child)})`, "nested-key"),
      );
      const degraded = await keyManager.runSync(
        script(`return await agent("worktree", { isolation: "worktree" })`, "degraded-key"),
      );
      for (const run of [confirmed, nested, degraded]) {
        assert.deepEqual(keyManager.getPersistence().load(run.runId)?.resume, { format: "identity-v1" });
      }
      const zero = await keyManager.runSync(script(`return "zero"`, "zero-call"));
      assert.deepEqual(keyManager.getPersistence().load(zero.runId)?.resume?.terminalEnvironment, {
        key: "static-key",
      });
      const waiting = await keyManager.runSync(
        script(`return await checkpoint("engine")`, "waiting-key"),
      );
      assert.deepEqual(keyManager.getPersistence().load(waiting.runId)?.resume?.terminalEnvironment, {
        key: "static-key",
      });

      initGitRepo(dirs.cwd);
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

  it("finalizes safe floated calls while unsafe activity omits terminal identity", async () => {
    const dirs = tempDirs();
    const unsafeAgent = deferred<string>();
    const floatedCheckpoint = deferred<unknown>();
    try {
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "static-key",
        agent: {
          async run(prompt) {
            assert.equal(prompt, "unsafe");
            return await unsafeAgent.promise;
          },
        },
      });
      const unsafeRun = await manager.runSync(
        script(`void agent("unsafe")\nreturn "early"`, "floated-unsafe-agent"),
      );
      assert.equal(manager.getPersistence().load(unsafeRun.runId)?.resume?.terminalEnvironment, undefined);
      unsafeAgent.resolve("late");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(manager.getPersistence().load(unsafeRun.runId)?.resume?.terminalEnvironment, undefined);

      const checkpointRun = await manager.runSync(
        script(`void checkpoint("floated")\nreturn "early"`, "floated-checkpoint"),
        undefined,
        { confirm: async () => await floatedCheckpoint.promise },
      );
      assert.equal(manager.getPersistence().load(checkpointRun.runId)?.resume?.terminalEnvironment, undefined);
      floatedCheckpoint.resolve(true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(manager.getPersistence().load(checkpointRun.runId)?.resume?.terminalEnvironment, undefined);
    } finally {
      dirs.cleanup();
    }
  });

  it("records dense failures and fails closed on invalid activity", async () => {
    const dirs = tempDirs();
    try {
      // In a git checkout a run that called an agent still records its terminal state.
      initGitRepo(dirs.cwd);
      const failedManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "static-key",
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

      const invalidPending = deferred<string>();
      const invalidManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        environmentKey: "static-key",
        agent: { async run() { return await invalidPending.promise; } },
      });
      const invalid = invalidManager.startInBackground(
        script(`return await agent("safe")`, "invalid-counter"),
      );
      const managed = invalidManager.getRun(invalid.runId);
      assert.ok(managed);
      managed.resumeActivityInvalid = true;
      invalidPending.resolve("done");
      await invalid.promise;
      assert.equal(invalidManager.getPersistence().load(invalid.runId)?.resume?.terminalEnvironment, undefined);
    } finally {
      dirs.cleanup();
    }
  });

  it("compacts a run fed a journal to its own result rows and drops inherited suffixes", async () => {
    const dirs = tempDirs();
    try {
      const sourceJournal: JournalEntry[] = [];
      await runWorkflow(
        script(`await agent("first")\nreturn await agent("second")`, "compaction-source"),
        {
          runId: "source",
          agent: { async run(prompt) { return prompt; } },
          persistLogs: false,
          onAgentJournal: (entry) => sourceJournal.push(entry),
        },
      );
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { throw new Error("must replay"); } },
      });
      const resumed = await manager.runSync(
        script(`return await agent("first")`, "compaction-target"),
        undefined,
        {
          resumeJournal: new Map(sourceJournal.map((entry) => [entry.index, entry] as const)),
        },
      );
      const persisted = manager.getPersistence().load(resumed.runId);
      assert.equal(persisted?.legacyResume, true);
      assert.deepEqual(persisted?.calls?.map((row) => [row.index, row.scope]), [[0, resumed.runId]]);
      assert.deepEqual(persisted?.journal?.map((entry) => [entry.index, entry.scope]), [[0, resumed.runId]]);
      assert.equal(persisted?.journal?.[0].kind, "agent");
      assert.equal(persisted?.calls?.[0].outcome, "result");
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

  it("exposes neither manual-journal nor same-ID execution when the permanent write fails", async () => {
    const dirs = tempDirs();
    try {
      const manualStore = failingPersistence(join(dirs.root, "manual"));
      manualStore.failSave(true);
      let manualCalls = 0;
      const manualManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: manualStore.persistence,
        agent: { async run() { manualCalls++; return "live"; } },
      });
      assert.throws(
        () => manualManager.startInBackground(script(`return await agent("x")`), undefined, {
          runId: "manual-target",
          resumeJournal: new Map(),
        }),
        (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR,
      );
      assert.equal(manualCalls, 0);
      const manualLease = manualStore.persistence.acquireRunLease("manual-target");
      assert.ok(manualLease, "failed initial save releases the target lease");
      manualStore.persistence.releaseRunLease(manualLease);

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

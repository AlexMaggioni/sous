import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { JournalEntry, WorkflowCallRecord } from "../src/workflow-result.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createRunPersistence, type PersistedRunState, type RunPersistence } from "../src/runs/persistence/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { CALL_INPUTS_FORMAT } from "../src/workflow.js";
import { CALL_PATH_FORMAT } from "../src/call-path.js";
import { CHECKPOINT_INPUTS_FORMAT } from "../src/checkpoint-call.js";
import { tempDirs } from "./helpers/temp.js";

const script = (body: string, name = "manager-state") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: 'manager state' }\n${body}`;

describe("WorkflowManager PR3 state", () => {
  it("snapshots strict args before execution", async () => {
    const dirs = tempDirs();
    try {
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "unused"; } },
      });
      const syncArgs = { value: 1, nested: { stable: true } };
      const sync = await manager.runSync(script(`args.value = 2\nargs.nested.stable = false\nreturn args.value`), syncArgs);
      assert.equal(sync.status, "completed");
      assert.equal(sync.result, 2);
      assert.deepEqual(syncArgs, { value: 1, nested: { stable: true } });
      assert.deepEqual(manager.getPersistence().load(sync.runId)?.args, syncArgs);

      // A second manager holds its run inside an agent call, so the save of a running run can be read.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { entered(); await gate; return "held"; } },
      });
      const heldArgs = { value: 3 };
      const heldRun = held.runSync(
        script(`args.value = 4\nawait agent('hold', { label: 'hold' })\nreturn args.value`, "held-args"),
        heldArgs,
        { runId: "held-args" },
      );
      await started;
      assert.deepEqual(held.getPersistence().load("held-args")?.args, { value: 3 }, "the save of a running run already has the snapshot");
      release();
      const completed = await heldRun;
      assert.equal(completed.result, 4);
      assert.deepEqual(heldArgs, { value: 3 });
      assert.deepEqual(held.getPersistence().load("held-args")?.args, { value: 3 });

      const noArgs = await manager.runSync(script(`return args === undefined`, "no-args"));
      assert.equal(noArgs.result, true);
    } finally {
      dirs.cleanup();
    }
  });

  it("persists a host-pinned default model and includes it in the agent call identity", async () => {
    const dirs = tempDirs();
    try {
      const seen: Array<string | undefined> = [];
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: {
          async run(_prompt, options) {
            seen.push(options?.model);
            return "ok";
          },
        },
      });
      const result = await manager.runSync(
        script(`return await agent('model-less', { label: 'model-less' })`, "pinned-default"),
        undefined,
        { defaultModel: "codex" },
      );
      assert.equal(result.status, "completed");
      assert.deepEqual(seen, ["codex"]);
      const persisted = manager.getPersistence().load(result.runId);
      assert.equal(persisted?.defaultModel, "codex");
      assert.equal(persisted?.calls?.[0]?.modelRequested, "codex");
    } finally {
      dirs.cleanup();
    }
  });

  it("snapshots args on resume and keeps the persisted pre-execution value", async () => {
    const dirs = tempDirs();
    try {
      const workflow = script(
        `args.count++
const answer = await checkpoint('continue', { })
return { count: args.count, answer }`,
        "resume-args",
      );
      const callerArgs = { count: 0 };
      const first = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "unused"; } },
      });
      const paused = await first.runSync(workflow, callerArgs);
      assert.equal(paused.status, "paused");
      assert.deepEqual(callerArgs, { count: 0 });
      assert.deepEqual(first.getPersistence().load(paused.runId)?.args, { count: 0 });
      assert.ok(paused.checkpointContext);

      const second = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "unused"; } },
      });
      const resumed = await second.resumeInBackground(paused.runId, {
        confirm: async () => "yes",
      });
      assert.equal(resumed.accepted, true);
      if (!resumed.accepted) assert.fail("resume should be accepted");
      const completed = await resumed.promise;
      assert.deepEqual(JSON.parse(JSON.stringify(completed.result)), { count: 1, answer: "yes" });
      assert.deepEqual(second.getPersistence().load(paused.runId)?.args, { count: 0 });
    } finally {
      dirs.cleanup();
    }
  });

  it("executes non-strict args unchanged and persists argsUnreplayable without rejecting", async () => {
    const dirs = tempDirs();
    try {
      class Counter {
        value = 4;
        read() { return this.value; }
      }
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "unused"; } },
      });
      const date = new Date("2020-01-02T00:00:00.000Z");
      const dateRun = await manager.runSync(script(`return args.getUTCFullYear()`, "date-args"), date);
      assert.equal(dateRun.status, "completed");
      assert.equal(dateRun.result, 2020);
      assert.equal(manager.getPersistence().load(dateRun.runId)?.argsUnreplayable, true);

      const custom = new Counter();
      const customRun = await manager.runSync(script(`return args.read()`, "custom-args"), custom);
      assert.equal(customRun.result, 4);
      assert.equal(manager.getPersistence().load(customRun.runId)?.argsUnreplayable, true);
    } finally {
      dirs.cleanup();
    }
  });

  it("persists effective cwd and full runtime identity, and no environment outside git", async () => {
    const dirs = tempDirs();
    try {
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "unused"; } },
      });
      const result = await manager.runSync(script(`return cwd`));
      const persisted = manager.getPersistence().load(result.runId);
      assert.equal(persisted?.effectiveCwd, dirs.cwd);
      const { engineVersion, ...runtime } = persisted?.runtime ?? {};
      assert.match(engineVersion ?? "", /^\d+\.\d+\.\d+(?:-|$)/);
      assert.deepEqual(runtime, {
        node: process.version,
        v8: process.versions.v8,
        pathFormat: CALL_PATH_FORMAT,
        inputsFormat: CALL_INPUTS_FORMAT,
        checkpointInputsFormat: CHECKPOINT_INPUTS_FORMAT,
      });
      assert.equal(persisted?.environment, undefined);
      assert.equal(persisted?.callsAllocated, 0);
      assert.deepEqual(persisted?.limits, {
        maxAgents: 1000,
        concurrency: 8,
        agentRetries: 0,
      });
    } finally {
      dirs.cleanup();
    }
  });

  it("captures git HEAD plus a content-sensitive dirty digest at run creation", async () => {
    const dirs = tempDirs();
    try {
      execFileSync("git", ["-C", dirs.cwd, "init", "-q"]);
      execFileSync("git", ["-C", dirs.cwd, "config", "user.email", "tests@example.com"]);
      execFileSync("git", ["-C", dirs.cwd, "config", "user.name", "Tests"]);
      writeFileSync(join(dirs.cwd, "tracked.txt"), "clean\n");
      execFileSync("git", ["-C", dirs.cwd, "add", "tracked.txt"]);
      execFileSync("git", ["-C", dirs.cwd, "commit", "-qm", "initial"]);

      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "unused"; } },
      });
      const clean = await manager.runSync(script(`return 'clean'`, "git-clean"));
      const cleanIdentity = manager.getPersistence().load(clean.runId)?.environment?.git;
      assert.equal(cleanIdentity?.head, execFileSync("git", ["-C", dirs.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());

      writeFileSync(join(dirs.cwd, "tracked.txt"), "dirty content\n");
      const dirty = await manager.runSync(script(`return 'dirty'`, "git-dirty"));
      const dirtyIdentity = manager.getPersistence().load(dirty.runId)?.environment?.git;
      assert.equal(dirtyIdentity?.head, cleanIdentity?.head);
      assert.notEqual(dirtyIdentity?.dirtyDigest, cleanIdentity?.dirtyDigest);
    } finally {
      dirs.cleanup();
    }
  });

  it("persists floated interruption and drops terminal events that arrive after the save", async () => {
    const dirs = tempDirs();
    try {
      let finish!: (value: string) => void;
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return await new Promise<string>((resolve) => { finish = resolve; }); } },
      });
      let journalEvents = 0;
      let recordEvents = 0;
      let endEvents = 0;
      manager.on("journal", () => journalEvents++);
      manager.on("callRecord", () => recordEvents++);
      manager.on("agentEnd", () => endEvents++);
      const result = await manager.runSync(script(`void agent('late', { label: 'late' })\nreturn 'early'`, "late-drop"));
      assert.equal(result.status, "completed");
      const before = manager.getPersistence().load(result.runId);
      finish("late");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const after = manager.getPersistence().load(result.runId);
      assert.deepEqual(after, before);
      assert.deepEqual({ journalEvents, recordEvents, endEvents }, { journalEvents: 0, recordEvents: 1, endEvents: 1 });
    } finally {
      dirs.cleanup();
    }
  });

  it("persists abortSignaled when a script catches the stop and completes", async () => {
    const dirs = tempDirs();
    try {
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => { started = resolve; });
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: {
          async run(_prompt, options) {
            started();
            return await new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(new WorkflowError("aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true })),
                { once: true },
              );
            });
          },
        },
      });
      const runId = "caught-stop";
      const pending = manager.runSync(
        script(`try { await agent('wait') } catch {}\nreturn 'caught'`, "caught-abort"),
        undefined,
        { runId },
      );
      await didStart;
      assert.equal(manager.stop(runId), true);
      const result = await pending;
      assert.equal(result.status, "completed");
      assert.equal(result.abortSignaled, true);
      assert.equal(manager.getPersistence().load(result.runId)?.abortSignaled, true);
    } finally {
      dirs.cleanup();
    }
  });

  it("a stopped run's result says its signal was aborted, as its saved state does", async () => {
    const dirs = tempDirs();
    try {
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => { started = resolve; });
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: {
          async run(_prompt, options) {
            started();
            return await new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(new WorkflowError("aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true })),
                { once: true },
              );
            });
          },
        },
      });
      const runId = "stopped-by-stop";
      const pending = manager.runSync(script(`return await agent('wait')`, "stopped-abort"), undefined, { runId });
      await didStart;
      assert.equal(manager.stop(runId), true);
      const result = await pending;
      assert.equal(result.status, "aborted");
      assert.equal(manager.getPersistence().load(runId)?.abortSignaled, true);
      assert.equal(result.abortSignaled, true);
    } finally {
      dirs.cleanup();
    }
  });

  it("runSync returns the result its paused or failed run kept and saved", async () => {
    const dirs = tempDirs();
    try {
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        defaultAgentRetries: 0,
        agent: { async run() { throw new Error("the disk is full"); } },
      });
      const paused = await manager.runSync(script(`return await agent('write', { label: 'write' })`, "paused-result"));
      const failed = await manager.runSync(script(`throw new Error('broken')`, "failed-result"));
      for (const [result, status] of [[paused, "paused"], [failed, "failed"]] as const) {
        assert.equal(result.status, status);
        assert.equal(result, manager.getRun(result.runId)?.result, `the ${status} run keeps the result runSync returns`);
        assert.equal(result.durationMs, manager.getPersistence().load(result.runId)?.durationMs, `the ${status} run saved the same duration`);
      }
    } finally {
      dirs.cleanup();
    }
  });

  it("guards caller run ids lease-first, including a second manager before the first save", async () => {
    const states = new Map<string, PersistedRunState>();
    const held = new Set<string>();
    let onFirstLoad: (() => void) | undefined;
    const persistence: RunPersistence = {
      save(state) { states.set(state.runId, structuredClone(state)); },
      load(runId) {
        const callback = onFirstLoad;
        onFirstLoad = undefined;
        callback?.();
        return states.get(runId) ?? null;
      },
      list() { return [...states.values()]; },
      delete(runId) { return states.delete(runId); },
      acquireRunLease(runId) {
        if (held.has(runId)) return null;
        held.add(runId);
        return { runId, token: runId };
      },
      releaseRunLease(lease) { held.delete(lease.runId); },
      validateRunLease() { return true; },
    };
    let finish!: (value: string) => void;
    const runner = { async run() { return await new Promise<string>((resolve) => { finish = resolve; }); } };
    const first = new WorkflowManager({ persistence, agent: runner });
    const second = new WorkflowManager({ persistence, agent: runner });
    let collision: unknown;
    onFirstLoad = () => {
      try {
        second.startInBackground(script(`return await agent('x')`), undefined, { runId: "shared-id" });
      } catch (error) {
        collision = error;
      }
    };
    const started = first.startInBackground(script(`return await agent('x')`), undefined, { runId: "shared-id" });
    assert.ok(collision instanceof WorkflowError);
    assert.equal(collision.code, WorkflowErrorCode.PERSISTENCE_ERROR);
    assert.match(collision.message, /run id already exists: shared-id/);
    // Background execution begins on the next macrotask; the agent is dispatched shortly after.
    while (finish === undefined) await new Promise((resolve) => setImmediate(resolve));
    finish("done");
    assert.equal((await started.promise).status, "completed");
  });

  it("persists nested calls under their own scope", async () => {
    const dirs = tempDirs();
    try {
      const persistence = createRunPersistence(dirs.cwd, undefined, { persistenceRoot: dirs.root });
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistenceRoot: dirs.root,
        agent: { async run() { return "ok"; } },
      });
      const child = script(`return await agent('child', { label: 'child' })`, "child");
      const root = await manager.runSync(
        script(`await workflow(${JSON.stringify(child)})\nreturn await agent('root', { label: 'root' })`, "root"),
      );
      const persisted = persistence.load(root.runId);
      assert.deepEqual(persisted?.journal?.map((entry: JournalEntry) => entry.scope), [root.runId]);
      assert.deepEqual(persisted?.calls?.map((row: WorkflowCallRecord) => row.scope), [root.runId, `${root.runId}-nested1`]);
      assert.equal(persisted?.nestedWorkflows, true);
      assert.deepEqual(
        persisted?.agents.map((agent) => ({ scope: agent.scope, callIndex: agent.callIndex, status: agent.status })),
        [
          { scope: `${root.runId}-nested1`, callIndex: 0, status: "done" },
          { scope: root.runId, callIndex: 0, status: "done" },
        ],
      );
    } finally {
      dirs.cleanup();
    }
  });
});

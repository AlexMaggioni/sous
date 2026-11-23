import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { WorkflowReplayProvenanceField } from "../src/workflow-result.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunLease, RunPersistence } from "../src/runs/persistence/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { tempDirs } from "./helpers/temp.js";

const workflow = (body: string, name = "incremental-manager") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "manager resume" }\n${body}`;

interface MemoryStore {
  persistence: RunPersistence;
  states: Map<string, PersistedRunState>;
  history: PersistedRunState[];
  leases: Set<string>;
  failSaveWhen: (predicate: ((state: PersistedRunState) => boolean) | undefined) => void;
}

function memoryStore(root: string): MemoryStore {
  mkdirSync(root, { recursive: true });
  const states = new Map<string, PersistedRunState>();
  const history: PersistedRunState[] = [];
  const leases = new Set<string>();
  let failure: ((state: PersistedRunState) => boolean) | undefined;
  const persistence: RunPersistence = {
    save(state) {
      if (failure?.(state)) throw new Error("injected save failure");
      const snapshot = JSON.parse(JSON.stringify(state)) as PersistedRunState;
      states.set(state.runId, snapshot);
      history.push(snapshot);
    },
    load(runId) {
      const state = states.get(runId);
      return state ? structuredClone(state) : null;
    },
    list() {
      return [...states.values()].map((state) => structuredClone(state));
    },
    delete(runId) {
      return states.delete(runId);
    },
    acquireRunLease(runId) {
      if (leases.has(runId)) return null;
      leases.add(runId);
      return { runId, token: runId };
    },
    releaseRunLease(lease: RunLease) {
      leases.delete(lease.runId);
    },
    validateRunLease() {
      return true;
    },
  };
  return {
    persistence,
    states,
    history,
    leases,
    failSaveWhen(predicate) {
      failure = predicate;
    },
  };
}

function safeCalls(items: readonly string[], name = "safe-calls"): string {
  return workflow(`
const items = ${JSON.stringify(items)}
return await parallel(items.map((item) => () => agent(item, {
  label: item,
})))`, name);
}

async function recordSafeSource(
  manager: WorkflowManager,
  items: readonly string[],
): Promise<string> {
  const result = await manager.runSync(safeCalls(items));
  assert.equal(result.status, "completed");
  return result.runId;
}

const DRIFT_CHECKPOINT_SCRIPT = workflow(`
const first = await agent("prefix-one", {
  label: "prefix-one",
})
const second = await agent("prefix-two", {
  label: "prefix-two",
})
const approval = await checkpoint("approve", { })
const after = await agent("after-checkpoint", {
  label: "after-checkpoint",
})
return { first, second, approval, after }`, "drift-checkpoint");

async function assertDriftedCheckpointResume(
  targetRunId: string,
  mutateSource: (manager: WorkflowManager, sourceRunId: string, cwd: string) => void,
  expectedField: WorkflowReplayProvenanceField,
): Promise<void> {
  const dirs = tempDirs("incremental-manager-provenance");
  execFileSync("git", ["-C", dirs.cwd, "init", "-q"]);
  execFileSync("git", ["-C", dirs.cwd, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", dirs.cwd, "config", "user.name", "Tests"]);
  writeFileSync(join(dirs.cwd, "tracked.txt"), "clean\n");
  execFileSync("git", ["-C", dirs.cwd, "add", "tracked.txt"]);
  execFileSync("git", ["-C", dirs.cwd, "commit", "-qm", "initial"]);
  const livePrompts: string[] = [];
  const manager = new WorkflowManager({
    cwd: dirs.cwd,
    persistenceRoot: dirs.root,
    agent: {
      async run(prompt) {
        livePrompts.push(prompt);
        return `live:${prompt}`;
      },
    },
  });
  try {
    const paused = await manager.runSync(DRIFT_CHECKPOINT_SCRIPT);
    assert.equal(paused.status, "paused");
    assert.ok(paused.checkpointContext);
    assert.deepEqual(livePrompts, ["prefix-one", "prefix-two"]);

    // A new run reuses only a run that has ended, so the paused source is stopped first.
    assert.equal(manager.stop(paused.runId), true);
    assert.equal(manager.getPersistence().load(paused.runId)?.status, "aborted");
    mutateSource(manager, paused.runId, dirs.cwd);
    livePrompts.length = 0;
    const started = manager.startInBackground(DRIFT_CHECKPOINT_SCRIPT, undefined, {
      runId: targetRunId,
      resumeFromRunId: paused.runId,
      confirm: async () => true,
    });
    const admittedChange = manager.getRun(targetRunId)?.resumeReporting?.eligibility().provenanceChanges
      ?.find((change) => change.field === expectedField);
    assert.ok(admittedChange, `${expectedField} is reported at admission`);
    assert.notEqual(admittedChange.source, admittedChange.current);

    const resumed = await started.promise;
    assert.equal(resumed.status, "completed", JSON.stringify(resumed.resumeReport));
    assert.equal(resumed.resumeReport?.strategy, "occurrence-v1");
    assert.equal(resumed.resumeReport?.replayed, 2);
    assert.equal(resumed.resumeReport?.live, 2);
    assert.equal(resumed.replayEligibility?.replayedPrefix, 2);
    assert.ok(resumed.replayEligibility?.provenanceChanges
      ?.some((change) => change.field === expectedField));
    assert.deepEqual(livePrompts, ["after-checkpoint"], "the journaled agent prefix makes zero live calls");
    assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), {
      first: "live:prefix-one",
      second: "live:prefix-two",
      approval: true,
      after: "live:after-checkpoint",
    });
  } finally {
    dirs.cleanup();
  }
}

describe("WorkflowManager resumeFromRunId admission", () => {
  it("replays a checkpointed prefix after tracked-file drift and reports the dirty digest", async () => {
    await assertDriftedCheckpointResume(
      "dirty-digest-target",
      (_manager, _sourceRunId, cwd) => writeFileSync(join(cwd, "tracked.txt"), "edited\n"),
      "environment.git.dirtyDigest",
    );
  });

  it("holds the source lease through the critical target save and releases it before acknowledgement", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        agent: { async run(prompt) { return `recorded:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(manager, ["one", "two"]);
      const held = store.persistence.acquireRunLease(sourceRunId);
      assert.ok(held);
      assert.throws(
        () => manager.startInBackground(safeCalls(["one", "two"]), undefined, { resumeFromRunId: sourceRunId }),
        (error: unknown) =>
          error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR,
      );
      assert.equal(store.states.size, 1, "contention creates no target run");
      store.persistence.releaseRunLease(held);

      let observedCriticalSave = false;
      store.failSaveWhen((state) => {
        if (state.runId === "durable-target" && !observedCriticalSave) {
          observedCriticalSave = true;
          assert.equal(store.leases.has(sourceRunId), true, "source lease covers target seed save");
        }
        return false;
      });
      const started = manager.startInBackground(safeCalls(["one", "two"]), undefined, {
        runId: "durable-target",
        resumeFromRunId: sourceRunId,
      });
      assert.equal(store.leases.has(sourceRunId), false, "source lease is released before return");
      assert.equal(store.leases.has("durable-target"), true, "target writer keeps its own lease");
      assert.equal(observedCriticalSave, true);
      const firstTargetSave = store.history.find((state) => state.runId === "durable-target");
      assert.equal(firstTargetSave?.resumeReport?.strategy, "occurrence-v1", JSON.stringify(firstTargetSave?.resumeReport));
      assert.equal(firstTargetSave?.resumeSeed?.candidates.length, 2);
      assert.deepEqual(firstTargetSave?.resumeReport, {
        strategy: "occurrence-v1",
        sourceRunId,
        requestedPolicy: "auto",
        replayed: 0,
        live: 0,
        failed: 0,
        calls: [],
      });
      const result = await started.promise;
      assert.equal(result.resumeReport?.replayed, 2);
      assert.equal(store.persistence.load("durable-target")?.resumeSeed, undefined);
    } finally {
      dirs.cleanup();
    }
  });

  it("persists an immutable immediate ancestry pointer without changing matcher seed lifecycle", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        agent: { async run(prompt) { return `recorded:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(manager, ["one", "two"]);
      const started = manager.startInBackground(safeCalls(["one", "two"]), undefined, {
        runId: "ancestry-target",
        resumeFromRunId: sourceRunId,
      });

      const admitted = store.history.find((state) => state.runId === "ancestry-target");
      assert.equal(admitted?.resumeSourceRunId, sourceRunId);
      assert.equal(admitted?.resumeSeed?.sourceRunId, sourceRunId);
      assert.equal(admitted?.resumeSeed?.candidates.length, 2);

      const completed = await started.promise;
      assert.equal(completed.status, "completed");
      const terminal = store.persistence.load("ancestry-target");
      assert.equal(terminal?.resumeSourceRunId, sourceRunId);
      assert.equal(terminal?.resumeSeed, undefined, "completion keeps the upstream matcher compaction contract");
      assert.ok(
        store.history
          .filter((state) => state.runId === "ancestry-target")
          .every((state) => state.resumeSourceRunId === sourceRunId),
        "the engine pointer must never change after admission",
      );
    } finally {
      dirs.cleanup();
    }
  });

  it("carries the ancestry pointer through legacy same-ID resume", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        agent: { async run(prompt) { return `source:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(manager, ["one"]);
      const paused = await manager.runSync(workflow(`
await agent("one", { label: "one" })
return await checkpoint("approve", { })`, "legacy-ancestry"), undefined, {
        runId: "legacy-ancestry",
        resumeFromRunId: sourceRunId,
      });
      assert.equal(paused.status, "paused");
      assert.ok(paused.checkpointContext);
      assert.equal(store.persistence.load("legacy-ancestry")?.resumeSourceRunId, sourceRunId);

      const resumed = await manager.resumeInBackground("legacy-ancestry", {
        confirm: async () => true,
      });
      if (!resumed.accepted) assert.fail("legacy resume was not accepted");
      const final = await resumed.promise;
      assert.equal(final.status, "completed");
      assert.equal(store.persistence.load("legacy-ancestry")?.resumeSourceRunId, sourceRunId);
      assert.ok(
        store.history
          .filter((state) => state.runId === "legacy-ancestry")
          .every((state) => state.resumeSourceRunId === sourceRunId),
        "every save across legacy resume retains the engine ancestry pointer",
      );
    } finally {
      dirs.cleanup();
    }
  });
});

describe("WorkflowManager durable identity execution", () => {
  it("replays 38 of 40 moved public calls, persists decisions, and compacts completion", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const sourceItems = Array.from({ length: 40 }, (_, index) => `item-${index}`);
      const sourceManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        agent: { async run(prompt) { return `source:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(sourceManager, sourceItems);
      const livePrompts: string[] = [];
      const targetItems = [...sourceItems.slice(7), ...sourceItems.slice(0, 7)];
      targetItems[5] = "changed-a";
      targetItems[31] = "changed-b";
      const targetManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        agent: { async run(prompt) { livePrompts.push(prompt); return `live:${prompt}`; } },
      });
      const result = await targetManager.runSync(safeCalls(targetItems), undefined, {
        runId: "fanout-target",
        resumeFromRunId: sourceRunId,
      });
      assert.equal(result.status, "completed");
      assert.deepEqual(livePrompts.sort(), ["changed-a", "changed-b"]);
      assert.equal(result.resumeReport?.strategy, "occurrence-v1");
      assert.equal(result.resumeReport?.replayed, 38);
      assert.equal(result.resumeReport?.live, 2);
      assert.equal(result.resumeReport?.failed, 0);
      assert.deepEqual(result.resumeReport?.calls.map((decision) => decision.index), sourceItems.map((_, index) => index));
      assert.equal(result.resumeReport?.calls.filter((decision) =>
        decision.action === "replayed" && decision.recordedIndex !== decision.index).length, 38);

      const persisted = store.persistence.load("fanout-target");
      assert.equal(persisted?.resumeSeed, undefined);
      assert.deepEqual(persisted?.resumeReport, result.resumeReport);
      assert.equal(persisted?.journal?.length, 40);
      assert.equal(persisted?.calls?.length, 40);
      assert.ok(persisted?.journal?.every((entry) => entry.scope === "fanout-target"));
      assert.ok(persisted?.calls?.every((call) => call.scope === "fanout-target"));
      const outward = JSON.stringify(result.resumeReport);
      for (const secret of [dirs.cwd, "source:item-0", "changed-a", "sessionId", "inputsHash"]) {
        assert.equal(outward.includes(secret), false);
      }
    } finally {
      dirs.cleanup();
    }
  });

  it("retains and flattens the reduced seed after a failed execution", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        agent: { async run(prompt) { return `source:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(manager, ["one", "two"]);
      const failed = await manager.runSync(workflow(`
await agent("one", { label: "one" })
throw new Error("stop after one")`, "failed-hop"), undefined, {
        runId: "failed-hop",
        resumeFromRunId: sourceRunId,
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.resumeReport?.replayed, 1);
      const failedState = store.persistence.load("failed-hop");
      assert.equal(failedState?.resumeSeed?.sourceRunId, "failed-hop");
      assert.equal(failedState?.resumeSeed?.candidates.length, 1);
      assert.equal(failedState?.resumeSeed?.candidates[0]?.sourceRunId, sourceRunId);

      const resumed = await manager.runSync(safeCalls(["one", "two"], "after-failure"), undefined, {
        runId: "after-failure",
        resumeFromRunId: "failed-hop",
      });
      assert.equal(resumed.status, "completed");
      assert.equal(resumed.resumeReport?.replayed, 2);
      const second = resumed.resumeReport?.calls[1];
      assert.equal(second?.action, "replayed");
      if (second?.action === "replayed") assert.equal(second.sourceRunId, sourceRunId);
    } finally {
      dirs.cleanup();
    }
  });

  it("replays both a completed live call and an inherited suffix after failure", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        agent: { async run(prompt) { return `live:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(manager, ["one", "two"]);
      const failed = await manager.runSync(workflow(`
await agent("changed", { label: "changed" })
throw new Error("stop after unsafe work")`, "unsafe-barrier"), undefined, {
        runId: "unsafe-barrier",
        resumeFromRunId: sourceRunId,
      });
      assert.equal(failed.status, "failed");
      assert.equal(store.persistence.load("unsafe-barrier")?.resumeSeed?.candidates.length, 2);

      const live: string[] = [];
      const resumed = await new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        agent: { async run(prompt) { live.push(prompt); return `next:${prompt}`; } },
      }).runSync(workflow(`
await agent("changed", { label: "changed" })
return await agent("two", { label: "two" })`, "after-unsafe"), undefined, {
        runId: "after-unsafe",
        resumeFromRunId: "unsafe-barrier",
      });
      assert.deepEqual(live, []);
      assert.equal(resumed.resumeReport?.replayed, 2);
      assert.equal(resumed.resumeReport?.live, 0);
    } finally {
      dirs.cleanup();
    }
  });

  it("turns an initial save failure into a fail-closed persistence error", async () => {
    const dirs = tempDirs();
    try {
      const store = memoryStore(dirs.root);
      const sourceManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        agent: { async run(prompt) { return `source:${prompt}`; } },
      });
      const sourceRunId = await recordSafeSource(sourceManager, ["one", "two"]);

      store.failSaveWhen((state) => state.runId === "initial-failure");
      const initialManager = new WorkflowManager({
        cwd: dirs.cwd,
        persistence: store.persistence,
        agent: { async run() { assert.fail("initial failure must not execute"); } },
      });
      assert.throws(
        () => initialManager.startInBackground(safeCalls(["one", "two"]), undefined, {
          runId: "initial-failure",
          resumeFromRunId: sourceRunId,
        }),
        (error: unknown) =>
          error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR,
      );
      assert.equal(store.leases.has(sourceRunId), false);
      assert.equal(store.leases.has("initial-failure"), false);
      assert.equal(store.states.has("initial-failure"), false);
    } finally {
      dirs.cleanup();
    }
  });
});

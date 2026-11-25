import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../../src/errors.js";
import { createRun } from "../../src/runs/launch.js";
import { updateRecord } from "../../src/runs/records.js";
import { runDetail } from "../../src/runs/run.js";
import { engineRunFiles, managerStore, readState } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import type { PlannedRequest, StepRequest } from "../../src/steps/agent-run.js";
import type { AgentRunner } from "../../src/steps/agent-runner.js";
import { PERSON } from "../../src/testing.js";
import { WorkflowManager } from "../../src/workflow-manager.js";
import { deferred } from "../helpers/async.js";
import { deadPid, quiet, setup } from "./fixture.js";

const SCRIPT = `export const meta = { name: 'live', description: 'Live session identity' }
return await agent('work', { label: 'work', keepSession: true })`;

function session(id: string, cwd: string) {
  return { sessionId: id, backendId: "claude", cwd,
    reopen: { load: true, resume: true, list: true } };
}

describe("the session of a running agent call", () => {
  it("shows the actual session before completion, hides ownership, and keeps terminal history", async () => {
    const { paths, projectDir } = setup({ live: SCRIPT });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const opened = deferred();
    const release = deferred();
    const worker = runWorker(record.runId, "start", { paths, log: quiet, inner: {
      async run(_prompt, request) {
        request.onSessionOpen?.(session("live-session", projectDir));
        opened.resolve();
        await release.promise;
        return "done";
      },
    } });
    try {
      await opened.promise;
      const saved = readState(paths, record.runId)!;
      const ownership = saved.activeAgentSessions!;
      assert.ok(ownership.leaseToken);
      const detail = runDetail(paths, record.runId);
      assert.equal(detail.steps[0]?.status, "running");
      assert.equal(detail.steps[0]?.session?.sessionId, "live-session");
      assert.equal(detail.engineState?.agents[0]?.session?.sessionId, "live-session");
      assert.equal("activeAgentSessions" in (detail.engineState ?? {}), false);
      assert.equal(JSON.stringify(detail).includes(ownership.leaseToken), false);
      for (const privateKey of ["activeAgentSessions", "leaseToken", "attempt"]) {
        assert.equal(JSON.stringify(detail).includes(`"${privateKey}"`), false);
      }
      assert.equal("pid" in detail.steps[0]!.session!, false);
      const events = readFileSync(engineRunFiles(paths, record.runId).events, "utf8");
      assert.equal(events.includes("live-session"), false, "session stays out of the event log");
      assert.equal(events.includes(ownership.leaseToken), false);
      assert.equal(events.includes("activeAgentSessions"), false);
    } finally { release.resolve(); await worker; }
    const ended = runDetail(paths, record.runId);
    assert.equal(ended.steps[0]?.status, "done");
    assert.equal(ended.steps[0]?.session?.sessionId, "live-session");
    assert.equal(readState(paths, record.runId)?.activeAgentSessions, undefined);
  });

  it("publishes a continuation only after its current backend resolves the reopened session", async () => {
    const script = `export const meta = { name: 'live', description: 'continued session' }
await agent('first', { label: 'first', keepSession: true })
return await agent('next', { label: 'next', continue: 'first' })`;
    const { paths, projectDir } = setup({ live: script });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const opened = deferred();
    const release = deferred();
    let previous: PlannedRequest | undefined;
    const worker = runWorker(record.runId, "start", { paths, log: quiet, inner: {
      async run(_prompt, request) {
        if (!previous) {
          previous = request;
          request.onSessionOpen?.(session("historical-candidate", projectDir));
          return "first";
        }
        assert.equal(request.continueFromSession?.sessionId, "historical-candidate");
        const current = () => runDetail(paths, record.runId).steps.find(step =>
          step.label === "next");
        assert.equal(current()?.status, "running");
        assert.equal(current()?.session, undefined);
        previous.onSessionOpen?.(session("old-callback", projectDir));
        assert.equal(current()?.session, undefined);
        request.onSessionOpen?.(session("resolved-current-session", projectDir));
        opened.resolve();
        await release.promise;
        return "next";
      },
    } });
    try {
      await opened.promise;
      const steps = runDetail(paths, record.runId).steps;
      assert.equal(steps.find(step => step.label === "first")?.session?.sessionId,
        "historical-candidate");
      assert.equal(steps.find(step => step.label === "next")?.session?.sessionId,
        "resolved-current-session");
    } finally { release.resolve(); await worker; }
  });

  it("rejects private bindings from another lease, owner, or ended call", async () => {
    const { paths, projectDir } = setup({ live: SCRIPT });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const opened = deferred();
    const release = deferred();
    const worker = runWorker(record.runId, "start", { paths, log: quiet, inner: {
      async run(_prompt, request) {
        request.onSessionOpen?.(session("private-session", projectDir));
        opened.resolve(); await release.promise; return "done";
      },
    } });
    try {
      await opened.promise;
      const file = engineRunFiles(paths, record.runId).state;
      const original = readState(paths, record.runId)!;
      const save = (value: typeof original) => writeFileSync(file, JSON.stringify(value));
      for (const reason of ["lease", "owner", "dead", "call", "scope", "closed", "historical"] as const) {
        const changed = structuredClone(original);
        if (reason === "lease") changed.activeAgentSessions!.leaseToken = "other-lease";
        if (reason === "owner") changed.activeAgentSessions!.pid = deadPid();
        if (reason === "dead") updateRecord(paths, record.runId, { pid: deadPid() });
        if (reason === "call") changed.activeAgentSessions!.entries[0]!.session.callIndex++;
        if (reason === "scope") changed.activeAgentSessions!.entries[0]!.scope = "other-scope";
        if (reason === "closed") changed.agents[0]!.status = "done";
        if (reason === "historical") {
          changed.agents[0]!.session = changed.activeAgentSessions!.entries[0]!.session;
          delete changed.activeAgentSessions;
        }
        save(changed);
        assert.equal(runDetail(paths, record.runId).steps[0]?.session, undefined, reason);
        updateRecord(paths, record.runId, { pid: process.pid });
      }
      save(original);
      assert.equal(runDetail(paths, record.runId).steps[0]?.session?.sessionId,
        "private-session");
      writeFileSync(file, "{broken-primary");
      assert.ok(readState(paths, record.runId)?.activeAgentSessions,
        "ordinary reads still recover the valid backup");
      assert.equal(runDetail(paths, record.runId).steps[0]?.session, undefined,
        "an older backup is not proof of a live session");
      save(original);
    } finally { release.resolve(); await worker; }
  });

  it("clears a failed attempt before the next runner starts and ignores its late callbacks", async () => {
    const script = SCRIPT.replace("keepSession: true", "keepSession: true, retries: 1");
    const { paths, projectDir } = setup({ live: script });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const second = deferred();
    const release = deferred();
    let attempts = 0;
    let firstRequest: StepRequest | undefined;
    const runner: AgentRunner = { async run(_prompt, request) {
      attempts++;
      if (attempts === 1) {
        firstRequest = request;
        request.onSessionOpen?.(session("failed-session", projectDir));
        throw new WorkflowError("retry", WorkflowErrorCode.AGENT_EXECUTION_ERROR,
          { recoverable: true });
      }
      assert.equal(runDetail(paths, record.runId).steps[0]?.session, undefined);
      assert.ok(firstRequest);
      firstRequest.onSessionOpen?.(session("late-session", projectDir));
      assert.equal(runDetail(paths, record.runId).steps[0]?.session, undefined);
      request.onSessionOpen?.(session("second-session", projectDir));
      second.resolve(); await release.promise; return "done";
    } };
    updateRecord(paths, record.runId, { pid: process.pid });
    const manager = new WorkflowManager({ ...managerStore(paths), agent: runner });
    const work = manager.runSync(script, {}, { runId: record.runId, cwd: projectDir });
    try {
      await second.promise;
      assert.equal(runDetail(paths, record.runId).steps[0]?.session?.sessionId,
        "second-session");
    } finally { release.resolve(); await work; }
  });

  it("fails closed before a runner starts when its binding invalidation cannot be saved", async () => {
    const { paths, projectDir } = setup({ live: SCRIPT });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const store = managerStore(paths);
    let calls = 0;
    const persistence = { ...store.persistence, save(state: Parameters<typeof store.persistence.save>[0]) {
      if (state.activeAgentSessions) throw new Error("session save refused");
      store.persistence.save(state);
    } };
    const manager = new WorkflowManager({ ...store, persistence,
      agent: { async run() { calls++; return "must not start"; } } });
    const result = await manager.runSync(SCRIPT, {}, { runId: record.runId, cwd: projectDir });
    assert.equal(calls, 0);
    assert.notEqual(result.status, "completed");
    assert.equal(runDetail(paths, record.runId).steps.some(step => step.session), false);
  });

  it("clears a failed execution and refuses a resumed runner if invalidation cannot be saved", async () => {
    const { paths, projectDir } = setup({ live: SCRIPT });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const store = managerStore(paths);
    const first = new WorkflowManager({ ...store, agent: {
      async run(_prompt, request) {
        request.onSessionOpen?.(session("failed-execution", projectDir));
        throw new WorkflowError("needs repair", WorkflowErrorCode.AGENT_EXECUTION_ERROR,
          { recoverable: false });
      },
    } });
    const paused = await first.runSync(SCRIPT, {}, { runId: record.runId, cwd: projectDir });
    assert.equal(paused.status, "paused");
    assert.equal(readState(paths, record.runId)?.activeAgentSessions, undefined);
    assert.equal(runDetail(paths, record.runId).steps[0]?.session?.sessionId,
      "failed-execution", "the ended failure keeps its history");
    let calls = 0;
    const persistence = { ...store.persistence, save(state: Parameters<typeof store.persistence.save>[0]) {
      if (state.activeAgentSessions) throw new Error("resume invalidation refused");
      store.persistence.save(state);
    } };
    const resumed = new WorkflowManager({ ...store, persistence, agent: {
      async run() { calls++; return "must not start"; },
    } });
    const continuation = await resumed.resumeInBackground(record.runId);
    assert.equal(continuation.accepted, true);
    await continuation.promise;
    assert.equal(calls, 0);
    assert.equal(runDetail(paths, record.runId).steps.filter(step =>
      step.status === "running").some(step => step.session), false);
  });

  it("does not start a retry when its durable invalidation fails", async () => {
    const script = SCRIPT.replace("keepSession: true", "keepSession: true, retries: 1");
    const { paths, projectDir } = setup({ live: script });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const store = managerStore(paths);
    let starts = 0;
    let calls = 0;
    const persistence = { ...store.persistence, save(state: Parameters<typeof store.persistence.save>[0]) {
      if (state.activeAgentSessions?.entries.length === 0 && ++starts === 2) {
        throw new Error("retry invalidation refused");
      }
      store.persistence.save(state);
    } };
    const manager = new WorkflowManager({ ...store, persistence, agent: {
      async run(_prompt, request) {
        calls++;
        request.onSessionOpen?.(session("first-attempt", projectDir));
        throw new WorkflowError("retry", WorkflowErrorCode.AGENT_EXECUTION_ERROR,
          { recoverable: true });
      },
    } });
    const result = await manager.runSync(script, {}, { runId: record.runId, cwd: projectDir });
    assert.equal(starts, 2);
    assert.equal(calls, 1);
    assert.notEqual(result.status, "completed");
    assert.equal(runDetail(paths, record.runId).steps.some(step => step.session), false);
  });

  it("revokes ownership even if a backend swallows a session callback failure", async () => {
    const { paths, projectDir } = setup({ live: SCRIPT });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const store = managerStore(paths);
    const swallowed = deferred();
    const release = deferred();
    let refuse = false;
    const persistence = { ...store.persistence, save(state: Parameters<typeof store.persistence.save>[0]) {
      if (refuse) throw new Error("replacement invalidation refused");
      store.persistence.save(state);
    } };
    updateRecord(paths, record.runId, { pid: process.pid });
    const manager = new WorkflowManager({ ...store, persistence, agent: {
      async run(_prompt, request) {
        request.onSessionOpen?.(session("previously-visible", projectDir));
        assert.equal(runDetail(paths, record.runId).steps[0]?.session?.sessionId,
          "previously-visible");
        refuse = true;
        assert.throws(() => request.onSessionOpen?.(session("replacement", projectDir)));
        assert.equal(request.signal?.aborted, true);
        swallowed.resolve();
        await release.promise;
        return "ignored callback failure";
      },
    } });
    const work = manager.runSync(SCRIPT, {}, { runId: record.runId, cwd: projectDir });
    try {
      await swallowed.promise;
      assert.equal(runDetail(paths, record.runId).steps[0]?.session, undefined);
    } finally { refuse = false; release.resolve(); await work; }
  });

  it("keeps parallel nested scopes apart", async () => {
    const parent = `export const meta = { name: 'parent', description: 'parallel sessions' }
return await parallel([() => workflow('child'), () => workflow('child')])`;
    const child = SCRIPT.replace("name: 'live'", "name: 'child'");
    const { paths, projectDir } = setup({ parent, child });
    const record = createRun(paths, { who: PERSON, workflow: "parent", projectDir, inputs: {} });
    const opened = deferred();
    const release = deferred();
    let count = 0;
    const worker = runWorker(record.runId, "start", { paths, log: quiet, inner: {
      async run(_prompt, request) {
        request.onSessionOpen?.(session(`session-${request.runId}`, projectDir));
        if (++count === 2) opened.resolve();
        await release.promise; return "done";
      },
    } });
    try {
      await opened.promise;
      const steps = runDetail(paths, record.runId).steps.filter(step => step.status === "running");
      assert.equal(steps.length, 2);
      assert.equal(new Set(steps.map(step => step.callIndex)).size, 1);
      assert.equal(new Set(steps.map(step => step.scope)).size, 2);
      for (const step of steps) assert.equal(step.session?.sessionId, `session-${step.scope}`);
    } finally { release.resolve(); await worker; }
    assert.equal(readState(paths, record.runId)?.activeAgentSessions, undefined);
  });

  it("invalidates an aborted call before late backend callbacks can publish again", async () => {
    const { paths, projectDir } = setup({ live: SCRIPT });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const opened = deferred();
    const release = deferred();
    let captured: StepRequest | undefined;
    updateRecord(paths, record.runId, { pid: process.pid });
    const manager = new WorkflowManager({ ...managerStore(paths), agent: {
      async run(_prompt, request) {
        captured = request;
        request.onSessionOpen?.(session("aborted-session", projectDir));
        opened.resolve(); await release.promise; return "late";
      },
    } });
    const work = manager.runSync(SCRIPT, {}, { runId: record.runId, cwd: projectDir });
    try {
      await opened.promise;
      manager.stop(record.runId);
      const result = await work;
      assert.equal(result.status, "aborted");
      captured?.onSessionOpen?.(session("too-late", projectDir));
      assert.equal(readState(paths, record.runId)?.activeAgentSessions, undefined);
      assert.deepEqual(runDetail(paths, record.runId).running, []);
      assert.equal(runDetail(paths, record.runId).steps.some(step =>
        step.session?.sessionId === "too-late"), false);
    } finally { release.resolve(); await work; }
  });
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createRun } from "../../src/runs/launch.js";
import { updateRecord } from "../../src/runs/records.js";
import { runDetail } from "../../src/runs/run.js";
import { engineRunFiles, readState } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import type { PlannedRequest } from "../../src/steps/agent-run.js";
import { PERSON } from "../../src/testing.js";
import { deferred } from "../helpers/async.js";
import { deadPid, quiet, setup } from "./fixture.js";

const HOST = { onLeaseRevocationFailure(error: Error): never { throw error; } };

const SCRIPT = `export const meta = { name: 'live', description: 'Live session identity' }
return await agent('work', { label: 'work', keepSession: true })`;

function session(id: string, cwd: string) {
  return { sessionId: id, backendId: "claude", cwd,
    reopen: { load: true, resume: true, list: true } };
}

describe("the session of a running agent call", () => {
  it("publishes no live proof without an explicit host fail-stop policy", async () => {
    const { paths, projectDir } = setup({ live: SCRIPT });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const opened = deferred();
    const release = deferred();
    const worker = runWorker(record.runId, "start", { paths, log: quiet, inner: {
      async run(_prompt, request) {
        request.onSessionOpen?.(session("unfenced-library-session", projectDir));
        opened.resolve(); await release.promise; return "done";
      },
    } });
    try {
      await opened.promise;
      assert.equal(readState(paths, record.runId)?.activeAgentSessions, undefined);
      assert.equal(runDetail(paths, record.runId).steps[0]?.session, undefined);
    } finally { release.resolve(); await worker; }
    assert.equal(runDetail(paths, record.runId).steps[0]?.session?.sessionId,
      "unfenced-library-session", "terminal history remains available to embedded callers");
  });

  it("shows the actual session before completion, hides ownership, and keeps terminal history", async () => {
    const { paths, projectDir } = setup({ live: SCRIPT });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const opened = deferred();
    const release = deferred();
    const worker = runWorker(record.runId, "start", { ...HOST, paths, log: quiet, inner: {
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
    const worker = runWorker(record.runId, "start", { ...HOST, paths, log: quiet, inner: {
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
    const worker = runWorker(record.runId, "start", { ...HOST, paths, log: quiet, inner: {
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

  it("workerMain exits 70 before a backend can swallow an unrevocable lease", { timeout: 15_000 }, async () => {
    const { paths, projectDir } = setup({ live: SCRIPT });
    const record = createRun(paths, { who: PERSON, workflow: "live", projectDir, inputs: {} });
    const source = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { workerMain } = await import(${JSON.stringify(new URL("../../src/runs/worker.ts", import.meta.url).href)});
const paths = ${JSON.stringify(paths)};
let fail = false;
const write = fs.writeFileSync, unlink = fs.unlinkSync, open = fs.openSync;
const denied = () => Object.assign(new Error('read-only filesystem'), { code: 'EROFS' });
fs.writeFileSync = (...args) => { if (fail && String(args[0]).startsWith(paths.runs)) throw denied(); return write(...args); };
fs.unlinkSync = (...args) => { if (fail && String(args[0]).endsWith('.lock')) throw denied(); return unlink(...args); };
fs.openSync = (...args) => { if (fail && args[1] === 'r+' && String(args[0]).endsWith('.lock')) throw denied(); return open(...args); };
syncBuiltinESMExports();
const result = await workerMain(${JSON.stringify(record.runId)}, 'start', {
  paths, log() {},
  onLeaseRevocationFailure() { process.send?.('override-called'); throw new Error('must not override'); },
  inner: { async run(_prompt, request) {
    request.onSessionOpen?.(${JSON.stringify(session("fatal-owner-session", projectDir))});
    process.send?.('ready');
    await new Promise(resolve => process.once('message', resolve));
    fail = true;
    try { request.onSessionOpen?.(${JSON.stringify(session("never-accepted", projectDir))}); }
    catch { process.send?.('swallowed'); }
    process.send?.('continued');
    return 'must never finish';
  } },
});
process.send?.('returned');
process.exit(result);
`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: new URL("../..", import.meta.url),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const ready = deferred();
    const messages: unknown[] = [];
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    child.on("message", message => { messages.push(message); if (message === "ready") ready.resolve(); });
    child.once("error", ready.reject);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      await Promise.race([ready.promise, exited.then(() => assert.fail(stderr || "worker exited before opening"))]);
      assert.equal(runDetail(paths, record.runId).steps[0]?.session?.sessionId,
        "fatal-owner-session");
      child.send("fail");
      assert.deepEqual(await exited, { code: 70, signal: null }, stderr);
      assert.deepEqual(messages, ["ready"]);
      assert.ok(readState(paths, record.runId)?.activeAgentSessions,
        "total I/O failure leaves the old snapshot unchanged");
      assert.equal(runDetail(paths, record.runId).steps[0]?.session, undefined,
        "the dead owning process cannot attest the old identity");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
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
    const worker = runWorker(record.runId, "start", { ...HOST, paths, log: quiet, inner: {
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


});

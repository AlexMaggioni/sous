import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowError, WorkflowErrorCode } from "@orchestrator/shared-types";
import { createRun } from "../../src/runs/launch.js";
import { findRecord } from "../../src/runs/records.js";
import { runningSteps } from "../../src/runs/view.js";
import { runWorker } from "../../src/runs/worker.js";
import { fakeHost, heldRunner, settle, setup, until } from "./fixture.js";

const quiet = () => {};
const child = `export const meta = { name: 'child', description: 'child' }\nreturn await agent('build it', { label: 'build' })`;

/** The steps that run now, read the way `orc stop --step` reads them. */
function running(paths: Parameters<typeof runningSteps>[0], runId: string): string[] {
  return runningSteps(paths, findRecord(paths, runId)!).sort();
}

describe("the steps that run now", () => {
  it("a top-level step goes by its label", async () => {
    const { paths, projectDir } = setup({ top: `export const meta = { name: 'top', description: 'top' }\nreturn await agent('build it', { label: 'build' })` });
    const { runner, release } = heldRunner(() => "wait");
    const record = createRun(paths, fakeHost, { workflow: "top", projectDir, inputs: {} });
    const worker = runWorker(record.runId, "start", { host: fakeHost, paths, inner: runner, pollMs: 20, log: quiet });
    assert.deepEqual(await settle(() => running(paths, record.runId), ["build"]), ["build"]);
    release("build");
    assert.equal((await worker)?.status, "completed");
    assert.deepEqual(running(paths, record.runId), [], "nothing runs once the run ended");
  });

  it("a step of a nested run goes by the nested label and its own", async () => {
    const { paths, projectDir } = setup({
      child,
      parent: `export const meta = { name: 'parent', description: 'parent' }\nreturn await workflow('child', {}, { label: 'ticket A' })`,
    });
    const { runner, release } = heldRunner(() => "wait");
    const record = createRun(paths, fakeHost, { workflow: "parent", projectDir, inputs: {} });
    const worker = runWorker(record.runId, "start", { host: fakeHost, paths, inner: runner, pollMs: 20, log: quiet });
    assert.deepEqual(await settle(() => running(paths, record.runId), ["ticket A: build"]), ["ticket A: build"]);
    release("build");
    assert.equal((await worker)?.status, "completed");
  });

  it("two nested runs side by side each show their step", async () => {
    const { paths, projectDir } = setup({
      child,
      parent: `export const meta = { name: 'parent', description: 'parent' }
return await Promise.all([workflow('child', {}, { label: 'ticket A' }), workflow('child', {}, { label: 'ticket B' })])`,
    });
    const { runner, calls, release } = heldRunner(() => "wait");
    const record = createRun(paths, fakeHost, { workflow: "parent", projectDir, inputs: {} });
    const worker = runWorker(record.runId, "start", { host: fakeHost, paths, inner: runner, pollMs: 20, log: quiet });
    const both = ["ticket A: build", "ticket B: build"];
    assert.deepEqual(await settle(() => running(paths, record.runId), both), both);
    assert.equal(calls.length, 2);
    release("build");
    assert.equal((await worker)?.status, "completed");
  });

  it("a step that ended is not listed", async () => {
    const { paths, projectDir } = setup({
      two: `export const meta = { name: 'two', description: 'two steps' }
await agent('first', { label: 'first' })
return await agent('second', { label: 'second' })`,
    });
    const { runner, calls, release } = heldRunner((call) => (call.label === "first" ? "first done" : "wait"));
    const record = createRun(paths, fakeHost, { workflow: "two", projectDir, inputs: {} });
    const worker = runWorker(record.runId, "start", { host: fakeHost, paths, inner: runner, pollMs: 20, log: quiet });
    await until(() => calls.some((call) => call.label === "second"));
    assert.deepEqual(await settle(() => running(paths, record.runId), ["second"]), ["second"]);
    release("second");
    assert.equal((await worker)?.status, "completed");
  });

  it("a step that failed is not listed, while its neighbor still runs", async () => {
    const { paths, projectDir } = setup({
      side: `export const meta = { name: 'side', description: 'side by side' }
return await Promise.allSettled([agent('bad', { label: 'bad', retries: 0 }), agent('slow', { label: 'slow' })])`,
    });
    const { runner, calls, release } = heldRunner((call) => (call.label === "bad" ? new Error("the tests fail") : "wait"));
    const record = createRun(paths, fakeHost, { workflow: "side", projectDir, inputs: {} });
    const worker = runWorker(record.runId, "start", { host: fakeHost, paths, inner: runner, pollMs: 20, log: quiet });
    await until(() => calls.some((call) => call.label === "bad") && calls.some((call) => call.label === "slow"));
    assert.deepEqual(await settle(() => running(paths, record.runId), ["slow"]), ["slow"]);
    release("slow");
    await worker;
    assert.deepEqual(running(paths, record.runId), []);
  });

  it("a step tried again is listed once", async () => {
    const { paths, projectDir } = setup({
      flaky: `export const meta = { name: 'flaky', description: 'a step tried twice' }\nreturn await agent('flaky', { label: 'flaky', retries: 1 })`,
    });
    const { runner, calls, release } = heldRunner((_call, all) =>
      all.length === 1 ? new WorkflowError("the tests fail", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true }) : "wait",
    );
    const record = createRun(paths, fakeHost, { workflow: "flaky", projectDir, inputs: {} });
    const worker = runWorker(record.runId, "start", { host: fakeHost, paths, inner: runner, pollMs: 20, log: quiet });
    await until(() => calls.length === 2);
    assert.equal(calls.length, 2, "the step ran a second time");
    assert.deepEqual(await settle(() => running(paths, record.runId), ["flaky"]), ["flaky"]);
    release("flaky");
    assert.equal((await worker)?.status, "completed");
  });
});

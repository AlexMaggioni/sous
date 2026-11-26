// `sous pause` reaches the worker through a file and SIGUSR1. A worker that ends stops listening
// and drops a pause asked of it, and a worker an older sous started gets SIGUSR1 alone.

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createRun } from "../../src/runs/launch.js";
import { loadRecord, requestPause, updateRecord } from "../../src/runs/records.js";
import { runningCalls } from "../../src/runs/run.js";
import { pauseRequestFile } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import { PERSON, fakeRunner } from "../../src/testing.js";
import { waitUntil } from "../helpers/async.js";
import { quiet, setup } from "./fixture.js";

const HOLD = `export const meta = { name: 'hold', description: 'One held step' }
return await agent('Build it.', { label: 'impl' })`;

describe("a pause and the worker it is for", () => {
  it("a worker that ends stops listening and leaves no pause for the next one", async () => {
    const { paths, projectDir } = setup({ hold: HOLD });
    let release!: () => void;
    const gate = new Promise<string>((done) => (release = () => done("ok")));
    const { runId } = createRun(paths, { who: PERSON, workflow: "hold", projectDir, inputs: {} });
    const worker = runWorker(runId, "start", { paths, inner: fakeRunner(() => gate).runner, pollMs: 20, log: quiet, handleSignals: true });
    await waitUntil(() => runningCalls(paths, runId).some((call) => call.label === "impl"), "impl to run");
    assert.equal(loadRecord(paths, runId)?.listening, process.pid);
    assert.equal(loadRecord(paths, runId)?.pauseFile, true);

    // A pause that lands as the worker ends: its file, and no signal yet.
    writeFileSync(pauseRequestFile(paths, runId), "");
    release();
    assert.equal((await worker)?.status, "completed");
    const record = loadRecord(paths, runId)!;
    assert.equal(record.listening, undefined, "no SIGUSR1 goes to a worker that stopped listening");
    assert.equal(record.pid, undefined);
    assert.equal(existsSync(pauseRequestFile(paths, runId)), false, "the next worker finds no pause");
  });

  it("a worker an older sous started gets SIGUSR1 and no file", async () => {
    const { paths, projectDir } = setup({ hold: HOLD });
    const { runId } = createRun(paths, { who: PERSON, workflow: "hold", projectDir, inputs: {} });
    // The older sous noted the pid alone. This process stands in for its worker.
    updateRecord(paths, runId, { pid: process.pid });
    const signalled = new Promise<void>((done) => process.once("SIGUSR1", () => done()));
    requestPause(paths, runId);
    await signalled;
    assert.equal(existsSync(pauseRequestFile(paths, runId)), false);
  });
});

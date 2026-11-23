import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRun, fakeRunner, inProcess, readState, testHome } from "@orchestrator/engine/testing";
import { orc } from "./orc.js";

// A run whose worker process dies mid-step, saved by today's code, and resumed through orc.

/** Wait until the process prints `marker`. */
async function printed(child: ChildProcess, marker: string): Promise<void> {
  let out = "";
  let err = "";
  child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${marker} after 60s. stdout: ${out} stderr: ${err}`)), 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`the worker ended first: code ${code}, signal ${signal}. stderr: ${err}`));
    });
  });
}

describe("a run cut off by a crash", () => {
  it("reads as interrupted, and orc resume goes on from the step that was cut off", async () => {
    const { paths, projectDir } = testHome({
      two: `export const meta = { name: 'two', description: 'two steps' }
const first = await agent('first', { label: 'first' })
const second = await agent('second', { label: 'second' })
return first + ' ' + second`,
    });
    const record = createRun(paths, { workflow: "two", projectDir, inputs: {} });
    const worker = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "fixtures", "crash-worker.ts"), paths.home, record.runId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await printed(worker, "SECOND_STARTED");
    } finally {
      worker.kill("SIGKILL");
    }
    if (worker.exitCode === null && worker.signalCode === null) await once(worker, "exit");
    assert.equal(readState(paths, record.runId)?.status, "running", "the state is as the dead worker left it");

    assert.match((await orc(paths, ["show", record.runId])).out, /^status {4}interrupted$/m);

    const { runner, calls } = fakeRunner(() => "two");
    const workers = inProcess({ inner: runner });
    const resumed = await orc(paths, ["resume", record.runId], { launch: workers.launch });
    assert.equal(resumed.code, 0, resumed.out);
    const done = await workers.ended(record.runId);
    assert.equal(done?.status, "completed");
    assert.equal(done?.result, "one two");
    assert.deepEqual(calls.map((call) => call.label), ["second"], "the finished step did not run again");
  });
});

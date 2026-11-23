import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resumeRun, runQuestions, startRun } from "@orchestrator/engine";
import { fakeRunner, inProcess, readState, testHome, writeAnswer } from "@orchestrator/engine/testing";
import { orc } from "./orc.js";

// A workflow's time limit reached while a code step runs, and while no step runs. runs.test.ts
// has the limit reached while an agent step runs.

describe("time limit", () => {
  it("reached in a code step, stops it and pauses the run on it, and resume runs the code step again", async () => {
    // The code step notes each start, then waits for the file "go". The test writes "go" only
    // before the resume, so the limit always comes while the code step runs.
    const { paths, projectDir } = testHome({
      build: `export const meta = { name: 'build', description: 'a code step, then an agent', timeout: '3s' }
const built = await sh('echo start >> started.txt; while [ ! -f go ]; do sleep 0.05; done; echo built')
return await agent('check ' + built.stdout.trim(), { label: 'check' })`,
    });
    const { runner, calls } = fakeRunner((call) => `${call.prompt} done`);
    const lines: string[] = [];
    const workers = inProcess({ inner: runner, log: (line) => lines.push(line) });
    const record = startRun(paths, workers.launch, { workflow: "build", projectDir, inputs: {} });

    const paused = await workers.ended(record.runId);
    assert.equal(paused?.status, "paused", lines.join("\n"));
    assert.equal(readState(paths, record.runId)?.pauseReason, "time_limit");
    assert.match((await orc(paths, ["list"])).out, /paused: time limit/);
    assert.equal(calls.length, 0, "the agent step after it did not start");

    writeFileSync(join(projectDir, "go"), "");
    resumeRun(paths, workers.launch, record.runId);
    const done = await workers.ended(record.runId);
    assert.equal(done?.status, "completed", lines.join("\n"));
    assert.equal(done?.result, "check built done");
    assert.equal(readFileSync(join(projectDir, "started.txt"), "utf8"), "start\nstart\n", "the stopped code step ran again");
    assert.deepEqual(calls.map((call) => call.label), ["check"]);
  });

  it("reached while the run waits for an answer, pauses the run as orc pause does, and resume goes on with the answer", async () => {
    // The question comes first, so no step can be running when the limit is reached.
    const { paths, projectDir } = testHome({
      asks: `export const meta = { name: 'asks', description: 'asks', timeout: '1s' }
const name = await checkpoint('Name it', { kind: 'input' })
return await agent('Build ' + name, { label: 'build' })`,
    });
    const { runner, calls } = fakeRunner((call) => `${call.prompt} done`);
    const lines: string[] = [];
    const workers = inProcess({ inner: runner, log: (line) => lines.push(line) });
    const record = startRun(paths, workers.launch, { workflow: "asks", projectDir, inputs: {} });

    const paused = await workers.ended(record.runId);
    assert.equal(paused?.status, "paused", lines.join("\n"));
    assert.match(lines.join("\n"), /time limit 1s reached/);
    assert.equal(readState(paths, record.runId)?.pauseReason, "requested", "the pause orc pause makes");
    assert.match((await orc(paths, ["show", record.runId])).out, /^status {4}paused$/m);
    const [question] = runQuestions(paths, record.runId);
    assert.equal(question?.id, `${record.runId}--0`, "the question waits while the run is paused");
    assert.equal(calls.length, 0, "no agent step ran");

    writeAnswer(paths, question!, "orc");
    resumeRun(paths, workers.launch, record.runId);
    const done = await workers.ended(record.runId);
    assert.equal(done?.status, "completed", lines.join("\n"));
    assert.equal(done?.result, "Build orc done");
    assert.deepEqual(calls.map((call) => call.prompt), ["Build orc"]);
    assert.deepEqual(runQuestions(paths, record.runId), []);
  });
});

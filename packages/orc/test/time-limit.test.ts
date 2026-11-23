import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resumeRun, runQuestions, startRun } from "@orchestrator/engine";
import { fakeRunner, inProcess, readState, testHome, writeAnswer } from "@orchestrator/engine/testing";
import { orc } from "./orc.js";

// A workflow's time limit reached while no step runs. runs.test.ts has the limit reached while an
// agent step runs.

// The agent lookup reads the harnesses' home folders. These tests give it empty ones.
const harnessHome = mkdtempSync(join(tmpdir(), "orc-harness-home-"));
process.env.CLAUDE_CONFIG_DIR = join(harnessHome, ".claude");
process.env.CODEX_HOME = join(harnessHome, ".codex");
process.env.XDG_CONFIG_HOME = join(harnessHome, ".config");
delete process.env.AGENTPRISM_DEFAULT_BACKEND;

describe("time limit", () => {
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

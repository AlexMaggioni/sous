import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/runs/home.js";
import { createRun } from "../src/runs/launch.js";
import { loadRecord } from "../src/runs/records.js";
import { resumeRun, startRun } from "../src/runs/run.js";
import { logFile, readEventsAfter, readState, type SavedEvent } from "../src/runs/store.js";
import type { PersistedRunState } from "../src/runs/persistence/run-persistence.js";
import { fakeRunner, inProcess, plantState, testHome } from "../src/testing.js";

// The test kit at @orchestrator/engine/testing.

const ONE_STEP = `export const meta = { name: 'one', description: 'one step' }\nreturn await agent('go', { label: 'go' })`;
// A run the old code left paused, with its state and its event log.
const OLD_RUN = join(import.meta.dirname, "fixtures", "old-failed-step-run.json");
const quiet = () => {};

describe("test kit", () => {
  it("testHome turns the desktop notices off", () => {
    assert.equal(loadConfig(testHome().paths).notify, false);
  });

  it("plantState writes a state and an event log where the engine reads them", () => {
    const fixture = JSON.parse(readFileSync(OLD_RUN, "utf8")) as { state: PersistedRunState; events: string };
    const { paths } = testHome();
    plantState(paths, fixture.state, fixture.events);
    assert.deepEqual(readState(paths, fixture.state.runId), fixture.state);
    const events: SavedEvent[] = [];
    readEventsAfter(paths, fixture.state.runId, 0, (saved) => events.push(saved));
    const lines = fixture.events.split("\n").filter((line) => line.trim());
    assert.deepEqual(
      events.map((saved) => saved.event),
      lines.map((line) => JSON.parse(line).event),
    );
  });

  it("plantState without events writes no event log", () => {
    const { paths } = testHome();
    const at = "2026-11-21T10:00:00.000Z";
    plantState(paths, { runId: "run-a", status: "completed", startedAt: at, updatedAt: at, agents: [], logs: [], phases: [] });
    assert.equal(readState(paths, "run-a")?.status, "completed");
    assert.throws(() => readEventsAfter(paths, "run-a", 0, quiet));
  });

  it("inProcess starts the worker in this process: the record names it while it runs, the run's log gets its lines, and ended gives its result", async () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    const { runner, calls } = fakeRunner(() => "done");
    const lines: string[] = [];
    const workers = inProcess({ inner: runner, log: (line) => lines.push(line) });
    const record = startRun(paths, workers.launch, { workflow: "one", projectDir, inputs: {} });
    assert.equal(loadRecord(paths, record.runId)?.pid, process.pid);
    assert.deepEqual(workers.launched, [{ runId: record.runId, mode: "start" }]);

    assert.equal((await workers.ended(record.runId))?.status, "completed");
    assert.deepEqual(
      calls.map((call) => [call.prompt, call.label]),
      [["go", "go"]],
    );
    assert.equal(loadRecord(paths, record.runId)?.pid, undefined);
    assert.ok(lines.some((line) => line.includes("completed")));
    assert.equal(readFileSync(logFile(paths, record.runId), "utf8"), lines.map((line) => `${line}\n`).join(""));
  });

  it("inProcess resumes through the same launcher, and ended gives the last worker's result", async () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    let fail = true;
    const { runner } = fakeRunner(() => {
      if (fail) throw new Error("the step failed");
      return "done";
    });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "one", projectDir, inputs: {} });
    assert.equal((await workers.ended(record.runId))?.status, "paused");

    fail = false;
    resumeRun(paths, workers.launch, record.runId);
    assert.deepEqual(
      workers.launched.map((launch) => launch.mode),
      ["start", "resume"],
    );
    assert.equal((await workers.ended(record.runId))?.status, "completed");
  });

  it("inProcess writes a worker's error to the run's log, clears its pid, and ended rejects with the error", async () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    const workers = inProcess({ inner: fakeRunner(() => "done").runner });
    // A run that never started has nothing to resume, so its worker throws.
    const record = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    workers.launch(paths, record.runId, "resume");
    assert.equal(loadRecord(paths, record.runId)?.pid, process.pid);
    await assert.rejects(workers.ended(record.runId), /cannot resume/);
    assert.match(readFileSync(logFile(paths, record.runId), "utf8"), /\d\d:\d\d:\d\d error {6}Error: run \S+ cannot resume/);
    assert.equal(loadRecord(paths, record.runId)?.pid, undefined);
  });

  it("inProcess logs a worker with no record, and ended rejects for a run it never started", async () => {
    const { paths } = testHome();
    const workers = inProcess({ inner: fakeRunner(() => "done").runner });
    workers.launch(paths, "run-none", "start");
    await assert.rejects(workers.ended("run-none"), /no run run-none/);
    assert.match(readFileSync(logFile(paths, "run-none"), "utf8"), /error {6}Error: no run run-none/);
    await assert.rejects(workers.ended("run-other"), /no worker started for run-other/);
    assert.equal(existsSync(logFile(paths, "run-other")), false);
  });
});

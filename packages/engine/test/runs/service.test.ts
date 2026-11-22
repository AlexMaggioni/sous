import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createRun } from "../../src/runs/launch.js";
import { updateRecord } from "../../src/runs/records.js";
import { tick } from "../../src/runs/service.js";
import { managerFor } from "../../src/runs/worker.js";
import { NO_CLI, setup } from "./fixture.js";

describe("usage limit", () => {
  it("does not resume a run whose workflow changed since it started, tells the user once, and resumes it after --latest", () => {
    const job = (version: string) => `export const meta = { name: 'job', description: 'j' }\nreturn '${version}'`;
    const { paths, projectDir } = setup({ job: job("v1") });
    const kept = createRun(paths, { workflow: "job", projectDir, inputs: {} });
    const edited = createRun(paths, { workflow: "job", projectDir, inputs: {} });
    const persistence = managerFor(paths, projectDir).getPersistence() as unknown as { save: (state: unknown) => void };
    const at = "2026-11-21T10:00:00.000Z";
    const paused = { startedAt: at, updatedAt: at, agents: [], logs: [], phases: [], status: "paused", pauseReason: "usage_limit", resetHint: "Resets at 2026-11-21T10:30:00.000Z" };
    persistence.save({ ...paused, runId: kept.runId, script: readFileSync(kept.file, "utf8") });
    persistence.save({ ...paused, runId: edited.runId, script: job("v0") });

    const spawned: string[] = [];
    const told: string[] = [];
    const lines: string[] = [];
    const deps = { spawn: (runId: string) => spawned.push(runId), notify: (title: string, body: string) => told.push(`${title}: ${body}`), log: (line: string) => lines.push(line) };
    tick(paths, NO_CLI, { ...deps, now: new Date("2026-11-21T11:00:00.000Z") });
    tick(paths, NO_CLI, { ...deps, now: new Date("2026-11-21T11:05:00.000Z") });
    const text = `job changed since ${edited.runId} started. orc resume ${edited.runId} --latest takes the new version, orc resume ${edited.runId} --same goes on with the old one.`;
    assert.deepEqual(spawned, [kept.runId], "only the run with no edit resumes");
    assert.deepEqual(told, [`job did not resume: ${text}`], "the user hears it once");
    assert.equal(lines.filter((line) => line === text).length, 1);

    updateRecord(paths, edited.runId, { resumeLatest: true });
    tick(paths, NO_CLI, { ...deps, now: new Date("2026-11-21T11:10:00.000Z") });
    assert.deepEqual(spawned, [kept.runId, edited.runId], "--latest lets the service resume it");
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createRun } from "../../src/runs/launch.js";
import { updateRecord } from "../../src/runs/records.js";
import { tick } from "../../src/runs/service.js";
import { plantState, setup } from "./fixture.js";
import { PERSON } from "../../src/testing.js";

describe("usage limit", () => {
  it("does not resume a run whose workflow changed since it started, tells the user once, and resumes it after --latest", () => {
    const job = (version: string) => `export const meta = { name: 'job', description: 'j' }\nreturn '${version}'`;
    const { paths, projectDir } = setup({ job: job("v1") });
    const kept = createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {} });
    const edited = createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {} });
    const at = "2026-11-21T10:00:00.000Z";
    const paused = { startedAt: at, updatedAt: at, agents: [], logs: [], phases: [], status: "paused" as const, pauseReason: "usage_limit", resetHint: "Resets at 2026-11-21T10:30:00.000Z" };
    plantState(paths, { ...paused, runId: kept.runId, script: readFileSync(kept.file, "utf8") });
    plantState(paths, { ...paused, runId: edited.runId, script: job("v0") });

    const spawned: string[] = [];
    const told: string[] = [];
    const lines: string[] = [];
    const launch = (_paths: unknown, runId: string) => spawned.push(runId);
    const deps = { notify: (title: string, body: string) => told.push(`${title}: ${body}`), log: (line: string) => lines.push(line) };
    tick(paths, launch, { ...deps, now: new Date("2026-11-21T11:00:00.000Z") });
    tick(paths, launch, { ...deps, now: new Date("2026-11-21T11:05:00.000Z") });
    const text = `job changed since ${edited.runId} started. sous resume ${edited.runId} --latest takes the new version, sous resume ${edited.runId} --same goes on with the old one.`;
    assert.deepEqual(spawned, [kept.runId], "only the run with no edit resumes");
    assert.deepEqual(told, [`job did not resume: ${text}`], "the user hears it once");
    assert.equal(lines.filter((line) => line === text).length, 1);

    updateRecord(paths, edited.runId, { resumeLatest: true });
    tick(paths, launch, { ...deps, now: new Date("2026-11-21T11:10:00.000Z") });
    assert.deepEqual(spawned, [kept.runId, edited.runId], "--latest lets the service resume it");
  });
});

// Where a run leaves its files today. These tests list every file and folder a finished, a
// paused, a nested and a forgotten run leave, with the run id and the project keys replaced, so
// moving the code that builds a path cannot move a file without a test saying so.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { daemonLog, logFile } from "../../src/index.js";
import { createRun } from "../../src/runs/launch.js";
import { createRunPersistence } from "../../src/runs/persistence/run-persistence.js";
import { loadRecord } from "../../src/runs/records.js";
import { forgetRun } from "../../src/runs/run.js";
import { runWorker } from "../../src/runs/worker.js";
import { heldRunner, layout, projectKey, setup } from "./fixture.js";

const quiet = () => {};

const top = `export const meta = { name: 'top', description: 'top' }
// the top workflow
const a = await agent('build it', { label: 'build' })
const b = await workflow('child', {}, { label: 'c' })
return { a, b }`;
const child = `export const meta = { name: 'child', description: 'child' }
// the child workflow
return await agent('child step', { label: 'inner' })`;
const single = `export const meta = { name: 'top', description: 'top' }
// the top workflow
return await agent('build it', { label: 'build' })`;

const home = [
  "home/",
  "home/config.json",
  "home/inbox/",
  "home/logs/",
  "home/projects.json",
  "home/queue/",
  "home/records/",
  "home/runs/",
  "home/runs/projects/",
  "home/runs/projects/<home key>/",
  "home/runs/projects/<home key>/project.json",
  "home/runs/projects/<home key>/runs/",
  "home/scratch/",
  "home/slots/",
  "home/worktrees/",
  "project/",
  "project/.orchestrator/",
  "project/.orchestrator/workflows/",
];

const runFiles = [
  "home/records/<id>.json",
  "home/records/<id>.workflows",
  "home/runs/projects/<cwd key>/",
  "home/runs/projects/<cwd key>/runs/",
  "home/runs/projects/<cwd key>/runs/<id>.log",
  "home/runs/projects/<home key>/runs/<id>.events.jsonl",
  "home/runs/projects/<home key>/runs/<id>.json",
  "home/runs/projects/<home key>/runs/<id>.json.bak",
];

describe("where a run leaves its files", () => {
  it("a finished run with a nested run leaves its files in records and in two project folders, and the nested run leaves none", async () => {
    const { paths, projectDir } = setup({ top, child });
    const { runner } = heldRunner(() => "ok");
    const record = createRun(paths, { workflow: "top", projectDir, inputs: {} });
    const result = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(result?.status, "completed");
    assert.equal(record.cwd, projectDir);
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...home, ...runFiles].sort());
    assert.deepEqual(loadRecord(paths, record.runId)?.nested, {
      [`${record.runId}-nested1`]: { parent: record.runId, workflow: "child", label: "c" },
    });
  });

  it("a run paused on a failed step leaves the same files as a finished run", async () => {
    const { paths, projectDir } = setup({ top: single });
    const { runner } = heldRunner(() => new Error("boom"));
    const record = createRun(paths, { workflow: "top", projectDir, inputs: {} });
    const result = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(result?.status, "paused");
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...home, ...runFiles].sort());
  });

  it("a forgotten run leaves only the home's project.json", async () => {
    const { paths, projectDir } = setup({ top, child });
    const { runner } = heldRunner(() => "ok");
    const record = createRun(paths, { workflow: "top", projectDir, inputs: {} });
    await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    forgetRun(paths, loadRecord(paths, record.runId)!);
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...home].sort());
    const manifest = join(paths.runs, "projects", projectKey(paths.home), "project.json");
    assert.equal(readFileSync(manifest, "utf8"), `${JSON.stringify({ projectDir: paths.home })}\n`);
  });

  it("the top workflow's text sits in four files and the nested workflow's text in two", async () => {
    const { paths, projectDir } = setup({ top, child });
    const { runner } = heldRunner(() => "ok");
    const record = createRun(paths, { workflow: "top", projectDir, inputs: {} });
    await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    const runs = join(paths.runs, "projects", projectKey(paths.home), "runs");
    const snapshot = JSON.parse(readFileSync(join(paths.records, `${record.runId}.workflows`), "utf8"));
    const state = JSON.parse(readFileSync(join(runs, `${record.runId}.json`), "utf8"));
    const backup = JSON.parse(readFileSync(join(runs, `${record.runId}.json.bak`), "utf8"));
    assert.deepEqual(snapshot, { child, top });
    assert.equal(readFileSync(join(projectDir, ".orchestrator", "workflows", "top.js"), "utf8"), top);
    assert.equal(state.script, top);
    assert.equal(backup.script, top);
    const holders = (text: string) => {
      const found: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (readFileSync(path, "utf8").includes(text)) found.push(relative(dirname(paths.home), path).split(record.runId).join("<id>").split(projectKey(paths.home)).join("<home key>"));
        }
      };
      walk(dirname(paths.home));
      return found.sort();
    };
    assert.deepEqual(holders("// the top workflow"), [
      "home/records/<id>.workflows",
      "home/runs/projects/<home key>/runs/<id>.json",
      "home/runs/projects/<home key>/runs/<id>.json.bak",
      "project/.orchestrator/workflows/top.js",
    ]);
    assert.deepEqual(holders("// the child workflow"), ["home/records/<id>.workflows", "project/.orchestrator/workflows/child.js"]);
  });

  it("a run's worker log and the service's log sit in the home's logs folder", () => {
    const { paths } = setup({});
    assert.equal(logFile(paths, "r1"), join(paths.home, "logs", "r1.log"));
    assert.equal(daemonLog(paths), join(paths.home, "logs", "daemon.log"));
  });

  it("a run's lease does not follow it to a new folder, so moving a live run's files is unsafe", () => {
    const { paths } = setup({});
    const old = createRunPersistence(paths.home, undefined, { persistenceRoot: paths.runs });
    assert.ok(old.acquireRunLease("r1"), "the old folder gives the lease");
    // A store in another folder does not see the lock in the old one.
    const moved = join(paths.home, "moved");
    const next = createRunPersistence(paths.home, undefined, { persistenceRoot: moved });
    const lease = next.acquireRunLease("r1");
    assert.ok(lease, "the new folder gives the lease while the old one is held");
    next.releaseRunLease(lease);
    // A lock copied as is names the old state file, so the new store takes it over even though
    // its owner is alive.
    const oldRuns = join(paths.runs, "projects", projectKey(paths.home), "runs");
    const newRuns = join(moved, "projects", projectKey(paths.home), "runs");
    mkdirSync(newRuns, { recursive: true });
    writeFileSync(join(newRuns, "r1.lock"), readFileSync(join(oldRuns, "r1.lock")));
    assert.ok(next.acquireRunLease("r1"), "the copied lock of a live owner is taken over");
  });
});

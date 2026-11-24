// Where a run leaves its files today. These tests list every file and folder a finished, a
// paused, a nested and a forgotten run leave, with the run id and the project keys replaced, so
// moving the code that builds a path cannot move a file without a test saying so.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { daemonLog, logFile } from "../../src/index.js";
import { createRun } from "../../src/runs/launch.js";
import { loadRecord } from "../../src/runs/records.js";
import { forgetRun } from "../../src/runs/run.js";
import { runWorker } from "../../src/runs/worker.js";
import { heldRunner, layout, projectKey, quiet, setup } from "./fixture.js";

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
  "home/runs/projects/<home key>/runs/",
  "home/scratch/",
  "home/slots/",
  "home/worktrees/",
  "project/",
  "project/.sous/",
  "project/.sous/workflows/",
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
  it("a finished run with a nested run leaves its files in records and in two project folders, each workflow's text in its files, and the nested run leaves none", async () => {
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
    const runs = join(paths.runs, "projects", projectKey(paths.home), "runs");
    const snapshot = JSON.parse(readFileSync(join(paths.records, `${record.runId}.workflows`), "utf8"));
    const state = JSON.parse(readFileSync(join(runs, `${record.runId}.json`), "utf8"));
    const backup = JSON.parse(readFileSync(join(runs, `${record.runId}.json.bak`), "utf8"));
    assert.deepEqual(snapshot, { child, top });
    assert.equal(readFileSync(join(projectDir, ".sous", "workflows", "top.js"), "utf8"), top);
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
      "project/.sous/workflows/top.js",
    ]);
    assert.deepEqual(holders("// the child workflow"), ["home/records/<id>.workflows", "project/.sous/workflows/child.js"]);
  });

  it("a run paused on a failed step leaves the same files as a finished run", async () => {
    const { paths, projectDir } = setup({ top: single });
    const { runner } = heldRunner(() => new Error("boom"));
    const record = createRun(paths, { workflow: "top", projectDir, inputs: {} });
    const result = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(result?.status, "paused");
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...home, ...runFiles].sort());
  });

  it("a forgotten run leaves only the home's folders", async () => {
    const { paths, projectDir } = setup({ top, child });
    const { runner } = heldRunner(() => "ok");
    const record = createRun(paths, { workflow: "top", projectDir, inputs: {} });
    await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    forgetRun(paths, loadRecord(paths, record.runId)!);
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...home].sort());
  });

  it("a run's worker log and the service's log sit in the home's logs folder", () => {
    const { paths } = setup({});
    assert.equal(logFile(paths, "r1"), join(paths.home, "logs", "r1.log"));
    assert.equal(daemonLog(paths), join(paths.home, "logs", "daemon.log"));
  });
});

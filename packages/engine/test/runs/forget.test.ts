// forgetRun and pruneRuns on the files today's code leaves. Each test plants a finished run with
// raw writes, so it checks what the two remove, whatever code builds the paths.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HomePaths } from "../../src/runs/home.js";
import type { RunRecord } from "../../src/runs/records.js";
import { forgetRun, pruneRuns } from "../../src/runs/run.js";
import { layout, plantTodayRun, projectKey, setup, TODAY_ID } from "./fixture.js";

const folders = [
  "home/",
  "home/config.json",
  "home/inbox/",
  "home/logs/",
  "home/queue/",
  "home/records/",
  "home/runs/",
  "home/runs/projects/",
  "home/scratch/",
  "home/slots/",
  "home/worktrees/",
  "project/",
  "project/.orchestrator/",
  "project/.orchestrator/workflows/",
];

/** The files of the run that orc writes. */
const orcFiles = ["home/records/<id>.json", "home/records/<id>.workflows", "home/runs/projects/<cwd key>/", "home/runs/projects/<cwd key>/runs/", "home/runs/projects/<cwd key>/runs/<id>.log"];

/** The files of the run that the engine writes. */
const engineFiles = [
  "home/runs/projects/<home key>/runs/<id>.events.jsonl",
  "home/runs/projects/<home key>/runs/<id>.json",
  "home/runs/projects/<home key>/runs/<id>.json.bak",
  "home/runs/projects/<home key>/runs/<id>.script.js",
];

/** What the engine keeps of the home after a run is gone. */
const kept = ["home/runs/projects/<home key>/", "home/runs/projects/<home key>/project.json", "home/runs/projects/<home key>/runs/"];

const lineage = "home/runs/projects/<home key>/runs/<id>.lineage";
const lock = "home/runs/projects/<home key>/runs/<id>.lock";

/** Thirty days after the planted run started. */
const later = new Date(Date.parse("2026-11-23T06:21:32.322Z") + 30 * 86_400_000);

/** The two ways a run's files go, which remove the same files. */
const removers = {
  forgetRun: (paths: HomePaths, record: RunRecord) => forgetRun(paths, record),
  pruneRuns: (paths: HomePaths) => void pruneRuns(paths, 7, later),
};

describe("forget and prune on today's files", () => {
  it("the planted run has the files a finished run leaves", () => {
    const { paths } = setup({});
    const record = plantTodayRun(paths);
    assert.equal(record.runId, TODAY_ID);
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...folders, ...kept, ...orcFiles, ...engineFiles].sort());
  });

  it("forgetRun removes every file of the run but the home's project.json", () => {
    const { paths } = setup({});
    const record = plantTodayRun(paths);
    assert.equal(forgetRun(paths, record), true);
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...folders, ...kept].sort());
  });

  it("pruneRuns removes the same files once the run is older than the days given", () => {
    const { paths } = setup({});
    const record = plantTodayRun(paths);
    assert.deepEqual(pruneRuns(paths, 7, later), [TODAY_ID]);
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...folders, ...kept].sort());
  });

  it("with a worktree cwd, forgetRun and pruneRuns remove the engine log in the worktree's folder, and the worktree stays", () => {
    for (const [name, remove] of Object.entries(removers)) {
      const { paths } = setup({});
      const record = plantTodayRun(paths, { worktree: true });
      assert.equal(record.cwd, `${paths.home}/worktrees/${TODAY_ID}`);
      assert.deepEqual(layout(paths, record.runId, record.cwd), [...folders, ...kept, ...orcFiles, ...engineFiles, "home/worktrees/<id>/"].sort());
      remove(paths, record);
      assert.deepEqual(layout(paths, record.runId, record.cwd), [...folders, ...kept, "home/worktrees/<id>/"].sort(), name);
    }
  });

  it("with a lock held by a live process, forgetRun removes nothing and says so", () => {
    const { paths } = setup({});
    const record = plantTodayRun(paths, { liveLock: true });
    assert.equal(forgetRun(paths, record), false);
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...folders, ...kept, ...orcFiles, ...engineFiles, lock].sort());
  });

  it("with a lock held by a live process, pruneRuns keeps the finished run whole", () => {
    // The run's state says completed, so only the lock tells that a process holds it, such as a
    // resume that has just started.
    const { paths } = setup({});
    const record = plantTodayRun(paths, { liveLock: true });
    assert.deepEqual(pruneRuns(paths, 7, later), []);
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...folders, ...kept, ...orcFiles, ...engineFiles, lock].sort());
  });

  it("forgetRun and pruneRuns remove a .lineage an older engine left next to the run", () => {
    for (const [name, remove] of Object.entries(removers)) {
      const { paths } = setup({});
      const record = plantTodayRun(paths, { lineage: true });
      assert.deepEqual(layout(paths, record.runId, record.cwd), [...folders, ...kept, ...orcFiles, ...engineFiles, lineage].sort());
      remove(paths, record);
      assert.deepEqual(layout(paths, record.runId, record.cwd), [...folders, ...kept].sort(), name);
    }
  });

  it("pruneRuns removes a .lineage whose run is gone, and keeps one whose run has a state", () => {
    const { paths } = setup({});
    const record = plantTodayRun(paths, { lineage: true });
    // A marker an older engine left when it forgot another run.
    const orphan = join(paths.home, "runs", "projects", projectKey(paths.home), "runs", "gone-run.lineage");
    writeFileSync(orphan, `${JSON.stringify({ runId: "gone-run", deletedAt: "2026-11-01T00:00:00.000Z" }, null, 2)}\n`);
    // The planted run is a day old, so the prune keeps it.
    assert.deepEqual(pruneRuns(paths, 7, new Date(Date.parse("2026-11-24T06:21:32.322Z"))), []);
    assert.equal(existsSync(orphan), false);
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...folders, ...kept, ...orcFiles, ...engineFiles, lineage].sort());
  });

  it("forgetRun removes the run's open question from the inbox", () => {
    const { paths } = setup({});
    const record = plantTodayRun(paths, { question: true });
    assert.ok(layout(paths, record.runId, record.cwd).includes("home/inbox/<id>--1.json"));
    forgetRun(paths, record);
    assert.deepEqual(layout(paths, record.runId, record.cwd), [...folders, ...kept].sort());
  });
});

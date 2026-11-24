import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadRecord, type HomePaths } from "@sous/engine";
import { createRun, plantState, testHome, updateRecord } from "@sous/engine/testing";
import { sous } from "./sous.js";

// sous prune removes the finished runs older than a number of days.

const job = `export const meta = { name: 'job', description: 'j' }\nreturn 'done'`;
const DAY = 86_400_000;

/** A run made `age` days ago, finished or paused. */
function run(paths: HomePaths, projectDir: string, age: number, status: "completed" | "paused" = "completed"): string {
  const record = createRun(paths, { workflow: "job", projectDir, inputs: {} });
  updateRecord(paths, record.runId, { createdAt: new Date(Date.now() - age * DAY).toISOString() });
  const at = new Date().toISOString();
  plantState(paths, {
    runId: record.runId,
    status,
    ...(status === "paused" ? { pauseReason: "requested" as const } : {}),
    startedAt: at,
    updatedAt: at,
    agents: [],
    logs: [],
    phases: [],
  });
  return record.runId;
}

describe("sous prune", () => {
  it("with --days N, removes the finished runs older than N days and keeps the others", async () => {
    const { paths, projectDir } = testHome({ job });
    const old = run(paths, projectDir, 10);
    const recent = run(paths, projectDir, 2);
    const oldPaused = run(paths, projectDir, 10, "paused");

    assert.deepEqual(await sous(paths, ["prune", "--days", "5"]), { code: 0, out: "removed 1 finished runs older than 5 days\n" });
    assert.equal(loadRecord(paths, old), undefined);
    assert.ok(loadRecord(paths, recent), "a recent run stays");
    assert.ok(loadRecord(paths, oldPaused), "a run that has not finished stays");
    assert.deepEqual(await sous(paths, ["prune", "--days", "5"]), { code: 0, out: "nothing to remove\n" });
  });

  it("with no --days, takes keepDays from config.json, and with neither, says how to call it", async () => {
    const { paths, projectDir } = testHome({ job });
    const old = run(paths, projectDir, 10);
    const usage = await sous(paths, ["prune"]);
    assert.equal(usage.code, 64);
    assert.match(usage.out, /sous prune --days N \(or set keepDays in config\.json\)/);
    assert.ok(loadRecord(paths, old), "a refused prune removes nothing");

    writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder", keepDays: 7 }));
    assert.deepEqual(await sous(paths, ["prune"]), { code: 0, out: "removed 1 finished runs older than 7 days\n" });
    assert.equal(loadRecord(paths, old), undefined);
  });

  // Piece 5. The design says discard --remove deletes the activity file, but discard only removes
  // worktrees. The run's files go through forgetRun and removeRunFiles, which prune calls.
  it("removes a pruned run's activity file with its other files", async () => {
    const { paths, projectDir } = testHome({ job });
    const old = run(paths, projectDir, 10);
    const recent = run(paths, projectDir, 2);
    const activity = (runId: string) => join(paths.records, `${runId}.activity.jsonl`);
    for (const runId of [old, recent]) writeFileSync(activity(runId), `${JSON.stringify({ seq: 1, at: new Date().toISOString(), scope: runId, callIndex: 0, label: "a", kind: "prompt", text: "hi" })}\n`);

    assert.deepEqual(await sous(paths, ["prune", "--days", "5"]), { code: 0, out: "removed 1 finished runs older than 5 days\n" });
    assert.equal(existsSync(activity(old)), false, "the pruned run's activity is gone");
    assert.equal(existsSync(activity(recent)), true, "a kept run keeps its activity");
  });
});

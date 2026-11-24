import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createRun } from "../../src/runs/launch.js";
import { loadRecord, updateRecord } from "../../src/runs/records.js";
import { tick } from "../../src/runs/service.js";
import { plantState, setup } from "./fixture.js";
import { PERSON } from "../../src/testing.js";

// The service's chores that wait for a time: the retry of a resume at the usage limit, the
// removal of old runs, and the removal of merged worktrees. Each test drives tick with its own
// clock.

const job = `export const meta = { name: 'job', description: 'j' }\nreturn 'done'`;
const at = (time: string) => new Date(`2026-11-21T${time}.000Z`);
const minutes = (date: Date, n: number) => new Date(date.getTime() + n * 60_000);
const days = (date: Date, n: number) => new Date(date.getTime() + n * 86_400_000);

/** A run's saved state with the given status, as the engine leaves it. */
function state(runId: string, status: "completed" | "paused", extra: Record<string, unknown> = {}) {
  const now = "2026-11-21T10:00:00.000Z";
  return { runId, status, startedAt: now, updatedAt: now, agents: [], logs: [], phases: [], ...extra };
}

describe("service chores", () => {
  it("resumes a run at the usage limit again only once 15 minutes passed since the last try", () => {
    const { paths, projectDir } = setup({ job });
    const run = createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {} });
    const script = readFileSync(run.file, "utf8");
    plantState(paths, state(run.runId, "paused", { script, pauseReason: "usage_limit", resetHint: "Resets at 2026-11-21T10:30:00.000Z" }));

    // The launch starts no worker, so the run stays paused at the limit, as when a resume
    // hits the limit again.
    const spawned: string[] = [];
    const lines: string[] = [];
    const deps = { log: (line: string) => lines.push(line), notify: () => {} };
    const launch = (_paths: unknown, runId: string, mode: string) => spawned.push(`${mode} ${runId}`);
    tick(paths, launch, { ...deps, now: at("11:00:00") });
    tick(paths, launch, { ...deps, now: at("11:14:00") });
    assert.deepEqual(spawned, [`resume ${run.runId}`], "no new try before 15 minutes");
    tick(paths, launch, { ...deps, now: at("11:15:00") });
    assert.deepEqual(spawned, [`resume ${run.runId}`, `resume ${run.runId}`], "a new try at 15 minutes");
    assert.deepEqual(
      lines.filter((line) => line.startsWith("resumed")),
      [`resumed run ${run.runId} (usage_limit)`, `resumed run ${run.runId} (usage_limit)`],
    );
  });

  it("removes the finished runs older than keepDays, at most once an hour, and none without keepDays", () => {
    const { paths, projectDir } = setup({ job });
    const start = at("12:00:00");
    const run = (status: "completed" | "paused", createdAt: Date) => {
      const record = createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {} });
      updateRecord(paths, record.runId, { createdAt: createdAt.toISOString() });
      plantState(paths, state(record.runId, status, status === "paused" ? { pauseReason: "requested" } : {}));
      return record.runId;
    };
    const old = run("completed", days(start, -10));
    const recent = run("completed", days(start, -1));
    const oldPaused = run("paused", days(start, -10));
    const lines: string[] = [];
    const deps = { log: (line: string) => lines.push(line), notify: () => {} };
    const launch = () => {};

    tick(paths, launch, { ...deps, now: minutes(start, -120) });
    assert.ok(loadRecord(paths, old), "without keepDays, no run is removed");

    writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder", keepDays: 7 }));
    tick(paths, launch, { ...deps, now: start });
    assert.equal(loadRecord(paths, old), undefined, "the old finished run is gone");
    assert.ok(loadRecord(paths, recent), "a recent run stays");
    assert.ok(loadRecord(paths, oldPaused), "an old run that has not finished stays");
    assert.deepEqual(lines.filter((line) => line.startsWith("pruned")), ["pruned 1 finished runs older than 7 days"]);

    // A run that becomes old waits for the next hour.
    updateRecord(paths, recent, { createdAt: days(start, -9).toISOString() });
    tick(paths, launch, { ...deps, now: minutes(start, 59) });
    assert.ok(loadRecord(paths, recent), "less than an hour after the last pass");
    tick(paths, launch, { ...deps, now: minutes(start, 61) });
    assert.equal(loadRecord(paths, recent), undefined, "more than an hour after the last pass");
    assert.ok(loadRecord(paths, oldPaused));
  });

  it("removes the worktrees of finished runs whose branch is merged, at most once an hour", () => {
    const { paths, projectDir } = setup({ job }, { defaultPlace: "worktree" });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
    // A finished run with no commit on its branch counts as merged.
    const finished = () => {
      const record = createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {} });
      plantState(paths, state(record.runId, "completed"));
      return { worktree: record.worktree!, dir: realpathSync(record.worktree!) };
    };
    const first = finished();
    const lines: string[] = [];
    const deps = { log: (line: string) => lines.push(line), notify: () => {} };
    const launch = () => {};
    const start = at("12:00:00");

    tick(paths, launch, { ...deps, now: start });
    assert.equal(existsSync(first.worktree), false);
    assert.deepEqual(lines.filter((line) => line.startsWith("removed")), [`removed worktree ${first.dir} (merged)`]);

    const second = finished();
    tick(paths, launch, { ...deps, now: minutes(start, 59) });
    assert.equal(existsSync(second.worktree), true, "less than an hour after the last pass");
    tick(paths, launch, { ...deps, now: minutes(start, 61) });
    assert.equal(existsSync(second.worktree), false, "more than an hour after the last pass");
    assert.deepEqual(lines.filter((line) => line.startsWith("removed")), [
      `removed worktree ${first.dir} (merged)`,
      `removed worktree ${second.dir} (merged)`,
    ]);
  });
});

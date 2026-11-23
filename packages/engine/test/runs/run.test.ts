import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ensureHome, homePaths, type HomePaths } from "../../src/runs/home.js";
import { workflowProjectPaths } from "../../src/runs/persistence/project-paths.js";
import type { StoreFs } from "../../src/runs/store.js";
import { listRuns, stateOf, verdictOf } from "../../src/runs/view.js";

// The runs are planted with raw writes, the way the worker and the engine leave them.

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** A pid that no process has now: a child that already ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

interface Home {
  paths: HomePaths;
  /** The engine's folder for orc's runs. */
  engine: string;
  legacy: string;
}

function home(): Home {
  const root = mkdtempSync(join(tmpdir(), "engine-run-"));
  const paths = ensureHome(homePaths(join(root, "home")));
  const { runsDir, legacyRunsDir } = workflowProjectPaths(paths.home, { persistenceRoot: paths.runs });
  mkdirSync(runsDir, { recursive: true });
  return { paths, engine: runsDir, legacy: legacyRunsDir };
}

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

function plantRecord({ paths }: Home, runId: string, minutesAgo: number, pid?: number): void {
  writeJson(join(paths.records, `${runId}.json`), {
    runId,
    workflow: "build",
    file: "/nonexistent/build.js",
    args: {},
    place: "folder",
    cwd: paths.home,
    projectDir: paths.home,
    priority: "user",
    origin: "cli",
    createdAt: at(minutesAgo),
    ...(pid === undefined ? {} : { pid }),
  });
}

function stateText(runId: string, minutesAgo: number, extra: Record<string, unknown>): string {
  return JSON.stringify({ runId, workflowName: "build", script: "return 1", phases: [], agents: [], logs: [], startedAt: at(minutesAgo), updatedAt: at(minutesAgo), ...extra });
}

function plantQuestion({ paths }: Home, runId: string): void {
  writeJson(join(paths.inbox, `${runId}--0.json`), { id: `${runId}--0`, runId, scope: runId, callIndex: 0, hash: "h", workflow: "build", prompt: "Ship it?", kind: "confirm", breakpoint: false, askedAt: at(1) });
}

/** A store fs that notes each call. */
function counting(): { fs: StoreFs; reads: string[]; listed: string[]; checked: string[] } {
  const reads: string[] = [];
  const listed: string[] = [];
  const checked: string[] = [];
  const fs = {
    existsSync: (file: string) => (checked.push(String(file)), existsSync(file)),
    readdirSync: (dir: string) => (listed.push(String(dir)), readdirSync(dir)),
    readFileSync: (file: string, encoding: BufferEncoding) => (reads.push(String(file)), readFileSync(file, encoding)),
  } as unknown as StoreFs;
  return { fs, reads, listed, checked };
}

describe("the list of runs", () => {
  // 50 runs: finished, failed, at the limit, left running by a worker that died, and paused at
  // a question. Two have a live worker: this process. One of them asks.
  const kinds = ["completed", "failed", "limit", "dead", "paused"] as const;
  const id = (i: number) => `run-${String(i).padStart(2, "0")}`;
  const asking = id(7);
  const live = id(12);
  const plant50 = () => {
    const planted = home();
    const gone = deadPid();
    for (let i = 0; i < 50; i++) {
      const runId = id(i);
      const ago = 100 - i;
      const kind = kinds[i % kinds.length]!;
      const alive = runId === asking || runId === live;
      plantRecord(planted, runId, ago, alive ? process.pid : kind === "dead" ? gone : undefined);
      const extra: Record<string, unknown> = alive
        ? { status: "running" }
        : kind === "completed" ? { status: "completed", result: "done" }
        : kind === "failed" ? { status: "failed", reason: "it broke" }
        : kind === "limit" ? { status: "paused", pauseReason: "usage_limit" }
        : kind === "dead" ? { status: "running" }
        : { status: "paused", pauseReason: "checkpoint_required" };
      writeFileSync(join(planted.engine, `${runId}.json`), stateText(runId, ago, extra));
      writeFileSync(join(planted.engine, `${runId}.json.bak`), stateText(runId, ago, extra));
    }
    plantQuestion(planted, asking);
    return planted;
  };

  it("reads each of 50 states once, and lists the engine folder once", () => {
    const planted = plant50();
    const { fs, reads, listed, checked } = counting();
    const runs = listRuns(planted.paths, { fs });
    assert.equal(runs.length, 50);
    assert.equal(reads.length, 50, "one read per state");
    assert.deepEqual([...reads].sort(), Array.from({ length: 50 }, (_, i) => join(planted.engine, `${id(i)}.json`)));
    assert.deepEqual(listed, [planted.engine], "the legacy folder does not exist, so only the engine folder is listed");
    assert.deepEqual(checked, [planted.engine, planted.legacy], "no file is checked one by one");

    assert.deepEqual(runs.map((run) => run.runId), Array.from({ length: 50 }, (_, i) => id(49 - i)), "newest first");
    const word = (runId: string) => runs.find((run) => run.runId === runId)!.word;
    assert.equal(word(id(0)), "completed");
    assert.equal(word(id(1)), "failed");
    assert.equal(word(id(2)), "paused: limit");
    assert.equal(word(id(3)), "interrupted");
    assert.equal(word(id(4)), "paused: asks");
    assert.equal(word(asking), "asks");
    assert.equal(word(live), "running");
    const dead = runs.find((run) => run.runId === id(3))!;
    assert.deepEqual(dead.saved, { status: "paused", pauseReason: "interrupted" }, "shown as orc resume saves it");
    assert.equal(dead.exit, 2);
    assert.deepEqual(runs.find((run) => run.runId === asking)!.questions.map((q) => q.id), [`${asking}--0`]);
    assert.ok(runs.filter((run) => run.runId !== asking).every((run) => run.questions.length === 0));
  });

  it("reads only the states of the runs it shows", () => {
    const planted = plant50();
    const { fs, reads } = counting();
    const runs = listRuns(planted.paths, { limit: 20, fs });
    assert.deepEqual(runs.map((run) => run.runId), Array.from({ length: 20 }, (_, i) => id(49 - i)));
    assert.deepEqual([...reads].sort(), Array.from({ length: 20 }, (_, i) => join(planted.engine, `${id(30 + i)}.json`)));
  });

  it("says of each run what a read of that run alone says", () => {
    const planted = plant50();
    for (const run of listRuns(planted.paths)) {
      const state = stateOf(planted.paths, run.record);
      const { questions, saved, runId, record, ...verdict } = run;
      assert.deepEqual(verdict, verdictOf(planted.paths, record, state), runId);
      assert.equal(saved?.status, state?.status, runId);
      assert.equal(saved?.pauseReason, state?.pauseReason, runId);
    }
  });

  it("costs no read for a run with no state, and falls back to the copy of a broken one", () => {
    const planted = home();
    plantRecord(planted, "run-none", 3);
    plantRecord(planted, "run-broken", 2);
    plantRecord(planted, "run-good", 1);
    writeFileSync(join(planted.engine, "run-broken.json"), "{ half a write");
    writeFileSync(join(planted.engine, "run-broken.json.bak"), stateText("run-broken", 2, { status: "completed" }));
    writeFileSync(join(planted.engine, "run-good.json"), stateText("run-good", 1, { status: "failed" }));
    const { fs, reads } = counting();
    const runs = listRuns(planted.paths, { fs });
    assert.deepEqual(runs.map((run) => [run.runId, run.word]), [["run-good", "failed"], ["run-broken", "completed"], ["run-none", "not started"]]);
    assert.deepEqual(reads, [join(planted.engine, "run-good.json"), join(planted.engine, "run-broken.json"), join(planted.engine, "run-broken.json.bak")]);
  });
});

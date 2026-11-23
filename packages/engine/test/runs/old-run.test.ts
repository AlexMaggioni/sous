import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { HomePaths } from "../../src/runs/home.js";
import { olderSave } from "../../src/older-save.js";
import { loadRecord, type RunRecord } from "../../src/runs/records.js";
import { forgetRun, listRuns, pruneRuns, rerunRun, resumeRun, runDetail } from "../../src/runs/run.js";
import { tick } from "../../src/runs/service.js";
import { runWorker } from "../../src/runs/worker.js";
import { workflowProjectPaths } from "../../src/runs/persistence/project-paths.js";
import type { PersistedRunState } from "../../src/runs/persistence/run-persistence.js";
import { heldRunner, layout, plantState, setup } from "./fixture.js";

// A run of the workflow "two", which runs the steps "first" and "second". Its worker died while
// "second" ran, and it holds the lock that worker left; its pids are __PID__. The fixture holds
// the run's record, its workflows, its state and its event log. Its state has today's shape.
const DEAD = join(import.meta.dirname, "..", "fixtures", "old-dead-run.json");

interface OldRun {
  record: { runId: string };
  workflows: Record<string, string>;
  state: PersistedRunState;
  events: string;
  lock?: { runPath: string };
}

/** A pid that no process has now: a child that already ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

/** The dead run's state, with `edit` applied. */
function deadState(edit: (state: PersistedRunState) => void = () => {}): PersistedRunState {
  const state = (JSON.parse(readFileSync(DEAD, "utf8")) as OldRun).state;
  edit(state);
  return state;
}

/** Plant the dead run in a new home with raw writes, as the old code left its files. `edit`
 *  changes its state first. */
function plantOldRun(file: string, edit: (state: PersistedRunState) => void = () => {}): { paths: HomePaths; runId: string } {
  const text = readFileSync(file, "utf8").replaceAll('"__PID__"', String(deadPid()));
  const fixture = JSON.parse(text) as OldRun;
  edit(fixture.state);
  const { paths, projectDir } = setup({ two: fixture.workflows.two! });
  const root = dirname(projectDir);
  const place = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll("__ROOT__", root)) as T;
  const runId = fixture.record.runId;
  writeFileSync(join(paths.records, `${runId}.json`), JSON.stringify(place(fixture.record), null, 2));
  writeFileSync(join(paths.records, `${runId}.workflows`), JSON.stringify(fixture.workflows));
  plantState(paths, place(fixture.state), place(fixture.events));
  if (fixture.lock) {
    // The engine's folder name comes from the home's path, so the lock names the new one.
    const { runsDir } = workflowProjectPaths(paths.home, { persistenceRoot: paths.runs });
    writeFileSync(join(runsDir, `${runId}.lock`), JSON.stringify({ ...place(fixture.lock), runPath: join(runsDir, `${runId}.json`) }, null, 2));
  }
  return { paths, runId };
}

/** The dead run as older code saved it: a step in its journal with no call row. */
const olderShape = (state: PersistedRunState) => {
  state.calls = [];
};

/** The call rows as the last release saved them for a run that reused a step with the resume
 *  option: a replay row that names the marker its source step carried. */
const replayMarker = (state: PersistedRunState) => {
  state.calls = state.calls!.map((call) => ({
    ...call,
    origin: "journal-replay",
    replay: { sourceRunId: "earlier-run", recordedIndex: 0, match: "path-hash", sourceResumeSafety: "declared-read-only" },
  }) as typeof call);
};

const refusal = (runId: string) =>
  `${runId} was saved by an older orc, and this orc cannot resume it. orc rerun ${runId} starts it again, and orc stop ${runId} ends it.`;

describe("a run saved by older code", () => {
  it("shows in orc list as its state says", () => {
    const { paths, runId } = plantOldRun(DEAD, olderShape);
    const [run] = listRuns(paths);
    assert.equal(run?.runId, runId);
    assert.equal(run?.word, "interrupted");
    assert.deepEqual(run?.resume, { ok: false, why: "older" });
    assert.deepEqual(run?.reuse, { ok: false, why: "older" });
  });

  it("shows in orc show with its steps", () => {
    const { paths, runId } = plantOldRun(DEAD, olderShape);
    const detail = runDetail(paths, runId);
    assert.equal(detail.word, "interrupted");
    assert.deepEqual(detail.steps.map((step) => step.label), ["first", "second"]);
  });

  it("orc resume refuses it, says why and what to do instead, and starts no worker", () => {
    const { paths, runId } = plantOldRun(DEAD, olderShape);
    const launched: string[] = [];
    assert.throws(() => resumeRun(paths, (_paths, id) => launched.push(id), runId), { message: refusal(runId) });
    assert.deepEqual(launched, []);
  });

  it("orc rerun --reuse refuses it and points to a rerun without --reuse", () => {
    const { paths, runId } = plantOldRun(DEAD, olderShape);
    const launched: string[] = [];
    assert.throws(() => rerunRun(paths, (_paths, id) => launched.push(id), runId, { place: "folder", reuse: true }), {
      message: `${runId} was saved by an older orc, and this orc cannot reuse its steps. orc rerun ${runId} without --reuse starts it again.`,
    });
    assert.deepEqual(launched, []);
  });

  it("orc resume refuses a run with the resume safety marker of the last release on a replay row", () => {
    const { paths, runId } = plantOldRun(DEAD, replayMarker);
    const launched: string[] = [];
    assert.throws(() => resumeRun(paths, (_paths, id) => launched.push(id), runId), { message: refusal(runId) });
    assert.deepEqual(launched, []);
  });

  it("the service neither resumes it nor tells of it", () => {
    const { paths, runId } = plantOldRun(DEAD, olderShape);
    const launched: string[] = [];
    const told: string[] = [];
    tick(paths, (_paths, id) => launched.push(id), { notify: (title) => told.push(title), log: (line) => told.push(line), now: new Date() });
    assert.deepEqual(launched, []);
    assert.deepEqual(told.filter((line) => line.includes(runId) || line.includes("cut off")), []);
  });

  it("a worker started on it anyway runs no step", async () => {
    const { paths, runId } = plantOldRun(DEAD, olderShape);
    const { runner, calls } = heldRunner(() => "two");
    await assert.rejects(runWorker(runId, "resume", { paths, inner: runner, pollMs: 20, log: () => {} }), /cannot resume/);
    assert.deepEqual(calls, []);
  });
});

describe("olderSave", () => {
  it("passes the dead run's state, which has today's shape", () => {
    assert.equal(olderSave(deadState()), undefined);
  });

  // Today's code ignores this marker on a call row, so the run resumes as it is.
  it("passes a state with a resume safety marker on a call row, which nothing reads", () => {
    const state = deadState((s) => {
      s.calls = s.calls!.map((call) => ({ ...call, resumeSafety: "declared-read-only" }) as typeof call);
    });
    assert.equal(olderSave(state), undefined);
  });

  const shapes: Record<string, (state: PersistedRunState) => void> = {
    "a step in the journal with no call row": olderShape,
    "inputs hashes of format 1": (state) => {
      state.runtime = { ...state.runtime!, inputsFormat: 1 };
    },
    "the isolation mode of an older engine": (state) => {
      state.executionMode = { kind: "isolation", baselineRunId: "older-run" };
    },
    "root rows under the id of the run it came from, as engine 0.23 saved them": (state) => {
      state.journal = state.journal!.map((entry) => ({ ...entry, scope: "older-run" }));
      state.calls = state.calls!.map((call) => ({ ...call, scope: "older-run" }));
    },
    "a budget field on a call row": (state) => {
      state.calls = state.calls!.map((call) => ({ ...call, budgetDebit: 1 }) as typeof call);
    },
    "a resume safety marker on a replay row": replayMarker,
    "a resume safety marker on a replay row in its seed": (state) => {
      replayMarker(state);
      state.resumeSeed = {
        format: "identity-v1",
        sourceRunId: "earlier-run",
        candidates: [{ sourceRunId: "earlier-run", recordedIndex: 0, entry: state.journal![0], call: state.calls![0] }],
      } as unknown as PersistedRunState["resumeSeed"];
    },
    "an injected checkpoint answer in its seed": (state) => {
      state.resumeSeed = {
        format: "identity-v1",
        sourceRunId: "older-run",
        candidates: [],
        checkpointInjections: [{ sourceRunId: "older-run", recordedIndex: 0, hash: "h", inputsHash: "i", decision: true, checkpointDecision: "explicit-v1" }],
      } as unknown as PersistedRunState["resumeSeed"];
    },
    "a pending checkpoint with a retired answer policy": (state) => {
      state.checkpointContext = { default: false } as unknown as PersistedRunState["checkpointContext"];
    },
  };
  for (const [shape, edit] of Object.entries(shapes)) {
    it(`tells a state with ${shape}`, () => {
      assert.equal(typeof olderSave(deadState(edit)), "string");
    });
  }
});

describe("forget and prune on an old run's files", () => {
  /** The run's own files and the engine's project folders, by the names layout gives them. */
  const runFiles = (paths: HomePaths, record: RunRecord) => layout(paths, record.runId, record.cwd).filter((line) => line.includes("<"));
  // Thirty days after the dead run started.
  const later = new Date(Date.parse("2026-11-23T04:27:15.896Z") + 30 * 86_400_000);

  it("forgetRun removes every file of a run whose worker died", () => {
    const { paths, runId } = plantOldRun(DEAD);
    const record = loadRecord(paths, runId)!;
    assert.deepEqual(runFiles(paths, record), [
      "home/records/<id>.json",
      "home/records/<id>.workflows",
      "home/runs/projects/<home key>/",
      "home/runs/projects/<home key>/runs/",
      "home/runs/projects/<home key>/runs/<id>.events.jsonl",
      "home/runs/projects/<home key>/runs/<id>.json",
      "home/runs/projects/<home key>/runs/<id>.lock",
    ]);
    forgetRun(paths, record);
    assert.deepEqual(runFiles(paths, record), ["home/runs/projects/<home key>/", "home/runs/projects/<home key>/runs/"]);
  });

  it("pruneRuns keeps a run whose worker died, since the run did not finish", () => {
    const { paths, runId } = plantOldRun(DEAD);
    const record = loadRecord(paths, runId)!;
    const before = runFiles(paths, record);
    assert.deepEqual(pruneRuns(paths, 7, later), []);
    assert.deepEqual(runFiles(paths, record), before);
  });
});

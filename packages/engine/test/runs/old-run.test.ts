import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { HomePaths } from "../../src/runs/home.js";
import type { Question } from "../../src/runs/inbox.js";
import { loadRecord, type RunRecord } from "../../src/runs/records.js";
import { answerQuestion, forgetRun, listRuns, pruneRuns, runQuestions } from "../../src/runs/run.js";
import { tick } from "../../src/runs/service.js";
import { readEventsAfter, readState } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import { workflowProjectPaths } from "../../src/runs/persistence/project-paths.js";
import type { PersistedRunState } from "../../src/runs/persistence/run-persistence.js";
import { heldRunner, layout, NO_CLI, plantState, setup } from "./fixture.js";

// A run the code before step 4 started. Its sh and js steps went to the steps module as agent
// calls with model "exec" and finished; its agent step failed, so the run paused. The fixture
// holds its record and the state the engine saved.
const FIXTURE = join(import.meta.dirname, "..", "fixtures", "old-code-steps-run.json");
// A run the code before the typed breakpoint purpose paused at a breakpoint. The fixture holds
// its record, its state, its event log and the open question, whose file says
// `breakpoint: true`.
const BREAKPOINT = join(import.meta.dirname, "..", "fixtures", "old-breakpoint-run.json");
// Three runs of the workflow "two", which runs the steps "first" and "second". Each fixture holds
// the run's record, its workflows, its state and its event log. One paused at the usage limit
// and saved only its reset hint. One paused at a failed step, and its paused event says
// "requested". One had a worker that died while "second" ran, and it holds the lock that worker
// left; its pids are __PID__.
const LIMIT = join(import.meta.dirname, "..", "fixtures", "old-limit-run.json");
const FAILED_STEP = join(import.meta.dirname, "..", "fixtures", "old-failed-step-run.json");
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

/** Plant an old run of "two" in a new home with raw writes, as the old code left its files. */
function plantOldRun(file: string): { paths: HomePaths; runId: string } {
  const text = readFileSync(file, "utf8").replaceAll('"__PID__"', String(deadPid()));
  const fixture = JSON.parse(text) as OldRun;
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

describe("a run started by the old code", () => {
  it("resumes on the new code and replays its finished code steps without running them", async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      record: { runId: string };
      workflows: Record<string, string>;
      state: PersistedRunState;
    };
    const { paths, projectDir } = setup({ old_journal: fixture.workflows.old_journal! });
    const root = dirname(projectDir);
    const place = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll("__ROOT__", root)) as T;
    const runId = fixture.record.runId;
    writeFileSync(join(paths.records, `${runId}.json`), JSON.stringify(place(fixture.record), null, 2));
    writeFileSync(join(paths.records, `${runId}.workflows`), JSON.stringify(fixture.workflows));
    plantState(paths, place(fixture.state));
    // The old run's sh step appended this line. A second run of it would add another.
    const marker = join(projectDir, "marker.txt");
    writeFileSync(marker, "ran\n");

    const { runner, calls } = heldRunner(() => "a line");
    const lines: string[] = [];
    const result = await runWorker(runId, "resume", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });

    assert.equal(readFileSync(marker, "utf8"), "ran\n", "the sh step did not run again");
    assert.deepEqual(calls.map((call) => call.label), ["writer"], "only the agent step reached the runner");
    assert.equal(result?.status, "completed", lines.join("\n"));
    assert.deepEqual(JSON.parse(JSON.stringify(result?.result)), { first: "first", sum: 42, text: "a line" });
    assert.equal(loadRecord(paths, runId)?.runId, runId);
  });

  // A hash that changed would leave the worker waiting on a new question, so the test has a limit.
  it("resumes from a breakpoint and takes the answer given while it was paused", { timeout: 15_000 }, async () => {
    const fixture = JSON.parse(readFileSync(BREAKPOINT, "utf8")) as {
      record: { runId: string };
      workflows: Record<string, string>;
      state: PersistedRunState;
      question: Question;
      events: string;
    };
    const { paths, projectDir } = setup({ checked: fixture.workflows.checked! });
    const root = dirname(projectDir);
    const place = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll("__ROOT__", root)) as T;
    const runId = fixture.record.runId;
    writeFileSync(join(paths.records, `${runId}.json`), JSON.stringify(place(fixture.record), null, 2));
    writeFileSync(join(paths.records, `${runId}.workflows`), JSON.stringify(fixture.workflows));
    plantState(paths, place(fixture.state), place(fixture.events));
    writeFileSync(join(paths.inbox, `${fixture.question.id}.json`), JSON.stringify(fixture.question, null, 2));

    const [question] = runQuestions(paths, runId);
    assert.equal(question?.breakpoint, true, "the old question file still reads as a breakpoint");
    const approve = answerQuestion(paths, question!, { via: "approve", text: "" });
    assert.deepEqual(approve, { answered: true, running: false });

    const { runner, calls } = heldRunner(() => "a new plan");
    const lines: string[] = [];
    const result = await runWorker(runId, "resume", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });

    assert.equal(result?.status, "completed", lines.join("\n"));
    assert.equal(result?.result, "the plan", "the breakpoint took the answer and returned the step's result");
    assert.deepEqual(calls, [], "the finished step did not run again");
    assert.deepEqual(runQuestions(paths, runId), [], "the answer closed the question");
  });

  it("reads a limit pause saved with only its reset hint, and the service resumes it 30 seconds after the reset", () => {
    const { paths, runId } = plantOldRun(LIMIT);
    const [run] = listRuns(paths);
    assert.equal(run?.word, "paused: limit");
    assert.equal(readState(paths, runId)?.resetAt, undefined, "the old state has no typed reset time");

    const reset = Date.parse("2026-11-21T10:30:00.000Z");
    const spawned: string[] = [];
    const deps = { spawn: (id: string) => spawned.push(id), notify: () => {}, log: () => {} };
    tick(paths, NO_CLI, { ...deps, now: new Date(reset + 29_000) });
    assert.deepEqual(spawned, [], "the run waits until 30 seconds after the reset");
    tick(paths, NO_CLI, { ...deps, now: new Date(reset + 30_000) });
    assert.deepEqual(spawned, [runId]);
  });

  it("reads a run paused at a failed step whose event says requested, and resumes it", async () => {
    const { paths, runId } = plantOldRun(FAILED_STEP);
    const [run] = listRuns(paths);
    assert.equal(run?.word, "paused: failed step");
    const reasons: unknown[] = [];
    readEventsAfter(paths, runId, 0, ({ event }) => event.type === "paused" && reasons.push(event.reason));
    assert.deepEqual(reasons, ["requested"], "the old event log still reads");

    const { runner, calls } = heldRunner(() => "two");
    const lines: string[] = [];
    const result = await runWorker(runId, "resume", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });
    assert.equal(result?.status, "completed", lines.join("\n"));
    assert.equal(result?.result, "one two");
    assert.deepEqual(calls.map((call) => call.label), ["second"], "the finished step did not run again");
  });

  it("reads a run whose worker died as interrupted, and resumes it", async () => {
    const { paths, runId } = plantOldRun(DEAD);
    const [run] = listRuns(paths);
    assert.equal(run?.word, "interrupted");
    assert.equal(run?.exit, 2);
    assert.equal(readState(paths, runId)?.status, "running", "the read left the state as the worker left it");

    const { runner, calls } = heldRunner(() => "two");
    const lines: string[] = [];
    const result = await runWorker(runId, "resume", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });
    assert.equal(result?.status, "completed", lines.join("\n"));
    assert.equal(result?.result, "one two");
    assert.deepEqual(calls.map((call) => call.label), ["second"], "the finished step did not run again");
  });
});

describe("forget, prune and resume on an old run's files", () => {
  /** The run's own files and the engine's project folders, by the names layout gives them. */
  const runFiles = (paths: HomePaths, record: RunRecord) => layout(paths, record.runId, record.cwd).filter((line) => line.includes("<"));
  // Thirty days after the dead run started.
  const later = new Date(Date.parse("2026-11-23T04:27:15.896Z") + 30 * 86_400_000);

  it("forgetRun removes every file of a run whose worker died, but the home's project.json", () => {
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
    assert.deepEqual(runFiles(paths, record), [
      "home/runs/projects/<home key>/",
      "home/runs/projects/<home key>/project.json",
      "home/runs/projects/<home key>/runs/",
    ]);
  });

  it("pruneRuns keeps a run whose worker died, since the run did not finish", () => {
    const { paths, runId } = plantOldRun(DEAD);
    const record = loadRecord(paths, runId)!;
    const before = runFiles(paths, record);
    assert.deepEqual(pruneRuns(paths, 7, later), []);
    assert.deepEqual(runFiles(paths, record), before);
  });

  it("resumes a run next to a .script.js and a .lineage the old code left, and the leftovers do no harm", async () => {
    const { paths, runId } = plantOldRun(FAILED_STEP);
    const { runsDir } = workflowProjectPaths(paths.home, { persistenceRoot: paths.runs });
    const state = JSON.parse(readFileSync(join(runsDir, `${runId}.json`), "utf8")) as PersistedRunState;
    writeFileSync(join(runsDir, `${runId}.script.js`), state.script);
    // The marker an older engine wrote when it forgot a run of the same id.
    writeFileSync(join(runsDir, `${runId}.lineage`), `${JSON.stringify({ runId, deletedAt: "2026-11-23T06:21:32.519Z" }, null, 2)}\n`);

    const { runner, calls } = heldRunner(() => "two");
    const lines: string[] = [];
    const result = await runWorker(runId, "resume", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });
    assert.equal(result?.status, "completed", lines.join("\n"));
    assert.equal(result?.result, "one two");
    assert.deepEqual(calls.map((call) => call.label), ["second"], "the finished step did not run again");
    assert.equal(existsSync(join(runsDir, `${runId}.lineage`)), false, "saving the state removed the old .lineage");
  });
});

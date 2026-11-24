import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HomePaths } from "../../src/runs/home.js";
import type { Question } from "../../src/runs/inbox.js";
import { saveRecord, type RunRecord } from "../../src/runs/records.js";
import { questionFile } from "../../src/runs/store.js";
import { plantState, setup } from "./fixture.js";

// Piece 4, sous status. homeStatus reads a home and says what needs the person, what runs, what
// waits on its own and what finished. statusLine is the one line a session start prints. Each home
// here is built from records and states, the way the worker leaves them, with no worker.
// status.ts is loaded inside each test, so a missing module fails each test on its own.

const statusModule = () => import("../../src/runs/status.js");

/** The time every home here is read at. */
const NOW = new Date("2026-11-24T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/** A run's record, `minutesAgo` old. A `pid` of this process makes its worker alive. */
function plantRecord(paths: HomePaths, projectDir: string, runId: string, minutesAgo: number, extra: Partial<RunRecord> = {}): void {
  saveRecord(paths, {
    runId,
    workflow: "build",
    file: join(projectDir, ".sous", "workflows", "build.js"),
    args: {},
    place: "folder",
    cwd: projectDir,
    projectDir,
    priority: "user",
    origin: "cli",
    createdAt: ago(minutesAgo),
    ...extra,
  });
}

/** A run's saved state. */
function plantRun(paths: HomePaths, runId: string, minutesAgo: number, extra: Record<string, unknown>): void {
  plantState(paths, { runId, workflowName: "build", script: "return 1", phases: [], agents: [], logs: [], startedAt: ago(minutesAgo), updatedAt: ago(minutesAgo), status: "running", ...extra } as Parameters<typeof plantState>[1]);
}

/** A run that finished `minutesAgo`. */
function plantFinished(paths: HomePaths, projectDir: string, runId: string, minutesAgo: number): void {
  plantRecord(paths, projectDir, runId, minutesAgo + 5);
  plantRun(paths, runId, minutesAgo + 5, { status: "completed", result: "done", updatedAt: ago(minutesAgo), completedAt: ago(minutesAgo), durationMs: 300_000 });
}

/** A run whose live worker waits at an open select question. */
function plantAsking(paths: HomePaths, projectDir: string, runId: string): Question {
  plantRecord(paths, projectDir, runId, 20, { pid: process.pid });
  plantRun(paths, runId, 20, { status: "running" });
  const question: Question = { id: `${runId}--0`, runId, scope: runId, callIndex: 0, hash: "h0", workflow: "build", prompt: "Which color?", kind: "select", choices: ["red", "blue"], breakpoint: false, askedAt: ago(19) };
  writeFileSync(questionFile(paths, question.id), JSON.stringify(question, null, 2));
  return question;
}

/** A run paused at a usage limit that resets at `resetAt`. Its worker is gone. */
function plantLimited(paths: HomePaths, projectDir: string, runId: string, resetAt: string): void {
  plantRecord(paths, projectDir, runId, 40, { limit: { program: "claude", account: "default", at: ago(2) } });
  plantRun(paths, runId, 2, { status: "paused", pauseReason: "usage_limit", reason: "usage limit reached", resetAt, pausedAt: ago(2) });
}

describe("homeStatus", () => {
  it("puts a run at a question in needsYou, with the question, when it asked and the answer call", async () => {
    const { homeStatus } = await statusModule();
    const { paths, projectDir } = setup();
    const question = plantAsking(paths, projectDir, "run-asking");
    const status = homeStatus(paths, NOW);
    const asking = status.needsYou.filter((entry) => entry.runId === "run-asking");
    assert.equal(asking.length, 1, JSON.stringify(status.needsYou));
    const [entry] = asking;
    assert.equal(entry!.workflow, "build");
    assert.equal(entry!.what, "asks");
    assert.deepEqual(entry!.question, { id: question.id, prompt: "Which color?", answeredBy: "people" });
    assert.equal(entry!.since, question.askedAt);
    assert.ok(entry!.call.startsWith(`sous answer ${question.id} `), `the call answers the question: ${entry!.call}`);
    assert.deepEqual(status.waiting, []);
  });

  it("puts a run paused at a failed step in needsYou, not in waiting", async () => {
    const { homeStatus } = await statusModule();
    const { paths, projectDir } = setup();
    plantRecord(paths, projectDir, "run-failed", 30);
    plantRun(paths, "run-failed", 25, { status: "paused", pauseReason: "step_failed", reason: 'step "tests" failed after 1 try: exited with code 1' });
    const status = homeStatus(paths, NOW);
    const [entry] = status.needsYou;
    assert.equal(status.needsYou.length, 1, JSON.stringify(status.needsYou));
    assert.equal(entry!.runId, "run-failed");
    assert.equal(entry!.what, "paused: failed step");
    assert.equal(typeof entry!.call, "string");
    assert.deepEqual(status.waiting, []);
  });

  it("puts a run paused at a usage limit in waiting, with resumesAt 30 seconds after the reset", async () => {
    const { homeStatus } = await statusModule();
    const { paths, projectDir } = setup();
    plantLimited(paths, projectDir, "run-limit", "2026-11-24T14:00:00.000Z");
    const status = homeStatus(paths, NOW);
    assert.deepEqual(status.waiting, [{ runId: "run-limit", workflow: "build", what: "paused: limit", resumesAt: "2026-11-24T14:00:30.000Z" }]);
    assert.deepEqual(status.needsYou, [], "a run the service resumes by itself does not need the person");
  });

  it("lists the runs that finished in the last 24 hours, and since 3d shows one that finished 30 hours ago", async () => {
    const { homeStatus } = await statusModule();
    const { paths, projectDir } = setup();
    plantFinished(paths, projectDir, "run-recent", 120);
    plantFinished(paths, projectDir, "run-old", 30 * 60);

    const today = homeStatus(paths, NOW);
    assert.deepEqual(today.finished.map((run) => run.runId), ["run-recent"]);
    const [recent] = today.finished;
    assert.equal(recent!.workflow, "build");
    assert.equal(recent!.status, "completed");
    assert.equal(recent!.at, ago(120));

    const longer = homeStatus(paths, NOW, { since: "3d" });
    assert.deepEqual(longer.finished.map((run) => run.runId).sort(), ["run-old", "run-recent"]);
  });

  it("gives empty lists and a stopped service for an empty home", async () => {
    const { homeStatus } = await statusModule();
    const { paths } = setup();
    assert.deepEqual(homeStatus(paths, NOW), { needsYou: [], running: [], waiting: [], finished: [], service: { running: false } });
  });
});

describe("statusLine", () => {
  it("is empty for a home with nothing open", async () => {
    const { statusLine } = await statusModule();
    const empty = setup();
    assert.equal(statusLine(empty.paths, NOW), "");
    const { paths, projectDir } = setup();
    plantFinished(paths, projectDir, "run-recent", 120);
    assert.equal(statusLine(paths, NOW), "", "a finished run needs nothing");
  });

  it("is one line that names sous status when a run asks a question", async () => {
    const { statusLine } = await statusModule();
    const { paths, projectDir } = setup();
    plantAsking(paths, projectDir, "run-asking");
    const line = statusLine(paths, NOW);
    assert.notEqual(line, "");
    assert.equal(line.includes("\n"), false, `one line: ${JSON.stringify(line)}`);
    assert.match(line, /sous status/);
  });
});

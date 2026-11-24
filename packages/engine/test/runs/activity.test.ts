// Piece 5, the activity file. The worker is the only writer of a run's files. It appends each
// step's activity to records/<run>.activity.jsonl, one JSON line per entry, as
// {seq, at, scope, callIndex, label, kind, tool, text}, with text cut at 2,000 characters. A resume
// goes on from the last seq. The tests read the file raw, so they hold whatever module writes it.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HomePaths } from "../../src/runs/home.js";
import { createRun } from "../../src/runs/launch.js";
import { readState } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import { PERSON, fakeRunner } from "../../src/testing.js";
import { quiet, setup } from "./fixture.js";

interface ActivityLine {
  seq: number;
  at: string;
  scope: string;
  callIndex: number;
  label?: string;
  kind: string;
  tool?: string;
  text: string;
}

const FAILS = `export const meta = { name: 'fails', description: 'Prepare, then run a check that fails', place: 'none' }
await sh("echo prepared", { label: "prepare" })
await sh("echo 'disk check failed' >&2; exit 3", { label: "boom" })
return "done"`;

const activityFile = (paths: HomePaths, runId: string) => join(paths.records, `${runId}.activity.jsonl`);

function readActivity(paths: HomePaths, runId: string): ActivityLine[] {
  const file = activityFile(paths, runId);
  assert.ok(existsSync(file), `the worker writes ${file}`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ActivityLine);
}

const run = (paths: HomePaths, runId: string, mode: "start" | "resume") =>
  runWorker(runId, mode, { paths, inner: fakeRunner(() => "ok").runner, pollMs: 20, log: quiet });

describe("piece 5: the worker's activity file", () => {
  it("holds each step's entries in the design's format, numbered from 1", async () => {
    const { paths, projectDir } = setup({ fails: FAILS });
    const { runId } = createRun(paths, { who: PERSON, workflow: "fails", projectDir, inputs: {} });
    await run(paths, runId, "start");
    const lines = readActivity(paths, runId);
    assert.deepEqual(
      lines.map((line) => line.seq),
      lines.map((_, i) => i + 1),
    );
    for (const line of lines) {
      assert.equal(line.scope, runId);
      assert.equal(typeof line.callIndex, "number");
      assert.ok(!Number.isNaN(Date.parse(line.at)), `at is a time: ${line.at}`);
      assert.equal(typeof line.text, "string");
    }
    const boom = lines.filter((line) => line.label === "boom");
    assert.deepEqual(
      boom.map((line) => line.kind),
      ["command", "output"],
    );
    assert.equal(boom[0]!.text, "echo 'disk check failed' >&2; exit 3");
    assert.match(boom[1]!.text, /disk check failed/);
    const prepare = lines.filter((line) => line.label === "prepare");
    assert.equal(prepare.find((line) => line.kind === "command")?.text, "echo prepared");
    assert.match(prepare.find((line) => line.kind === "output")?.text ?? "", /prepared/);
  });

  it("cuts a step's text at 2,000 characters, keeping the end of an output", async () => {
    const long = "p".repeat(5_000);
    const { paths, projectDir } = setup({
      long: `export const meta = { name: 'long', description: 'Long texts', place: 'none' }
await sh("for i in $(seq 1700); do printf 'ab '; done; printf END", { label: "loud" })
await agent('${long}', { label: "wordy" })
return 1`,
    });
    const { runId } = createRun(paths, { who: PERSON, workflow: "long", projectDir, inputs: {} });
    const result = await run(paths, runId, "start");
    assert.equal(result?.status, "completed");
    const lines = readActivity(paths, runId);
    const output = lines.find((line) => line.label === "loud" && line.kind === "output");
    assert.equal(output?.text.length, 2_000);
    assert.ok(output?.text.endsWith("END"), "an output keeps its last characters");
    const prompt = lines.find((line) => line.label === "wordy" && line.kind === "prompt");
    assert.equal(prompt?.text.length, 2_000);
    for (const line of lines) assert.ok(line.text.length <= 2_000, `${line.kind} of ${line.label} is ${line.text.length} long`);
  });

  it("goes on from the last seq after a resume", async () => {
    const { paths, projectDir } = setup({ fails: FAILS });
    const { runId } = createRun(paths, { who: PERSON, workflow: "fails", projectDir, inputs: {} });
    assert.equal((await run(paths, runId, "start"))?.status, "paused");
    const before = readActivity(paths, runId);
    assert.ok(before.length > 0);
    // boom fails again on the resume, and adds its entries after the first ones. A paused resume
    // gives no result, so the state says how it ended.
    await run(paths, runId, "resume");
    assert.equal(readState(paths, runId)?.status, "paused");
    const after = readActivity(paths, runId);
    assert.ok(after.length > before.length, "the resume added entries");
    assert.deepEqual(after.slice(0, before.length), before);
    assert.deepEqual(
      after.map((line) => line.seq),
      after.map((_, i) => i + 1),
    );
    assert.ok(after.slice(before.length).some((line) => line.label === "boom" && line.kind === "command"));
  });
});

describe("piece 5 review: the activity file", () => {
  it("saves a code step's output when the step runs out of time", async () => {
    const { paths, projectDir } = setup({
      slow: `export const meta = { name: 'slow', description: 'A step past its time', place: 'none' }
await sh("echo started; sleep 5", { label: "slow", timeout: 0.5 })
return 1`,
    });
    const { runId } = createRun(paths, { who: PERSON, workflow: "slow", projectDir, inputs: {} });
    assert.equal((await run(paths, runId, "start"))?.status, "paused");
    const slow = readActivity(paths, runId).filter((line) => line.label === "slow");
    assert.deepEqual(slow.map((line) => line.kind), ["command", "output"]);
    assert.match(slow[1]!.text, /started/);
  });

  it("hides credentials and the loaded secrets' values", async () => {
    const secret = "plainwords4242plain";
    const { paths, projectDir } = setup({
      leaks: `export const meta = { name: 'leaks', description: 'Texts with secrets', place: 'none' }
await sh("echo the key is ${secret}; echo password=hunter2", { label: "loud" })
await agent('use ${secret} to log in', { label: "agent" })
return 1`,
    });
    writeFileSync(paths.secrets, `DEPLOY_KEY=${secret}\n`);
    const { runId } = createRun(paths, { who: PERSON, workflow: "leaks", projectDir, inputs: {} });
    assert.equal((await run(paths, runId, "start"))?.status, "completed");
    const lines = readActivity(paths, runId);
    const raw = readFileSync(activityFile(paths, runId), "utf8");
    assert.ok(!raw.includes(secret), "the loaded secret's value is not in the file");
    assert.ok(!raw.includes("hunter2"), "a password is not in the file");
    assert.match(lines.find((line) => line.label === "agent" && line.kind === "prompt")?.text ?? "", /use \[REDACTED\] to log in/);
    assert.match(lines.find((line) => line.label === "loud" && line.kind === "output")?.text ?? "", /password=\[REDACTED\]/);
  });
});

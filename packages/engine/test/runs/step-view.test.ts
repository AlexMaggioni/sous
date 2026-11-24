// Piece 5, sous step and sous log. stepView reads one step of a run: its record in the state, and
// its activity, which the worker saves in records/<run>.activity.jsonl. logAfter reads the run's
// engine events after a seq, in a small vocabulary. The runs here go through the worker with a
// runner of the test's own, so no program runs. step-view.ts is loaded inside each test, so a
// missing module fails each test on its own.

import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HomePaths } from "../../src/runs/home.js";
import { createRun } from "../../src/runs/launch.js";
import { runWorker } from "../../src/runs/worker.js";
import { fakeRunner } from "../../src/testing.js";
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

interface StepView {
  runId: string;
  step: string;
  call: number;
  calls: number;
  status: string;
  kind: "agent" | "exec";
  model?: string;
  startedAt?: string;
  seconds?: number;
  tokens?: number;
  prompt?: string;
  result?: unknown;
  failure?: unknown;
  command?: string;
  output?: string;
  activity: ActivityLine[];
}

interface LogEvent {
  seq: number;
  kind: string;
  [field: string]: unknown;
}

interface StepViewModule {
  stepView(paths: HomePaths, runId: string, label: string, options?: { call?: number; tail?: number; full?: boolean }): StepView;
  logAfter(paths: HomePaths, runId: string, after: number, max?: number): { events: LogEvent[]; after: number; more: boolean };
}

const stepViewModule = async () => (await import("../../src/runs/step-view.js")) as unknown as StepViewModule;

/** The fails fixture of sous's tests: a step that works, then a shell step that exits 3. */
const FAILS = `export const meta = { name: 'fails', description: 'Prepare, then run a check that fails', place: 'none' }
await sh("echo prepared", { label: "prepare" })
await sh("echo 'disk check failed' >&2; exit 3", { label: "boom" })
return "done"`;

/** One label called three times, with a prompt of its own each time. */
const TWICE = `export const meta = { name: 'thrice', description: 'One label, three calls', place: 'none' }
for (let i = 0; i < 3; i++) await agent('go ' + i, { label: 'go' })
return 1`;

/** Run a workflow to its end, or to its pause, and give its id. */
async function ran(paths: HomePaths, projectDir: string, workflow: string): Promise<{ runId: string; status: string | undefined }> {
  const record = createRun(paths, { workflow, projectDir, inputs: {} });
  const result = await runWorker(record.runId, "start", { paths, inner: fakeRunner(() => "ok").runner, pollMs: 20, log: quiet });
  return { runId: record.runId, status: result?.status };
}

const activityFile = (paths: HomePaths, runId: string) => join(paths.records, `${runId}.activity.jsonl`);
const readActivity = (paths: HomePaths, runId: string): ActivityLine[] =>
  readFileSync(activityFile(paths, runId), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ActivityLine);

/** A failure may be a string or an object with a message. Its text either way. */
const failureText = (failure: unknown) => (typeof failure === "string" ? failure : JSON.stringify(failure ?? ""));

describe("piece 5: stepView", () => {
  it("shows a failed shell step's command, the tail of its output and its failure", async () => {
    const { stepView } = await stepViewModule();
    const { paths, projectDir } = setup({ fails: FAILS });
    const { runId, status } = await ran(paths, projectDir, "fails");
    assert.equal(status, "paused");
    const view = stepView(paths, runId, "boom");
    assert.equal(view.runId, runId);
    assert.equal(view.step, "boom");
    assert.equal(view.kind, "exec");
    assert.deepEqual([view.call, view.calls], [1, 1]);
    assert.match(view.status, /error|fail/);
    assert.equal(view.command, "echo 'disk check failed' >&2; exit 3");
    assert.match(view.output ?? "", /disk check failed/);
    assert.match(failureText(view.failure), /code 3/);
    assert.match(failureText(view.failure), /disk check failed/);
    // Decision 9: reply data never uses the key error, since reply() throws on it.
    assert.equal("error" in view, false);
    // The activity the worker saved for the step: its command, then its output.
    const kinds = view.activity.map((line) => line.kind);
    assert.ok(kinds.includes("command"), kinds.join(" "));
    assert.ok(kinds.includes("output"), kinds.join(" "));
    assert.ok(view.activity.every((line) => line.label === "boom"));
  });

  it("shows the last call of a label that ran three times, and any call asked for", async () => {
    const { stepView } = await stepViewModule();
    const { paths, projectDir } = setup({ thrice: TWICE });
    const { runId, status } = await ran(paths, projectDir, "thrice");
    assert.equal(status, "completed");
    const last = stepView(paths, runId, "go");
    assert.equal(last.kind, "agent");
    assert.deepEqual([last.call, last.calls], [3, 3]);
    assert.match(last.prompt ?? "", /go 2/);
    assert.equal(last.tokens, 3);
    const first = stepView(paths, runId, "go", { call: 1 });
    assert.deepEqual([first.call, first.calls], [1, 3]);
    assert.match(first.prompt ?? "", /go 0/);
  });

  it("gives the last 5 activity entries for tail 5, and 20 by default", async () => {
    const { stepView } = await stepViewModule();
    const { paths, projectDir } = setup({ fails: FAILS });
    const { runId } = await ran(paths, projectDir, "fails");
    const lines = readActivity(paths, runId);
    const boom = lines.find((line) => line.label === "boom");
    assert.ok(boom, "the worker saved activity for boom");
    // Thirty more entries for the same call, as a long agent step leaves them.
    let seq = Math.max(...lines.map((line) => line.seq));
    for (let i = 0; i < 30; i++) {
      seq += 1;
      appendFileSync(activityFile(paths, runId), `${JSON.stringify({ ...boom, seq, kind: "note", tool: undefined, text: `n${i}` })}\n`);
    }
    const five = stepView(paths, runId, "boom", { tail: 5 });
    assert.deepEqual(
      five.activity.map((line) => line.text),
      ["n25", "n26", "n27", "n28", "n29"],
    );
    const plain = stepView(paths, runId, "boom");
    assert.equal(plain.activity.length, 20);
    assert.equal(plain.activity.at(-1)?.text, "n29");
  });
});

describe("piece 5: logAfter", () => {
  it("gives the events after a seq in the small vocabulary, with the last seq as after", async () => {
    const { logAfter } = await stepViewModule();
    const { paths, projectDir } = setup({ fails: FAILS });
    const { runId } = await ran(paths, projectDir, "fails");
    const all = logAfter(paths, runId, 0);
    assert.equal(all.more, false);
    assert.ok(all.events.length > 0);
    const vocabulary = ["step-start", "step-end", "asks", "answered", "paused", "resumed", "ended", "tell", "note"];
    for (const event of all.events) assert.ok(vocabulary.includes(event.kind), `${event.kind} is not in the vocabulary`);
    const seqs = all.events.map((event) => event.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
    assert.equal(all.after, seqs.at(-1));
    const kinds = all.events.map((event) => event.kind);
    assert.ok(kinds.includes("step-start") && kinds.includes("step-end") && kinds.includes("paused"), kinds.join(" "));
    assert.ok(all.events.some((event) => event.kind === "step-start" && JSON.stringify(event).includes("boom")));
    // Nothing happened since, so the next call gives no events and keeps after.
    assert.deepEqual(logAfter(paths, runId, all.after), { events: [], after: all.after, more: false });
  });

  it("pages with max, and the pages add up to the whole log", async () => {
    const { logAfter } = await stepViewModule();
    const { paths, projectDir } = setup({ fails: FAILS });
    const { runId } = await ran(paths, projectDir, "fails");
    const all = logAfter(paths, runId, 0).events;
    assert.ok(all.length > 2);
    const first = logAfter(paths, runId, 0, 2);
    assert.equal(first.events.length, 2);
    assert.equal(first.more, true);
    assert.equal(first.after, first.events[1]!.seq);
    const rest = logAfter(paths, runId, first.after);
    assert.equal(rest.more, false);
    assert.deepEqual([...first.events, ...rest.events], all);
  });
});

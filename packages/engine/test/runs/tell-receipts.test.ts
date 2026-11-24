// Piece 12 re-check, the receipts of a tell. The worker writes one receipt per call told, and
// tellResult reads them. A call in no turn gets no_turn, a tell sent before the steps start gets
// its receipt when they do, and a call whose worker ended has ended. The fake runner opens no
// turn that reads a message, so every tell it gets is no_turn.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { HomePaths } from "../../src/runs/home.js";
import { createRun } from "../../src/runs/launch.js";
import { activityWriter, loadRecord, readActivity, requestTell, TELL_RECEIPTS } from "../../src/runs/records.js";
import { Refusal } from "../../src/runs/refusal.js";
import { runningCalls } from "../../src/runs/run.js";
import { tellResult, tellStep, type TellSent } from "../../src/runs/tell.js";
import { runWorker } from "../../src/runs/worker.js";
import { PERSON, fakeRunner } from "../../src/testing.js";
import { waitUntil } from "../helpers/async.js";
import { quiet, setup } from "./fixture.js";

const HOLD = `export const meta = { name: 'hold', description: 'One held step' }
return await agent('Build it.', { label: 'impl' })`;

const MESSAGE = "Use the v2 API.";
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** A run of "hold" whose step waits until the test calls release, in this process. */
function heldRun(paths: HomePaths, projectDir: string, before?: (runId: string) => void) {
  let release!: () => void;
  const gate = new Promise<string>((done) => (release = () => done("ok")));
  const record = createRun(paths, { who: PERSON, workflow: "hold", projectDir, inputs: {} });
  before?.(record.runId);
  const worker = runWorker(record.runId, "start", { paths, inner: fakeRunner(() => gate).runner, pollMs: 20, log: quiet, handleSignals: true });
  return { runId: record.runId, release, worker };
}

/** The refusal a promise rejects with. */
async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Refusal, `not a refusal: ${String(error)}`);
    return error;
  }
  return assert.fail("no refusal");
}

describe("piece 12 re-check: the receipts of a tell", () => {
  it("a running call in no turn gets a no_turn receipt, and the tell gives turn_not_steerable with the same tell", async () => {
    const { paths, projectDir } = setup({ hold: HOLD });
    const { runId, release, worker } = heldRun(paths, projectDir);
    try {
      await waitUntil(() => runningCalls(paths, runId).some((call) => call.label === "impl"), "impl to run");
      const sent = tellStep(paths, runId, { step: "impl", text: MESSAGE }, PERSON);
      const error = await refusal(tellResult(paths, sent, { waitMs: 5000, sleep }));
      assert.equal(error.code, "turn_not_steerable");
      assert.match(error.message, /not in a turn that can read a message now/);
      assert.match(error.call ?? "", /^sous tell \S+ --step impl /);
      const receipts = readActivity(paths, runId).filter((line) => line.kind === "tell" && line.id === sent.id);
      assert.deepEqual(
        receipts.map((line) => [line.label, line.callIndex, line.text]),
        [["impl", sent.calls[0]!.callIndex, TELL_RECEIPTS.no_turn]],
      );
    } finally {
      release();
      await worker;
    }
  });

  it("a tell sent before the worker starts gets its receipt when the steps start, not dropped", async () => {
    const { paths, projectDir } = setup({ hold: HOLD });
    const id = randomUUID();
    const { runId, release, worker } = heldRun(paths, projectDir, (runId) => requestTell(paths, runId, { id, step: "impl", text: MESSAGE, calls: [{ scope: runId, label: "impl", callIndex: 0 }] }));
    try {
      await waitUntil(() => readActivity(paths, runId).some((line) => line.kind === "tell" && line.id === id), "the receipt of the tell sent before the start");
      const receipt = readActivity(paths, runId).find((line) => line.kind === "tell" && line.id === id);
      assert.equal(receipt?.text, TELL_RECEIPTS.no_turn);
    } finally {
      release();
      await worker;
    }
  });

  it("after the worker ended, a call with no receipt has ended, beside a call that read it", async () => {
    const { paths, projectDir } = setup({ hold: HOLD });
    const { runId, release, worker } = heldRun(paths, projectDir);
    release();
    await worker;
    assert.equal(loadRecord(paths, runId)?.pid, undefined, "the worker ended");
    const sent: TellSent = {
      runId,
      id: randomUUID(),
      step: "impl",
      text: MESSAGE,
      calls: [
        { step: "impl", call: 1, scope: runId, label: "impl", callIndex: 0 },
        { step: "impl", call: 2, scope: runId, label: "impl", callIndex: 1 },
      ],
    };
    activityWriter(paths, runId)({ scope: runId, label: "impl", callIndex: 0 }, { kind: "tell", id: sent.id, text: TELL_RECEIPTS.delivered });
    const result = await tellResult(paths, sent, { waitMs: 0, sleep });
    assert.equal(result.delivery, "delivered");
    assert.deepEqual(
      result.calls.map((call) => call.delivery),
      ["delivered", "ended"],
    );
    assert.ok(result.notes.includes("Call 2 did not get the message."), JSON.stringify(result.notes));
  });

  it("after the worker ended, a tell no call read gives step_not_running, not pending", async () => {
    const { paths, projectDir } = setup({ hold: HOLD });
    const { runId, release, worker } = heldRun(paths, projectDir);
    release();
    await worker;
    const sent: TellSent = { runId, id: randomUUID(), step: "impl", text: MESSAGE, calls: [{ step: "impl", call: 1, scope: runId, label: "impl", callIndex: 0 }] };
    const error = await refusal(tellResult(paths, sent, { waitMs: 0, sleep }));
    assert.equal(error.code, "step_not_running");
  });
});

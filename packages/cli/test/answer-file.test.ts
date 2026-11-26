import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resumeRun, runQuestions, startRun } from "@sous-run/engine";
import { PERSON, fakeRunner, inProcess, readState, testHome } from "@sous-run/engine/testing";
import { sous, waitFor } from "./sous.js";

// An answer file that holds no value. A person or a script may write one by hand, and the run
// must not take it for an answer.

const ship = `export const meta = { name: 'ship', description: 'asks, then runs a step' }
const approved = await checkpoint('Ship it?')
return await agent('ship, approved ' + approved, { label: 'ship' })`;

describe("an answer file with no value", () => {
  it("pauses the run, runs no step, and asks again when the run resumes", async () => {
    const { paths, projectDir } = testHome({ ship });
    const { runner, calls } = fakeRunner((call) => `ran ${call.prompt}`);
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { who: PERSON, workflow: "ship", projectDir, inputs: {} });
    await waitFor(() => runQuestions(paths, record.runId).length === 1, "the run to ask");
    const [question] = runQuestions(paths, record.runId);

    // The hash is the question's, and the value is missing.
    writeFileSync(join(paths.inbox, `${question!.id}.answer.json`), JSON.stringify({ hash: question!.hash, answeredAt: new Date().toISOString() }));
    await waitFor(() => readState(paths, record.runId)?.status === "paused", "the run to pause");
    assert.equal((await workers.ended(record.runId))?.status, "paused");
    assert.equal(readState(paths, record.runId)?.pauseReason, "checkpoint_required");
    assert.equal(calls.length, 0, "no step ran on the missing answer");
    assert.match((await sous(paths, ["show", record.runId])).out, /^status {4}paused/m);

    // The file is gone, and a resume asks the question again, now to a real answer.
    resumeRun(paths, workers.launch, record.runId, PERSON);
    await waitFor(() => runQuestions(paths, record.runId).length === 1, "the resumed run to ask again");
    const [again] = runQuestions(paths, record.runId);
    assert.equal(again!.id, question!.id);
    assert.equal((await sous(paths, ["answer", again!.id, "yes"])).code, 0);
    assert.equal((await workers.ended(record.runId))?.status, "completed");
    assert.deepEqual(
      calls.map((call) => call.prompt),
      ["ship, approved true"],
    );
  });
});

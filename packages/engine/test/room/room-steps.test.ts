// A room's turns are steps that name their room and which room() call it is. The saved state and
// the event log both keep the tag, so the run page can draw the room and tell its turns from the
// members' own sends. A send before or after the room has none. The run saves each room too, with
// every message, as it goes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveSteps } from "../../src/runs/live-steps.js";
import { loadRecord } from "../../src/runs/records.js";
import { readEventsAfter, readState } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import { createRun, fakeRunner, PERSON } from "../../src/testing.js";
import { quiet, setup } from "../runs/fixture.js";

const WORKFLOW = `export const meta = { name: 'talk', description: 'two members agree, twice' }
const a = session({ label: 'a', model: 'claude/haiku' })
const b = session({ label: 'b', model: 'claude/haiku' })
await a.send('Before the room.')
const ends = []
for (const goal of ['Agree on a plan.', 'Agree on a name.']) {
  const talk = await room({ name: 'plan', goal, members: [a, b], opening: [{ from: 'a', to: 'all', text: goal }] })
  ends.push(talk.ended)
}
await b.send('After the room.')
return ends`;

describe("a room's turns", () => {
  it("name their room and its call in the saved state and the event log, and the sends around it name none", async () => {
    const { paths, projectDir } = setup({ talk: WORKFLOW });
    const { runner } = fakeRunner((call) => (call.prompt.startsWith("Round ") ? { messages: [{ to: "all", text: `${call.label} agrees.` }], done: true } : "Sent."));
    const record = createRun(paths, { who: PERSON, workflow: "talk", projectDir, inputs: {} });
    const result = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(result?.status, "completed", JSON.stringify(result));
    // The workflow's array comes from its own realm, so compare a copy.
    assert.deepEqual([...(result?.result as string[])], ["agreed", "agreed"]);

    const turn = (label: string, call: number) => ({ label, room: { name: "plan", call } });
    const expected = [{ label: "a", room: undefined }, turn("a", 1), turn("b", 1), turn("a", 2), turn("b", 2), { label: "b", room: undefined }];
    const saved = readState(paths, record.runId)!;
    assert.deepEqual(saved.agents.map((step) => ({ label: step.label, room: step.room })), expected, "the saved state");
    assert.ok(saved.agents.filter((step) => step.room === undefined).every((step) => !("room" in step)), "a step outside a room has no room key");

    const started: Array<{ label: string; room?: { name: string; call: number } }> = [];
    readEventsAfter(paths, record.runId, 0, ({ event }) => {
      if (event.type === "agentStart") started.push({ label: event.label, room: event.room });
    });
    assert.deepEqual(started, expected, "the event log");

    // sous folds the event log the same way while a run is live.
    const live = liveSteps(paths, loadRecord(paths, record.runId)!, { ...saved, agents: [], eventSeq: 0 });
    assert.deepEqual(live.steps?.map((step) => ({ label: step.label, room: step.room })), expected, "the steps folded from the log");

    // Each room, with its opening and every answer, and how it ended.
    const room = (call: number, goal: string) => ({
      scope: record.runId,
      name: "plan",
      call,
      goal,
      members: ["a", "b"],
      turns: "together",
      hears: "all",
      rounds: 1,
      transcript: [
        { round: 0, from: "a", to: "all", text: goal },
        { round: 1, from: "a", to: "all", text: "a agrees." },
        { round: 1, from: "b", to: "all", text: "b agrees." },
      ],
      ended: "agreed",
    });
    assert.deepEqual(saved.rooms, [room(1, "Agree on a plan."), room(2, "Agree on a name.")]);
  });
});

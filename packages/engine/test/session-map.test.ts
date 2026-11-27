// The engine's session map: a handle's turns go on in one session, a replayed turn puts the
// session back for the next live one, each kept turn's hash holds the hash of the turn before it,
// and a kept session the program lost, or a kept turn on another program, stops the step.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WorkflowError } from "../src/errors.js";
import { createSteps } from "../src/steps/steps.js";
import type { JournalEntry, WorkflowRunOptions } from "../src/workflow.js";
import { isStepFailedPause, runWorkflow } from "../src/workflow.js";
import { fakePlace, onFakes, type FakePlace } from "./helpers/fake-steps.js";
import { journalResume } from "./helpers/journal-resume.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const MODEL = "claude/haiku";
const RECALL = [{ match: "^Recall", recall: true }];
const meta = "export const meta = { name: 'map', description: 'the session map' }";

/** Runs a script on the fakes, and keeps its journal and each step's end. */
async function run(place: FakePlace, body: string, extra: Partial<WorkflowRunOptions> = {}) {
  const agent = createSteps(onFakes(place));
  const journal: JournalEntry[] = [];
  const ends: Array<{ label: string; cost?: number; error?: string }> = [];
  try {
    const result = await runWorkflow(`${meta}\n${body}`, {
      agent,
      persistLogs: false,
      cwd: place.cwd,
      onAgentJournal: (entry) => journal.push(entry),
      onAgentEnd: (event) => ends.push({ label: event.label, cost: event.usage?.cost, error: event.error }),
      ...extra,
    });
    return { result, journal, ends };
  } finally {
    await agent.dispose();
  }
}

/** Runs a script that must pause on a failed step, and gives the pause. */
async function paused(place: FakePlace, body: string, extra: Partial<WorkflowRunOptions> = {}): Promise<WorkflowError> {
  let pause: WorkflowError | undefined;
  await assert.rejects(run(place, body, extra), (error: unknown) => {
    assert.ok(error instanceof WorkflowError && isStepFailedPause(error), String(error));
    pause = error;
    return true;
  });
  return pause!;
}

const near = (actual: number | undefined, expected: number, what: string) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`);

describe("the session map", () => {
  it("gives two handles' second turns with the same prompt different hashes, and a resume pairs each with its own row", async () => {
    const place = fakePlace(RECALL);
    const first = await run(
      place,
      `const a = session({ label: 'a', model: '${MODEL}' })
const b = session({ label: 'b', model: '${MODEL}' })
await a.send('Remember the word PLUM.', { label: 'turn' })
await b.send('Remember the word KIWI.', { label: 'turn' })
const x = await a.send('Recall your words.', { label: 'turn' })
const y = await b.send('Recall your words.', { label: 'turn' })
return [x, y]`,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(first.result.result)), ["PLUM", "KIWI"]);
    const [, , secondOfA, secondOfB] = [...first.journal].sort((left, right) => left.index - right.index);
    assert.notEqual(secondOfA!.hash, secondOfB!.hash, "the same prompt on two sessions hashes apart");
    const lines = place.lines().length;

    // The handles' second turns come in the other order. Each still pairs with its own row.
    const again = await run(
      place,
      `const a = session({ label: 'a', model: '${MODEL}' })
const b = session({ label: 'b', model: '${MODEL}' })
await a.send('Remember the word PLUM.', { label: 'turn' })
await b.send('Remember the word KIWI.', { label: 'turn' })
const y = await b.send('Recall your words.', { label: 'turn' })
const x = await a.send('Recall your words.', { label: 'turn' })
return [x, y]`,
      journalResume(first.journal),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(again.result.result)), ["PLUM", "KIWI"]);
    assert.equal(place.lines().length, lines, "every turn replayed");
  });

  it("replays the first send on a resume and runs the second live in the recorded session", async () => {
    const place = fakePlace(RECALL);
    const first = await run(place, `const s = session({ label: 's', model: '${MODEL}' })\nreturn await s.send('Remember the word PLUM.')`);
    const again = await run(
      place,
      `const s = session({ label: 's', model: '${MODEL}' })
await s.send('Remember the word PLUM.')
return await s.send('Recall your words.')`,
      journalResume(first.journal),
    );
    assert.equal(again.result.result, "PLUM");
    const [opened, kept] = place.lines();
    assert.equal(place.lines().length, 2, "the first send replayed");
    assert.equal(kept?.resume, true);
    assert.equal(kept?.sessionId, opened?.sessionId);
  });

  it("fails the step and pauses the run when the kept session is lost, and starts no fresh one", async () => {
    const place = fakePlace(RECALL);
    const first = await run(place, `const s = session({ label: 's', model: '${MODEL}' })\nreturn await s.send('Remember the word PLUM.')`);
    rmSync(join(place.dir, "claude-sessions"), { recursive: true, force: true });
    const pause = await paused(
      place,
      `const s = session({ label: 's', model: '${MODEL}' })
await s.send('Remember the word PLUM.')
return await s.send('Recall your words.', { retries: 2 })`,
      journalResume(first.journal),
    );
    assert.match(pause.message, /could not find/);
    assert.deepEqual(
      place.lines().map((line) => line.resume),
      [false],
      "no turn ran in a new session",
    );
  });

  it("fails a kept turn whose model is on another program before any program runs", async () => {
    const place = fakePlace();
    const pause = await paused(
      place,
      `const s = session({ label: 's' })
await s.send('Build it.', { model: '${MODEL}' })
return await s.send('Review it.', { model: 'codex/gpt-6.1-sol' })`,
    );
    assert.match(pause.message, /claude/);
    assert.match(pause.message, /codex/);
    assert.deepEqual(place.lines().map((line) => line.program), ["claude"]);
  });

  it("counts a run's cost as the session's last total, not the sum of the totals", async () => {
    const place = fakePlace();
    const { result, ends } = await run(
      place,
      `const s = session({ label: 's', model: '${MODEL}' })
await s.send('One.')
await s.send('Two.')
return await s.send('Three.')`,
    );
    const turn = ends[0]?.cost;
    assert.ok(turn !== undefined && turn > 0);
    assert.deepEqual(place.lines().map((line) => line.resume), [false, true, true]);
    for (const end of ends) near(end.cost, turn, "each step counts what it added");
    near(result.tokenUsage?.cost, turn * 3, "the run's cost");
  });

  it("counts a kept turn whole when the session's first turn was retried in a new session", async () => {
    const place = fakePlace([{ match: "^One", times: 1, fail: "boom" }]);
    const { result, ends } = await run(
      place,
      `const s = session({ label: 's', model: '${MODEL}' })
await s.send('One.', { retries: 2 })
return await s.send('Two.')`,
    );
    const lines = place.lines();
    assert.deepEqual(lines.map((line) => line.resume), [false, false, true]);
    assert.notEqual(lines[0].sessionId, lines[1].sessionId);
    assert.equal(lines[2].sessionId, lines[1].sessionId);
    const turn = 0.0012;
    near(ends[0]?.cost, turn * 2, "the first send's two attempts");
    near(ends[1]?.cost, turn, "the kept turn");
    near(result.tokenUsage?.cost, turn * 3, "the run's cost");
  });

  it("counts a kept turn whole after a replayed first turn that was retried in a new session", async () => {
    const place = fakePlace([{ match: "^One", times: 1, fail: "boom" }]);
    const opening = `const s = session({ label: 's', model: '${MODEL}' })
await s.send('One.', { retries: 2 })`;
    const first = await run(place, `${opening}\nreturn 'opened'`);
    const again = await run(place, `${opening}\nreturn await s.send('Two.')`, journalResume(first.journal));
    const lines = place.lines();
    assert.deepEqual(lines.map((line) => line.resume), [false, false, true], "the first send replayed");
    assert.equal(lines[2].sessionId, lines[1].sessionId);
    const turn = 0.0012;
    near(again.ends[1]?.cost, turn, "the kept turn");
  });
});

// What parallel() and pipeline() do when a function fails, as docs/orchestrator.md states it.
// A step that fails its last try pauses the run. An error the script throws outside any step
// gives null in that slot.
import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { isStepFailedPause, type JournalEntry, runWorkflow } from "../src/workflow.js";

/**
 * A fake runner. A prompt starting with "bad" fails with a recoverable error. A prompt starting
 * with "slow" waits until the run logs its pause. Every prompt that returns gives "ran:<prompt>".
 */
function pauseFixture() {
  const calls: string[] = [];
  const journal: JournalEntry[] = [];
  const logs: string[] = [];
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    calls,
    journal,
    logs,
    options: {
      agent: {
        async run(prompt: string) {
          calls.push(prompt);
          if (prompt.startsWith("bad")) {
            throw new WorkflowError("bad step", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
          }
          // The slow step is still running when the bad one fails its last try.
          if (prompt.startsWith("slow")) await paused;
          return `ran:${prompt}`;
        },
      },
      agentRetries: 0,
      persistLogs: false,
      onLog: (message: string) => {
        logs.push(message);
        if (/The run pauses/.test(message)) release();
      },
      onAgentJournal: (entry: JournalEntry) => journal.push(entry),
    },
  };
}

function isPauseOn(label: string) {
  return (error: unknown) =>
    isStepFailedPause(error as WorkflowError) && (error as WorkflowError).agentLabel === label;
}

test("parallel: a step that fails its last try pauses the run, a running sibling finishes and no new step starts", async () => {
  const fixture = pauseFixture();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'parallel_pause', description: 'parallel pause' }
const xs = await parallel([
  () => agent('slow sibling', { label: 'slow' }),
  () => agent('bad step', { label: 'bad' }),
])
await agent('after', { label: 'after' })
return xs`,
      fixture.options,
    ),
    isPauseOn("bad"),
  );

  assert.deepEqual([...fixture.calls].sort(), ["bad step", "slow sibling"], "the step after parallel never starts");
  assert.equal(fixture.journal.length, 1, "the running sibling finished and was journaled");
  assert.equal(fixture.journal[0].result, "ran:slow sibling");
});

test("pipeline: a step that fails its last try pauses the run, a running sibling finishes and no new stage starts", async () => {
  const fixture = pauseFixture();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'pipeline_pause', description: 'pipeline pause' }
const xs = await pipeline(['slow', 'bad'],
  (item) => agent(item + ' stage one', { label: item + '1' }),
  (prev, item) => agent(item + ' stage two', { label: item + '2' }))
return xs`,
      fixture.options,
    ),
    isPauseOn("bad1"),
  );

  assert.deepEqual(
    [...fixture.calls].sort(),
    ["bad stage one", "slow stage one"],
    "the sibling's second stage never starts",
  );
  assert.equal(fixture.journal.length, 1, "the running sibling finished and was journaled");
  assert.equal(fixture.journal[0].result, "ran:slow stage one");
});

test("parallel: an error the function throws outside any step gives null in its slot and the others go on", async () => {
  const logs: string[] = [];
  const calls: string[] = [];
  const result = await runWorkflow<unknown[]>(
    `export const meta = { name: 'parallel_null', description: 'parallel null' }
return await parallel([
  () => { throw new Error('plain boom') },
  () => agent('first', { label: 'first' }),
  () => JSON.parse('not json'),
  async () => agent('second', { label: 'second' }),
])`,
    {
      agent: {
        async run(prompt: string) {
          calls.push(prompt);
          return `ran:${prompt}`;
        },
      },
      persistLogs: false,
      onLog: (message) => logs.push(message),
    },
  );

  assert.deepEqual(result.result, [null, "ran:first", null, "ran:second"]);
  assert.deepEqual([...calls].sort(), ["first", "second"]);
  assert.ok(logs.some((message) => /parallel\[0\] failed: plain boom/.test(message)));
  assert.ok(logs.some((message) => /parallel\[2\] failed/.test(message)));
});

test("pipeline: an error a stage throws outside any step gives null for that item and skips its later stages", async () => {
  const logs: string[] = [];
  const calls: string[] = [];
  const result = await runWorkflow<unknown[]>(
    `export const meta = { name: 'pipeline_null', description: 'pipeline null' }
return await pipeline(['a', 'b', 'c'],
  (item) => { if (item === 'b') throw new Error('stage boom'); return item + '1' },
  (prev) => agent('stage two ' + prev, { label: 'two ' + prev }))`,
    {
      agent: {
        async run(prompt: string) {
          calls.push(prompt);
          return `ran:${prompt}`;
        },
      },
      persistLogs: false,
      onLog: (message) => logs.push(message),
    },
  );

  assert.deepEqual(result.result, ["ran:stage two a1", null, "ran:stage two c1"]);
  assert.deepEqual([...calls].sort(), ["stage two a1", "stage two c1"]);
  assert.ok(logs.some((message) => /pipeline\[1\] failed: stage boom/.test(message)));
});

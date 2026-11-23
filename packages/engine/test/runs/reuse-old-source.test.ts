import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../../src/errors.js";
import { createRun } from "../../src/runs/launch.js";
import { loadRecord } from "../../src/runs/records.js";
import { readState } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import type { AgentRunner } from "../../src/steps/agent-runner.js";
import { plantState, setup } from "./fixture.js";

// A reuse run that pauses, then resumes. Its source's steps after the pause replay on the resume,
// whether the source was saved with call rows or before them. A source with call rows keeps its
// rows in the seed. A source saved before call rows keeps them in the reuse run's journal.

const three = (b: string) => `export const meta = { name: 'three', description: 'three steps' }
const a = await agent('A', { label: 'a' })
const b = await agent('${b}', { label: 'b' })
const c = await agent('C', { label: 'c' })
return [a, b, c]`;

const boom = () => new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
const quiet = () => {};

async function pauseThenResume(oldSource: boolean): Promise<{ first: string[]; journal: string[]; second: string[] }> {
  const { paths, projectDir } = setup({ three: three("B") }, { retries: 0 });
  let failB2 = true;
  const prompts: string[] = [];
  const runner = {
    async run(prompt: string) {
      prompts.push(prompt);
      if (prompt === "B2" && failB2) throw boom();
      return `${prompt} done`;
    },
  } as unknown as AgentRunner;
  const source = createRun(paths, { workflow: "three", projectDir, inputs: {} });
  await runWorker(source.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
  assert.equal(readState(paths, source.runId)?.status, "completed");
  if (oldSource) {
    // The source now looks like a run saved before call rows.
    const { calls: _calls, resumeSeed: _seed, ...state } = readState(paths, source.runId)!;
    plantState(paths, state);
    assert.equal(readState(paths, source.runId)?.calls, undefined);
  }

  writeFileSync(join(projectDir, ".orchestrator", "workflows", "three.js"), three("B2"));
  const reuse = createRun(paths, { workflow: "three", projectDir, inputs: {}, reuseFrom: loadRecord(paths, source.runId)! });
  let mark = prompts.length;
  await runWorker(reuse.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
  assert.equal(readState(paths, reuse.runId)?.status, "paused");
  const first = prompts.slice(mark);
  const journal = (readState(paths, reuse.runId)?.journal ?? []).map((row) => `${row.index}:${String(row.result)}`).sort();

  failB2 = false;
  mark = prompts.length;
  await runWorker(reuse.runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });
  assert.equal(readState(paths, reuse.runId)?.status, "completed");
  return { first, journal, second: prompts.slice(mark) };
}

it("a paused reuse of a source with call rows replays the source's later step on resume", async () => {
  const { first, journal, second } = await pauseThenResume(false);
  assert.deepEqual(first, ["B2"]);
  assert.deepEqual(journal, ["0:A done"], "C waits in the seed");
  assert.deepEqual(second, ["B2"]);
});

it("a paused reuse of a source saved before call rows replays the source's later step on resume", async () => {
  const { first, journal, second } = await pauseThenResume(true);
  assert.deepEqual(first, ["B2"], "A replays from the old journal");
  assert.deepEqual(journal, ["0:A done", "2:C done"], "C stays in the journal, since the run did not reach it");
  assert.deepEqual(second, ["B2"], "C replays");
});

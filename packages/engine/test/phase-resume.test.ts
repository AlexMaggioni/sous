import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWorker } from "../src/runs/worker.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import { runWorkflow } from "../src/workflow.js";
import { createRun, PERSON, readState, testHome } from "../src/testing.js";
import { boom, quiet } from "./runs/fixture.js";

// phase() sets one value for the whole run, and the parallel branches share it. A step takes the
// value at the moment the script calls it. Here branch A sets its phase, then waits on A1 before it
// calls A2. Branch B waits on B1, then sets its own phase. So A2 takes "alpha" when A1 ends first
// and "beta" when B1 ends first. The first run ends the two steps in the order the test picks. On
// the resume both steps replay, and they end in whatever order the replays give. One of the two
// cases below therefore resumes in another order than it first ran. Every finished step must
// still replay, so the resume runs only the last step, which failed the first time.

const script = `export const meta = { name: 'phases', description: 'two branches set their own phase' }
const [a, b] = await parallel([
  async () => { phase('alpha'); const one = await agent('A1', { label: 'a1' }); return [one, await agent('A2', { label: 'a2' })] },
  async () => { const one = await agent('B1', { label: 'b1' }); phase('beta'); return [one, await agent('B2', { label: 'b2' })] },
])
return [a, b, await agent('END', { label: 'end' })]`;

/** Run the script until its last step fails, with `slow` ending well after the other first step,
 *  then resume it with that last step working. */
async function firstRunThenResume(slow: "A1" | "B1") {
  const { paths, projectDir } = testHome({ phases: script }, { retries: 0 });
  const prompts: string[] = [];
  let failEnd = true;
  const runner = {
    async run(prompt: string) {
      prompts.push(prompt);
      if (prompt === slow) await new Promise((resolve) => setTimeout(resolve, 80));
      if (prompt === "END" && failEnd) throw boom();
      return `${prompt} done`;
    },
  } as unknown as AgentRunner;
  const record = createRun(paths, { who: PERSON, workflow: "phases", projectDir, inputs: {} });
  const saved = () => readState(paths, record.runId)!;

  await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
  assert.equal(saved().status, "paused");
  const firstPrompts = [...prompts];

  failEnd = false;
  const mark = prompts.length;
  const done = await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });
  return { firstPrompts, resumePrompts: prompts.slice(mark), done };
}

describe("phase() in parallel branches on a resume", () => {
  for (const slow of ["A1", "B1"] as const) {
    it(`replays every finished step when ${slow} ended last on the first run`, async () => {
      const { firstPrompts, resumePrompts, done } = await firstRunThenResume(slow);
      // The first run ran each step once, then failed the last one.
      assert.deepEqual([...firstPrompts].sort(), ["A1", "A2", "B1", "B2", "END"]);
      assert.equal(firstPrompts.at(-1), "END");
      // The resume runs only the step that failed. Each finished step replays.
      assert.deepEqual(resumePrompts, ["END"]);
      assert.equal(done?.status, "completed");
      // The array comes from the script's own realm, so turn it into JSON before a strict compare.
      assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), [["A1 done", "A2 done"], ["B1 done", "B2 done"], "END done"]);
    });
  }
});

describe("phase() in a branch", () => {
  it("changes that branch only, never a sibling, a later pipeline item or the code after", async () => {
    // B1 and C1 end before A1, so a shared phase would reach A2, C2 and AFTER as "beta".
    const slow = new Set(["A1", "P1 x"]);
    const runner = {
      async run(prompt: string) {
        if (slow.has(prompt)) await new Promise((resolve) => setTimeout(resolve, 40));
        return prompt;
      },
    } as unknown as AgentRunner;
    const phases: Record<string, string | undefined> = {};
    await runWorkflow(
      `export const meta = { name: 'branches', description: 'a phase per branch' }
phase('top')
await parallel([
  async () => { phase('alpha'); await agent('A1'); await agent('A2') },
  async () => { await agent('B1'); phase('beta'); await agent('B2') },
  async () => { await agent('C1'); await agent('C2') },
])
await pipeline(['x', 'y'], async (item) => { phase('stage ' + item); await agent('P1 ' + item); return item }, (item) => agent('P2 ' + item))
return agent('AFTER')`,
      { agent: runner, persistLogs: false, onAgentStart: (event) => { phases[event.prompt] = event.phase; } },
    );
    assert.deepEqual(phases, {
      A1: "alpha",
      A2: "alpha",
      B1: "top",
      B2: "beta",
      C1: "top",
      C2: "top",
      "P1 x": "stage x",
      "P2 x": "stage x",
      "P1 y": "stage y",
      "P2 y": "stage y",
      AFTER: "top",
    });
  });
});

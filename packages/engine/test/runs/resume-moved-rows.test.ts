import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { createRun } from "../../src/runs/launch.js";
import { readState } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import type { AgentRunner } from "../../src/steps/agent-runner.js";
import { boom, quiet, setup } from "./fixture.js";

// A same-ID resume of a parallel run. The replays end in branch order, so a step that opens after
// them can take another index than it had. A replayed row then lives at its new index, and a
// later resume must not read it at its old index too.

const twoBranches = `export const meta = { name: 'two', description: 'two branches' }
const [p, q] = await parallel([
  async () => { await agent('X', { label: 'x' }); return agent('H', { label: 'h' }) },
  async () => { await agent('Y', { label: 'y' }); return agent('Z', { label: 'z' }) },
])
const last = await agent('Z', { label: 'z again' })
return [p, q, last]`;

it("runs a step live after two failed resumes moved an identical step's row", async () => {
  const { paths, projectDir } = setup({ two: twoBranches }, { retries: 0 });
  let failH = true;
  let holdH: Promise<void> | undefined;
  const prompts: string[] = [];
  const runner = {
    async run(prompt: string) {
      prompts.push(prompt);
      // X is slow on the first run, so Y and the first Z end before H opens.
      if (prompt === "X") await new Promise((resolve) => setTimeout(resolve, 80));
      if (prompt === "H") await holdH;
      if (prompt === "H" && failH) throw boom();
      return `${prompt} done, call ${prompts.length}`;
    },
  } as unknown as AgentRunner;
  const record = createRun(paths, { workflow: "two", projectDir, inputs: {} });
  const saved = () => readState(paths, record.runId)!;

  await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
  assert.equal(saved().status, "paused");
  assert.deepEqual(prompts, ["X", "Y", "Z", "H"]);
  assert.deepEqual(
    (saved().journal ?? []).map((row) => `${row.index}:${String(row.result)}`).sort(),
    ["0:X done, call 3", "1:Y done, call 2", "2:Z done, call 3"],
  );

  // X and Y replay and end in branch order, so H opens at 2 and Z at 3. Z's row moves to 3.
  // While H still runs, the saved state no longer holds Z's row at 2.
  let release!: () => void;
  holdH = new Promise((resolve) => { release = resolve; });
  let mark = prompts.length;
  const second = runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });
  const deadline = Date.now() + 5_000;
  while (!(saved().calls ?? []).some((row) => row.index === 3 && row.replay?.recordedIndex === 2)) {
    assert.ok(Date.now() < deadline, "Z replays at index 3");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual((saved().journal ?? []).filter((row) => row.index === 2), [], "Z's journal row left index 2");
  assert.deepEqual((saved().calls ?? []).filter((row) => row.index === 2), [], "Z's call row left index 2");
  release();
  await second;
  assert.equal(saved().status, "paused");
  assert.deepEqual(prompts.slice(mark), ["H"]);

  // H works now. The second Z never ran, so it runs live.
  failH = false;
  mark = prompts.length;
  const done = await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });
  assert.equal(done?.status, "completed");
  assert.deepEqual(prompts.slice(mark), ["H", "Z"]);
  // The array comes from the script's own realm, so copy it before a strict compare.
  assert.deepEqual([...(done?.result as unknown[])], ["H done, call 6", "Z done, call 3", "Z done, call 7"]);
});

it("runs a folder's step in that folder after two failed resumes, when another folder has the same step", async () => {
  const { paths, projectDir } = setup({}, { retries: 0 });
  const r1 = join(projectDir, "r1");
  const r2 = join(projectDir, "r2");
  mkdirSync(r1, { recursive: true });
  mkdirSync(r2, { recursive: true });
  writeFileSync(join(projectDir, ".orchestrator", "workflows", "fan.js"), `export const meta = { name: 'fan', description: 'fan-out' }
return await parallel([
  async () => {
    await agent('Lint', { label: 'lint r1', cwd: ${JSON.stringify(r1)} })
    await agent('Fix', { label: 'fix r1', cwd: ${JSON.stringify(r1)} })
    return agent('Test', { label: 'test r1', cwd: ${JSON.stringify(r1)} })
  },
  async () => {
    await agent('Prep', { label: 'prep r2', cwd: ${JSON.stringify(r2)} })
    return agent('Test', { label: 'test r2', cwd: ${JSON.stringify(r2)} })
  },
])`);
  let failFix = true;
  const live: string[] = [];
  const runner = {
    async run(prompt: string, options: { cwd?: string } = {}) {
      const where = String(options.cwd).endsWith("r1") ? "r1" : "r2";
      live.push(`${prompt} ${where}`);
      if (prompt === "Lint") await new Promise((resolve) => setTimeout(resolve, 80));
      if (prompt === "Fix" && failFix) throw boom();
      return `${prompt} ran in ${where}`;
    },
  } as unknown as AgentRunner;
  const record = createRun(paths, { workflow: "fan", projectDir, inputs: {} });

  await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
  assert.equal(readState(paths, record.runId)?.status, "paused");
  assert.deepEqual(live, ["Lint r1", "Prep r2", "Test r2", "Fix r1"]);
  let mark = live.length;
  await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });
  assert.equal(readState(paths, record.runId)?.status, "paused");
  assert.deepEqual(live.slice(mark), ["Fix r1"]);

  failFix = false;
  mark = live.length;
  const done = await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });
  assert.equal(done?.status, "completed");
  assert.deepEqual(live.slice(mark), ["Fix r1", "Test r1"]);
  assert.deepEqual(done?.result, ["Test ran in r1", "Test ran in r2"]);
});

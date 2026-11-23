import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { HomePaths } from "../../src/runs/home.js";
import { createRun } from "../../src/runs/launch.js";
import type { PersistedRunState } from "../../src/runs/persistence/run-persistence.js";
import { loadRecord, type RunRecord } from "../../src/runs/records.js";
import { writeAnswer } from "../../src/runs/inbox.js";
import { runQuestions } from "../../src/runs/run.js";
import { readState } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import type { AgentRunner } from "../../src/steps/agent-runner.js";
import { plantState, setup } from "./fixture.js";

// Runs that the code at b21cd2c4 saved, one per shape a resume must still read. Each fixture
// holds the runs' records, workflows, states and event logs, and the workflow files in the
// project. test/fixtures/resume-v1/generate.ts wrote them, and its notes say how. Each test
// plants a fixture in a new home, resumes it, and checks which steps run again.

const DIR = join(import.meta.dirname, "..", "fixtures", "resume-v1");

interface SavedRun {
  record: RunRecord;
  workflows: Record<string, string>;
  state: PersistedRunState;
  events: string;
}

interface ResumeFixture {
  project: Record<string, string>;
  runs: SavedRun[];
}

/** Plant a fixture's runs in a new home with raw writes, and give the run ids in order. */
function plant(name: string): { paths: HomePaths; projectDir: string; runIds: string[] } {
  const fixture = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as ResumeFixture;
  const { paths, projectDir } = setup(fixture.project, { retries: 0 });
  const root = dirname(projectDir);
  const place = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll("__ROOT__", root)) as T;
  for (const run of fixture.runs) {
    const runId = run.record.runId;
    writeFileSync(join(paths.records, `${runId}.json`), JSON.stringify(place(run.record), null, 2));
    writeFileSync(join(paths.records, `${runId}.workflows`), JSON.stringify(run.workflows));
    plantState(paths, place(run.state), place(run.events));
  }
  return { paths, projectDir, runIds: fixture.runs.map((run) => run.record.runId) };
}

interface Call {
  prompt: string;
  options: Record<string, unknown>;
}

/** A fake agent that answers "<prompt> done". */
function fake(): { runner: AgentRunner; calls: Call[]; prompts: () => string[] } {
  const calls: Call[] = [];
  const runner = {
    async run(prompt: string, options: Record<string, unknown> = {}) {
      calls.push({ prompt, options });
      return `${prompt} done`;
    },
  } as unknown as AgentRunner;
  return { runner, calls, prompts: () => calls.map((call) => call.prompt) };
}

/** Run the worker, answer each question with `answer`, and give the prompts asked. */
async function work(paths: HomePaths, runId: string, mode: "start" | "resume", runner: AgentRunner, answer: unknown = true): Promise<{ asked: string[]; result: unknown }> {
  const asked: string[] = [];
  let ended = false;
  const answering = (async () => {
    while (!ended) {
      for (const question of runQuestions(paths, runId)) {
        asked.push(question.prompt);
        writeAnswer(paths, question, answer);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  const result = await runWorker(runId, mode, { paths, inner: runner, pollMs: 20, log: () => {} });
  ended = true;
  await answering;
  return { asked, result: JSON.parse(JSON.stringify(result?.result ?? null)) };
}

describe("a run saved by the code at b21cd2c4", () => {
  it("resumes after a failed step and runs only that step", async () => {
    const { paths, runIds: [runId] } = plant("failed-step");
    const { runner, prompts } = fake();
    const { result } = await work(paths, runId!, "resume", runner);
    assert.equal(readState(paths, runId!)?.status, "completed");
    assert.deepEqual(prompts(), ["C"]);
    assert.deepEqual(result, ["A done", "B done", "C done"]);
  });

  it("resumes after a usage limit in the limited step's session", async () => {
    const { paths, runIds: [runId] } = plant("usage-limit");
    const { runner, calls, prompts } = fake();
    await work(paths, runId!, "resume", runner);
    assert.equal(readState(paths, runId!)?.status, "completed");
    assert.deepEqual(prompts(), ["B", "C"]);
    assert.equal((calls[0]!.options.continueFromSession as { sessionId?: string } | undefined)?.sessionId, "s2");
    assert.equal(calls[1]!.options.continueFromSession, undefined);
  });

  it("replays nested steps saved as journal rows with no call rows", async () => {
    const { paths, runIds: [runId] } = plant("nested");
    const { runner, prompts } = fake();
    const { result } = await work(paths, runId!, "resume", runner);
    assert.equal(readState(paths, runId!)?.status, "completed");
    assert.deepEqual(prompts(), ["C"]);
    assert.deepEqual(result, ["A done", ["X done", "Y done"], "C done"]);
  });

  it("resumes a run with the legacy marker", async () => {
    const { paths, runIds: [runId] } = plant("legacy-marker");
    const { runner, prompts } = fake();
    await work(paths, runId!, "resume", runner);
    assert.equal(readState(paths, runId!)?.status, "completed");
    assert.deepEqual(prompts(), ["C"]);
  });

  it("resumes a run saved with an older inputs format", async () => {
    const { paths, runIds: [runId] } = plant("older-inputs-format");
    const { runner, prompts } = fake();
    await work(paths, runId!, "resume", runner);
    assert.equal(readState(paths, runId!)?.status, "completed");
    assert.deepEqual(prompts(), ["C"]);
  });

  it("resumes a run saved with no call rows", async () => {
    const { paths, runIds: [runId] } = plant("no-call-rows");
    const { runner, prompts } = fake();
    await work(paths, runId!, "resume", runner);
    assert.equal(readState(paths, runId!)?.status, "completed");
    assert.deepEqual(prompts(), ["C"]);
  });

  it("resumes a paused reuse run whose seed holds candidates and a blocker", async () => {
    const { paths, runIds: [, runId] } = plant("reuse-blockers");
    const { runner, prompts } = fake();
    const { result } = await work(paths, runId!, "resume", runner);
    assert.equal(readState(paths, runId!)?.status, "completed");
    // C replays from the seed. The blocker keeps D live.
    assert.deepEqual(prompts(), ["B2", "D"]);
    assert.deepEqual(result, ["A done", "B2 done", "C done", "D done"]);
    assert.equal(readState(paths, runId!)?.resumeSeed, undefined);
  });

  it("resumes a paused reuse run whose seed holds a checkpoint injection", { timeout: 15_000 }, async () => {
    const { paths, runIds: [, runId] } = plant("checkpoint-injection");
    const { runner, prompts } = fake();
    const { asked, result } = await work(paths, runId!, "resume", runner);
    assert.equal(readState(paths, runId!)?.status, "completed");
    // The seed's answer and B replay. Only the failed step runs again.
    assert.deepEqual(asked, []);
    assert.deepEqual(prompts(), ["A2"]);
    assert.deepEqual(result, ["A2 done", true, "B done"]);
  });

  it("reuses a run that was resumed once", async () => {
    const { paths, projectDir, runIds: [sourceId] } = plant("resumed-source");
    const record = createRun(paths, { workflow: "three", projectDir, inputs: {}, reuseFrom: loadRecord(paths, sourceId!)! });
    const { runner, prompts } = fake();
    const { result } = await work(paths, record.runId, "start", runner);
    assert.equal(readState(paths, record.runId)?.status, "completed");
    assert.deepEqual(prompts(), ["A2", "B", "C"]);
    assert.deepEqual(result, ["A2 done", "B done", "C done"]);
  });
});

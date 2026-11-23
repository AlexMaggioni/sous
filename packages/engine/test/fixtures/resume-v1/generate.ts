// Writes the fixtures in this folder: runs that the code at b21cd2c4 saved, one per shape a
// resume must still read. resume-compat.test.ts plants them in a new home. Run it from
// packages/engine:
//
//   HOME="$(mktemp -d)" npx tsx test/fixtures/resume-v1/generate.ts
//
// The fixtures stay as the old code wrote them. Run this again only to add a shape, and on the
// code it names, since a newer code writes newer files.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "../../../src/errors.js";
import { ensureHome, homePaths, type HomePaths } from "../../../src/runs/home.js";
import { createRun } from "../../../src/runs/launch.js";
import { workflowProjectPaths } from "../../../src/runs/persistence/project-paths.js";
import type { PersistedRunState } from "../../../src/runs/persistence/run-persistence.js";
import { loadRecord, type RunRecord } from "../../../src/runs/records.js";
import { writeAnswer } from "../../../src/runs/inbox.js";
import { runQuestions, stopRun } from "../../../src/runs/run.js";
import { readState } from "../../../src/runs/store.js";
import { runWorker } from "../../../src/runs/worker.js";
import type { AgentRunner } from "../../../src/steps/agent-runner.js";

const WRITTEN_BY = "b21cd2c4";
const OUT = import.meta.dirname;

interface SavedRun {
  record: RunRecord;
  workflows: Record<string, string>;
  state: PersistedRunState;
  events: string;
}

interface ResumeFixture {
  note: string;
  writtenBy: string;
  /** The workflow files in the project folder when the run is resumed. */
  project: Record<string, string>;
  runs: SavedRun[];
}

interface Scene {
  root: string;
  paths: HomePaths;
  projectDir: string;
}

function scene(workflows: Record<string, string>): Scene {
  const root = mkdtempSync(join(tmpdir(), "resume-v1-"));
  process.env.CLAUDE_CONFIG_DIR = join(root, ".claude");
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.XDG_CONFIG_HOME = join(root, ".config");
  const paths = ensureHome(homePaths(join(root, "home")));
  writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder", retries: 0 }));
  const projectDir = join(root, "project");
  for (const [name, script] of Object.entries(workflows)) edit(projectDir, name, script);
  return { root, paths, projectDir };
}

function edit(projectDir: string, name: string, script: string): void {
  const file = join(projectDir, ".orchestrator", "workflows", `${name}.js`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, script);
}

/** A fake agent that answers "<prompt> done" and opens session s<n>. `fail` picks the failures.
 *  The step `hold` waits until the run stops it. */
function fake(fail: (prompt: string) => Error | undefined = () => undefined, hold?: string): { runner: AgentRunner; prompts: string[] } {
  const prompts: string[] = [];
  const runner = {
    async run(prompt: string, options: Record<string, unknown> = {}) {
      prompts.push(prompt);
      (options.onSessionOpen as ((ref: unknown) => void) | undefined)?.({ sessionId: `s${prompts.length}`, backendId: "claude", cwd: options.cwd, reopen: { load: true, resume: true, list: true } });
      if (prompt === hold) {
        await new Promise((resolve) => (options.signal as AbortSignal).addEventListener("abort", resolve));
        throw new WorkflowError("aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
      }
      const error = fail(prompt);
      if (error) throw error;
      return `${prompt} done`;
    },
  } as unknown as AgentRunner;
  return { runner, prompts };
}

const boom = () => new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
const quiet = () => {};

async function run(paths: HomePaths, runId: string, mode: "start" | "resume", runner: AgentRunner, answer?: unknown, handleSignals = false): Promise<string | undefined> {
  let ended = false;
  const answering = (async () => {
    while (answer !== undefined && !ended) {
      for (const question of runQuestions(paths, runId)) writeAnswer(paths, question, answer);
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  await runWorker(runId, mode, { paths, inner: runner, pollMs: 20, log: quiet, handleSignals });
  ended = true;
  await answering;
  // A resume that pauses again gives no result, so the saved state says how the run ended.
  return readState(paths, runId)?.status;
}

function saved(at: Scene, runId: string): SavedRun {
  const { runsDir } = workflowProjectPaths(at.paths.home, { persistenceRoot: at.paths.runs });
  return {
    record: JSON.parse(readFileSync(join(at.paths.records, `${runId}.json`), "utf8")) as RunRecord,
    workflows: JSON.parse(readFileSync(join(at.paths.records, `${runId}.workflows`), "utf8")) as Record<string, string>,
    state: JSON.parse(readFileSync(join(runsDir, `${runId}.json`), "utf8")) as PersistedRunState,
    events: readFileSync(join(runsDir, `${runId}.events.jsonl`), "utf8"),
  };
}

function write(name: string, at: Scene, note: string, project: Record<string, string>, runs: SavedRun[]): void {
  const fixture: ResumeFixture = { note, writtenBy: WRITTEN_BY, project, runs };
  const text = JSON.stringify(fixture, null, 2).replaceAll(at.root, "__ROOT__");
  writeFileSync(join(OUT, `${name}.json`), `${text}\n`);
}

function expect(what: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const three = (a: string, b = "B", c = "C") => `export const meta = { name: 'three', description: 'three steps' }
const a = await agent('${a}', { label: 'a' })
const b = await agent('${b}', { label: 'b' })
const c = await agent('${c}', { label: 'c' })
return [a, b, c]`;

const child = `export const meta = { name: 'child', description: 'two steps' }
const x = await agent('X', { label: 'x' })
const y = await agent('Y', { label: 'y' })
return [x, y]`;

const parent = `export const meta = { name: 'parent', description: 'a nested workflow' }
const a = await agent('A', { label: 'a' })
const n = await workflow('child', {})
const c = await agent('C', { label: 'c' })
return [a, n, c]`;

const four = (b: string) => `export const meta = { name: 'four', description: 'four steps' }
const a = await agent('A', { label: 'a' })
const b = await agent('${b}', { label: 'b' })
const c = await agent('C', { label: 'c' })
const d = await agent('D', { label: 'd' })
return [a, b, c, d]`;

const asks = (a: string) => `export const meta = { name: 'asks', description: 'a question between two steps' }
const a = await agent('${a}', { label: 'a' })
const ok = await checkpoint('Ship it?')
const b = await agent('B', { label: 'b' })
return [a, ok, b]`;

/** Three steps whose last one failed, so the run paused. */
async function failedStep(): Promise<{ at: Scene; runId: string }> {
  const at = scene({ three: three("A") });
  const { runner, prompts } = fake((prompt) => (prompt === "C" ? boom() : undefined));
  const record = createRun(at.paths, { workflow: "three", projectDir: at.projectDir, inputs: {} });
  expect("failed step", await run(at.paths, record.runId, "start", runner), "paused");
  expect("failed step prompts", prompts, ["A", "B", "C"]);
  return { at, runId: record.runId };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

{
  const { at, runId } = await failedStep();
  write("failed-step", at, "Three steps. C failed, so the run paused.", { three: three("A") }, [saved(at, runId)]);
}

{
  const at = scene({ three: three("A") });
  const { runner, prompts } = fake((prompt) =>
    prompt === "B" ? new WorkflowError("You've hit your limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false }) : undefined,
  );
  const record = createRun(at.paths, { workflow: "three", projectDir: at.projectDir, inputs: {} });
  expect("limit", await run(at.paths, record.runId, "start", runner), "paused");
  expect("limit prompts", prompts, ["A", "B"]);
  write("usage-limit", at, "Three steps. B hit the usage limit in session s2, so the run paused.", { three: three("A") }, [saved(at, record.runId)]);
}

{
  const at = scene({ child, parent });
  const { runner, prompts } = fake((prompt) => (prompt === "C" ? boom() : undefined));
  const record = createRun(at.paths, { workflow: "parent", projectDir: at.projectDir, inputs: {} });
  expect("nested", await run(at.paths, record.runId, "start", runner), "paused");
  expect("nested prompts", prompts, ["A", "X", "Y", "C"]);
  write("nested", at, "A, a nested workflow with X and Y, then C. C failed, so the run paused. The nested steps have journal rows and no call rows.", { child, parent }, [saved(at, record.runId)]);
}

{
  const at = scene({ four: four("B") });
  const source = fake(undefined, "D");
  const first = createRun(at.paths, { workflow: "four", projectDir: at.projectDir, inputs: {} });
  const running = run(at.paths, first.runId, "start", source.runner, undefined, true);
  for (let i = 0; i < 500 && !source.prompts.includes("D"); i++) await new Promise((r) => setTimeout(r, 10));
  stopRun(at.paths, first.runId);
  expect("stopped source", await running, "aborted");
  edit(at.projectDir, "four", four("B2"));
  const reuse = fake((prompt) => (prompt === "B2" ? boom() : undefined));
  const second = createRun(at.paths, { workflow: "four", projectDir: at.projectDir, inputs: {}, reuseFrom: loadRecord(at.paths, first.runId)! });
  expect("reuse of a stopped run", await run(at.paths, second.runId, "start", reuse.runner), "paused");
  expect("reuse of a stopped run prompts", reuse.prompts, ["B2"]);
  const state = saved(at, second.runId).state;
  if (!state.resumeSeed?.callBlockers?.length) throw new Error(`the reuse run saved no blockers: ${JSON.stringify(state.resumeSeed)}`);
  write(
    "reuse-blockers",
    at,
    "A, B, C and D. The first run was stopped while D ran. B was then edited to B2, and a run that reuses the first one replayed A, failed at B2 and paused. Its seed holds the first run's B and C as candidates and D as a blocker.",
    { four: four("B2") },
    [saved(at, first.runId), saved(at, second.runId)],
  );
}

{
  const { at, runId } = await failedStep();
  const again = fake((prompt) => (prompt === "C" ? boom() : undefined));
  expect("legacy resume", await run(at.paths, runId, "resume", again.runner), "paused");
  expect("legacy resume prompts", again.prompts, ["C"]);
  const run1 = saved(at, runId);
  if (run1.state.legacyResume !== true) throw new Error("the resumed run has no legacy marker");
  write("legacy-marker", at, "Three steps. C failed, the run resumed, and C failed again. The state has legacyResume.", { three: three("A") }, [run1]);
}

{
  const { at, runId } = await failedStep();
  const run1 = saved(at, runId);
  // The hashes stand in for an older format's: each row keeps its call hash.
  run1.state.runtime!.inputsFormat = 1;
  for (const call of run1.state.calls ?? []) call.inputsHash = sha(`format 1 ${call.inputsHash}`);
  write("older-inputs-format", at, "The failed-step run, saved with inputs format 1. Its inputs hashes differ from what the code computes now. Written by hand from the failed-step run.", { three: three("A") }, [run1]);
}

{
  const { at, runId } = await failedStep();
  const run1 = saved(at, runId);
  delete run1.state.calls;
  delete run1.state.callsAllocated;
  write("no-call-rows", at, "The failed-step run with no call rows, as a code before call rows saved it. Written by hand from the failed-step run.", { three: three("A") }, [run1]);
}

{
  const at = scene({ asks: asks("A") });
  const source = fake();
  const first = createRun(at.paths, { workflow: "asks", projectDir: at.projectDir, inputs: {} });
  expect("asks source", await run(at.paths, first.runId, "start", source.runner, true), "completed");
  edit(at.projectDir, "asks", asks("A2"));
  const reuse = fake((prompt) => (prompt === "A2" ? boom() : undefined));
  const second = createRun(at.paths, { workflow: "asks", projectDir: at.projectDir, inputs: {}, reuseFrom: loadRecord(at.paths, first.runId)! });
  expect("asks reuse", await run(at.paths, second.runId, "start", reuse.runner), "paused");
  const run2 = saved(at, second.runId);
  // An older code kept an answered question in the seed as an injection, not a candidate.
  const seed = run2.state.resumeSeed!;
  const asked = seed.candidates.find((candidate) => candidate.call.kind === "checkpoint");
  if (!asked) throw new Error(`the reuse seed holds no question: ${JSON.stringify(seed)}`);
  run2.state.resumeSeed = {
    ...seed,
    candidates: seed.candidates.filter((candidate) => candidate !== asked),
    checkpointInjections: [
      {
        checkpointDecision: "explicit-v1",
        sourceRunId: asked.sourceRunId,
        recordedIndex: asked.recordedIndex,
        hash: asked.call.hash,
        path: asked.call.path,
        inputsHash: asked.call.inputsHash,
        decision: asked.entry.result,
      } as NonNullable<typeof seed.checkpointInjections>[number],
    ],
  };
  write(
    "checkpoint-injection",
    at,
    "A, the question 'Ship it?', then B. The first run completed with the answer true. A was edited to A2, and a run that reuses the first one failed at A2 and paused. Its seed holds the answer as a checkpoint injection, as an older code wrote it. The injection is written by hand from the seed's candidate.",
    { asks: asks("A2") },
    [saved(at, first.runId), run2],
  );
}

{
  const { at, runId } = await failedStep();
  const again = fake();
  expect("resumed source", await run(at.paths, runId, "resume", again.runner), "completed");
  const run1 = saved(at, runId);
  if (run1.state.legacyResume !== true) throw new Error("the resumed run has no legacy marker");
  edit(at.projectDir, "three", three("A2"));
  write("resumed-source", at, "Three steps. C failed, the run resumed and completed, so it has legacyResume. A was then edited to A2. The test starts a run that reuses it.", { three: three("A2") }, [run1]);
}

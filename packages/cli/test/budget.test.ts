// Piece 14, budget. A run may have a token budget: `budgetTokens` in the config or
// `--budget <tokens>` on run, rerun and resume, with the flag winning. None by default. The budget
// counts per go, like the time limit, so each start and each resume gets all of it. When a go
// reaches it, the run pauses with reason budget (design, "Budget").
//
// The fake programs answer every step with the same 150 tokens, so most tests below give the
// worker the in-process fake runner instead, which reports 1,000 tokens per step through onUsage.
// The mid-step test runs on the fake claude in a worker process of its own: its tool call message
// carries 150 tokens and the step then holds, so only a cancel during the step can stop it. The
// fake codex sends its tokens only when a turn ends, so it cannot show a cancel during a step.
//
// Choices the design leaves open, made here:
// - At paused: budget, wait's next holds `sous resume <run> --json` and a resume with
//   `--budget <n>`, where n is a number above the budget the run had, so the call works as is.
// - A bad budget (0, a negative number, text) is a bad_argument error with exit 64. Its message
//   names the value, and its call is a sous call that parses.
// - A bad budget on resume leaves the run paused.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRecord, type HomePaths } from "@sous-run/engine";
import { fakeRunner, inProcess, readState, testHome } from "@sous-run/engine/testing";
import { sous } from "./sous.js";
import { callProblem } from "./helpers/calls.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "SOUS_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];

/** A workflow of n agent steps in a row, s1 to sn, that returns their answers. */
function steps(name: string, n: number): string {
  const labels = Array.from({ length: n }, (_, i) => `s${i + 1}`);
  return [
    `export const meta = { name: '${name}', description: '${n} agent steps' }`,
    ...labels.map((label) => `const ${label} = await agent('${label}', { label: '${label}' })`),
    `return [${labels.join(", ")}]`,
  ].join("\n");
}

const WORKFLOWS = { three: steps("three", 3), five: steps("five", 5) };

/** Workers in this process whose fake agent spends 1,000 tokens on each step and answers "<prompt> done". */
function spender() {
  const { runner, calls } = fakeRunner((call) => {
    const onUsage = call.options.onUsage as ((usage: Record<string, number>) => void) | undefined;
    onUsage?.({ input: 800, output: 200, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0 });
    return `${call.prompt} done`;
  });
  const workers = inProcess({ inner: runner });
  return { ...workers, prompts: () => calls.map((call) => call.prompt) };
}

type Workers = ReturnType<typeof spender>;

/** The JSON object sous printed. */
function json(printed: { code: number; out: string }): Record<string, any> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  return parsed as Record<string, any>;
}

/** Start a run as `sous run <argv> --json` does, with the workers in this process, and give its id. */
async function run(paths: HomePaths, projectDir: string, workers: Workers, argv: string[]): Promise<string> {
  const printed = await sous(paths, ["run", ...argv, "--json", "--project", projectDir], { launch: workers.launch });
  assert.equal(printed.code, 0, printed.out);
  return json(printed).runId as string;
}

const budgetOf = (paths: HomePaths, runId: string) => (loadRecord(paths, runId) as { budget?: unknown } | undefined)?.budget;

/** A three step run with --budget 1500 that paused on its budget after the second step. */
async function pausedOnBudget() {
  const { paths, projectDir } = testHome(WORKFLOWS);
  const workers = spender();
  const runId = await run(paths, projectDir, workers, ["three", "--budget", "1500"]);
  const ended = await workers.ended(runId);
  assert.equal(ended?.status, "paused", `the run paused: ${JSON.stringify(ended)}`);
  return { paths, projectDir, workers, runId };
}

describe("piece 14: budget", () => {
  it("run --budget 1500 on three agent steps pauses after the second, and its wait exits 2 with paused: budget and the resume calls", async () => {
    const { paths, workers, runId } = await pausedOnBudget();
    assert.equal(readState(paths, runId)?.pauseReason, "budget");
    assert.deepEqual(workers.prompts(), ["s1", "s2"], "the third step never started");
    assert.equal(budgetOf(paths, runId), 1500, "the record stores the budget");

    const waited = await sous(paths, ["wait", runId, "--json"]);
    assert.equal(waited.code, 2, waited.out);
    const wait = json(waited);
    assert.equal(wait.status, "paused", waited.out);
    assert.equal(wait.pauseReason, "budget", waited.out);
    const calls = (wait.next as Array<{ call: string }>).map((next) => next.call);
    for (const call of calls) assert.equal(callProblem(call), undefined, call);
    assert.ok(calls.includes(`sous resume ${runId} --json`), JSON.stringify(calls));
    const more = calls.map((call) => new RegExp(`^sous resume ${runId} --budget (\\d+)( --json)?$`).exec(call)?.[1]).find(Boolean);
    assert.ok(more, `next holds a resume with --budget: ${JSON.stringify(calls)}`);
    assert.ok(Number(more) > 1500, `the --budget in next is more than the run had: ${more}`);

    assert.match((await sous(paths, ["list"])).out, /paused: budget/);
    const status = json(await sous(paths, ["status", "--json"]));
    const needs = (status.needsYou as Array<{ runId: string; what: string }>).find((entry) => entry.runId === runId);
    assert.equal(needs?.what, "paused: budget", JSON.stringify(status.needsYou));
  });

  it("a resume gets a fresh 1,500 tokens and finishes the third step", async () => {
    const { paths, workers, runId } = await pausedOnBudget();
    const resumed = await sous(paths, ["resume", runId, "--json"], { launch: workers.launch });
    assert.equal(resumed.code, 0, resumed.out);
    const done = await workers.ended(runId);
    assert.equal(done?.status, "completed", JSON.stringify(done));
    assert.deepEqual(JSON.parse(JSON.stringify(done?.result)), ["s1 done", "s2 done", "s3 done"]);
    assert.deepEqual(workers.prompts(), ["s1", "s2", "s3"], "the resume ran only the third step");
  });

  it("budgetTokens in the config sets the budget of a run that gives no --budget", async () => {
    const { paths, projectDir } = testHome(WORKFLOWS, { budgetTokens: 1500 });
    const workers = spender();
    const runId = await run(paths, projectDir, workers, ["three"]);
    assert.equal((await workers.ended(runId))?.status, "paused");
    assert.equal(readState(paths, runId)?.pauseReason, "budget");
    assert.deepEqual(workers.prompts(), ["s1", "s2"]);
  });

  it("--budget wins over budgetTokens in the config", async () => {
    const { paths, projectDir } = testHome(WORKFLOWS, { budgetTokens: 1500 });
    const workers = spender();
    const runId = await run(paths, projectDir, workers, ["three", "--budget", "10000"]);
    const done = await workers.ended(runId);
    assert.equal(done?.status, "completed", JSON.stringify(done));
    assert.deepEqual(workers.prompts(), ["s1", "s2", "s3"]);
    assert.equal(budgetOf(paths, runId), 10000);
  });

  it("with no budget, a run spends what it needs and completes", async () => {
    const { paths, projectDir } = testHome(WORKFLOWS);
    const workers = spender();
    const runId = await run(paths, projectDir, workers, ["five"]);
    const done = await workers.ended(runId);
    assert.equal(done?.status, "completed", JSON.stringify(done));
    assert.deepEqual(workers.prompts(), ["s1", "s2", "s3", "s4", "s5"]);
    assert.equal(budgetOf(paths, runId), undefined, "the record has no budget");
  });

  for (const bad of ["0", "-5", "abc"]) {
    it(`run --budget ${bad} is a usage error with exit 64 and a call that works`, async () => {
      const { paths, projectDir } = testHome(WORKFLOWS);
      const workers = spender();
      const printed = await sous(paths, ["run", "three", "--budget", bad, "--json", "--project", projectDir], { launch: workers.launch });
      assert.equal(printed.code, 64, printed.out);
      const error = json(printed).error as { code: string; message: string; change: string; call: unknown };
      assert.equal(error.code, "bad_argument", printed.out);
      assert.doesNotMatch(error.message, /does not take --budget/, "run takes --budget");
      assert.match(error.message, /budget/);
      assert.ok(error.message.includes(bad), `the message names the value ${bad}: ${error.message}`);
      assert.equal(typeof error.call, "string", printed.out);
      assert.equal(callProblem(error.call as string), undefined, String(error.call));
      assert.equal(workers.launched.length, 0, "no run started");
    });
  }

  it("resume --budget sets the budget of that go, and a bad one leaves the run paused", async () => {
    // Five steps at 1,000 each with a budget of 1,500 in the config: the start pauses after s2. A
    // resume with the config's budget would pause again after s4. --budget 5000 finishes the run.
    const { paths, projectDir } = testHome(WORKFLOWS, { budgetTokens: 1500 });
    const workers = spender();
    const runId = await run(paths, projectDir, workers, ["five"]);
    assert.equal((await workers.ended(runId))?.status, "paused");
    assert.equal(readState(paths, runId)?.pauseReason, "budget");

    const refused = await sous(paths, ["resume", runId, "--budget", "abc", "--json"], { launch: workers.launch });
    assert.equal(refused.code, 64, refused.out);
    assert.equal(json(refused).error?.code, "bad_argument", refused.out);
    assert.equal(workers.launched.length, 1, "the bad resume started no worker");
    assert.equal(readState(paths, runId)?.status, "paused");

    const resumed = await sous(paths, ["resume", runId, "--budget", "5000", "--json"], { launch: workers.launch });
    assert.equal(resumed.code, 0, resumed.out);
    const done = await workers.ended(runId);
    assert.equal(done?.status, "completed", JSON.stringify(done));
    assert.deepEqual(workers.prompts(), ["s1", "s2", "s3", "s4", "s5"]);
  });

  it("rerun --budget gives the new run that budget", async () => {
    const { paths, projectDir } = testHome(WORKFLOWS);
    const workers = spender();
    const first = await run(paths, projectDir, workers, ["three"]);
    assert.equal((await workers.ended(first))?.status, "completed");

    const printed = await sous(paths, ["rerun", first, "--budget", "1500", "--json"], { launch: workers.launch });
    assert.equal(printed.code, 0, printed.out);
    const second = json(printed).runId as string;
    assert.notEqual(second, first);
    assert.equal((await workers.ended(second))?.status, "paused");
    assert.equal(readState(paths, second)?.pauseReason, "budget");
    assert.equal(budgetOf(paths, second), 1500);
    assert.deepEqual(workers.prompts(), ["s1", "s2", "s3", "s1", "s2"]);
  });

  it("a step that goes over the budget is cancelled while it runs", async () => {
    // The fake claude writes its tool call, which spent 150 tokens, then holds until the file
    // "release" exists. Only a cancel during the step pauses the run before the test releases it.
    const dir = mkdtempSync(join(tmpdir(), "sous-budget-"));
    process.env.FAKE_LOG = join(dir, "fake.log");
    process.env.FAKE_RULES = join(dir, "rules.json");
    writeFileSync(process.env.FAKE_RULES, JSON.stringify([{ match: "Build", tool: "echo working", hold: "release", answer: "Done." }]));
    const { paths, projectDir } = testHome(
      { long: "export const meta = { name: 'long', description: 'one long step', place: 'none' }\nreturn await agent('Build it.', { label: 'impl', model: 'claude/haiku' })" },
      { claudePath: join(FAKES, "claude"), codexPath: join(FAKES, "codex") },
    );
    const started = await sous(paths, ["run", "long", "--budget", "100", "--json", "--project", projectDir], { env: {} });
    try {
      assert.equal(started.code, 0, started.out);
      const runId = json(started).runId as string;
      const waited = await sous(paths, ["wait", runId, "--timeout", "20", "--json"], { env: {} });
      assert.equal(waited.code, 2, waited.out);
      const wait = json(waited);
      assert.equal(wait.pauseReason, "budget", waited.out);
      const calls = (wait.next as Array<{ call: string }>).map((next) => next.call);
      for (const call of calls) assert.equal(callProblem(call), undefined, call);
      assert.ok(calls.includes(`sous resume ${runId} --json`), JSON.stringify(calls));
      const more = calls.map((call) => new RegExp(`^sous resume ${runId} --budget (\\d+)( --json)?$`).exec(call)?.[1]).find(Boolean);
      assert.ok(more, `next holds a resume with --budget: ${JSON.stringify(calls)}`);
      assert.ok(Number(more) > 100, `the --budget in next is more than the run had: ${more}`);
      const log = existsSync(process.env.FAKE_LOG) ? readFileSync(process.env.FAKE_LOG, "utf8").split("\n").filter(Boolean) : [];
      assert.equal(log.length, 1, "the step ran once and was not retried");
    } finally {
      // Let a held step end, so a failure leaves no fake waiting.
      writeFileSync(join(dir, "release"), "");
    }
  });
});

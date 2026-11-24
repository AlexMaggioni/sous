// Piece 14, budget, review fixes. The fake runner in this process reports 1,000 tokens per step
// through onUsage, and its tokens count when each step ends.
// - A bad budgetTokens in the config refuses the run with a call that parses.
// - show offers the same resume with --budget as wait at paused: budget.
// - The run and resume lines of events.jsonl name the budget they set.
// - When the last step crosses the budget, the run completes and the worker log says no new step
//   starts, not that the run pauses.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HomePaths } from "@sous/engine";
import { fakeRunner, inProcess, readActions, readState, testHome } from "@sous/engine/testing";
import { sous } from "./sous.js";
import { callProblem } from "./helpers/calls.js";

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

const WORKFLOWS = { three: steps("three", 3) };

/** Workers in this process whose fake agent spends 1,000 tokens on each step, with a log. */
function spender() {
  const { runner, calls } = fakeRunner((call) => {
    const onUsage = call.options.onUsage as ((usage: Record<string, number>) => void) | undefined;
    onUsage?.({ input: 800, output: 200, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0 });
    return `${call.prompt} done`;
  });
  const lines: string[] = [];
  const workers = inProcess({ inner: runner, log: (line) => lines.push(line) });
  return { ...workers, lines, prompts: () => calls.map((call) => call.prompt) };
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

describe("piece 14: budget review fixes", () => {
  it("a bad budgetTokens in the config refuses the run with a call that parses and gives a budget", async () => {
    const { paths, projectDir } = testHome(WORKFLOWS, { budgetTokens: "lots" });
    const workers = spender();
    const printed = await sous(paths, ["run", "three", "--json", "--project", projectDir], { launch: workers.launch });
    assert.notEqual(printed.code, 0, printed.out);
    const error = json(printed).error as { message: string; call: unknown };
    assert.match(error.message, /budgetTokens/, printed.out);
    assert.equal(typeof error.call, "string", `the refusal has a call: ${printed.out}`);
    assert.equal(callProblem(error.call as string), undefined, String(error.call));
    assert.match(error.call as string, /--budget \d+/, String(error.call));
    assert.equal(workers.launched.length, 0, "no run started");
  });

  it("show offers a resume with a bigger --budget at paused: budget, as wait does", async () => {
    const { paths, projectDir } = testHome(WORKFLOWS);
    const workers = spender();
    const runId = await run(paths, projectDir, workers, ["three", "--budget", "1500"]);
    assert.equal((await workers.ended(runId))?.status, "paused");
    assert.equal(readState(paths, runId)?.pauseReason, "budget");

    const shown = await sous(paths, ["show", runId, "--json"]);
    const calls = (json(shown).next as Array<{ call: string }>).map((next) => next.call);
    for (const call of calls) assert.equal(callProblem(call), undefined, call);
    assert.ok(calls.includes(`sous resume ${runId} --json`), JSON.stringify(calls));
    const more = calls.map((call) => new RegExp(`^sous resume ${runId} --budget (\\d+)( --json)?$`).exec(call)?.[1]).find(Boolean);
    assert.ok(more, `show's next holds a resume with --budget: ${JSON.stringify(calls)}`);
    assert.ok(Number(more) > 1500, `the --budget in next is more than the run had: ${more}`);
  });

  it("the run and resume lines of events.jsonl name the budget they set", async () => {
    const { paths, projectDir } = testHome(WORKFLOWS);
    const workers = spender();
    const runId = await run(paths, projectDir, workers, ["three", "--budget", "1500"]);
    assert.equal((await workers.ended(runId))?.status, "paused");
    const resumed = await sous(paths, ["resume", runId, "--budget", "5000", "--json"], { launch: workers.launch });
    assert.equal(resumed.code, 0, resumed.out);
    assert.equal((await workers.ended(runId))?.status, "completed");

    const started = readActions(paths, { runId, act: "run" });
    assert.equal(started.length, 1, JSON.stringify(started));
    assert.equal((started[0] as { budget?: unknown }).budget, 1500, JSON.stringify(started[0]));
    const resumes = readActions(paths, { runId, act: "resume" });
    assert.equal(resumes.length, 1, JSON.stringify(resumes));
    assert.equal((resumes[0] as { budget?: unknown }).budget, 5000, JSON.stringify(resumes[0]));
  });

  it("when the last step crosses the budget, the run completes and the log says no new step starts", async () => {
    // Three steps at 1,000 each under a budget of 2,500: the third crosses it as it ends.
    const { paths, projectDir } = testHome(WORKFLOWS);
    const workers = spender();
    const runId = await run(paths, projectDir, workers, ["three", "--budget", "2500"]);
    const done = await workers.ended(runId);
    assert.equal(done?.status, "completed", JSON.stringify(done));
    assert.deepEqual(workers.prompts(), ["s1", "s2", "s3"]);
    const line = workers.lines.find((entry) => /budget\s+2500 tokens reached/.test(entry));
    assert.ok(line, `the log says the budget was reached: ${JSON.stringify(workers.lines)}`);
    assert.match(line, /no new step starts/);
    assert.doesNotMatch(line, /pauses/, "the run did not pause");
  });
});

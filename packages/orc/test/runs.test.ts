import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WorkflowError, WorkflowErrorCode, type AgentRunner } from "@automatalabs/shared-types";
import { checkWorkflow } from "../src/check.js";
import { saveSchedules, tick } from "../src/daemon.js";
import { ensureHome, homePaths, type HomePaths } from "../src/home.js";
import { listQuestions, writeAnswer } from "../src/inbox.js";
import { createRun } from "../src/launch.js";
import { loadRecord } from "../src/records.js";
import { managerFor, runWorker } from "../src/worker.js";

// Whole runs in this process, with a fake agent runner, the way `orc run` drives them.

function setup(workflows: Record<string, string>, config: Record<string, unknown> = {}): { paths: HomePaths; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "orc-runs-"));
  const paths = ensureHome(homePaths(join(root, "home")));
  writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder", ...config }));
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".orchestrator", "workflows"), { recursive: true });
  mkdirSync(join(projectDir, ".orchestrator", "agents"), { recursive: true });
  for (const [name, script] of Object.entries(workflows)) writeFileSync(join(projectDir, ".orchestrator", "workflows", `${name}.js`), script);
  return { paths, projectDir };
}

interface Call {
  prompt: string;
  label?: string;
  options: Record<string, unknown>;
}

function fakeRunner(answer: (call: Call, calls: Call[]) => unknown): { runner: AgentRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner = {
    async run(prompt: string, options: Record<string, unknown> = {}) {
      const call = { prompt, label: options.label as string | undefined, options };
      calls.push(call);
      (options.onSessionOpen as ((ref: unknown) => void) | undefined)?.({ sessionId: `s${calls.length}`, backendId: "claude", cwd: options.cwd, reopen: { load: true, resume: true, list: true } });
      return answer(call, calls);
    },
  } as unknown as AgentRunner;
  return { runner, calls };
}

async function answerWhenAsked(paths: HomePaths, runId: string, reply: (prompt: string) => unknown, times = 1): Promise<string[]> {
  const asked: string[] = [];
  for (let waited = 0; asked.length < times && waited < 15_000; waited += 20) {
    const open = listQuestions(paths, runId);
    if (open.length) {
      const question = open[0]!;
      asked.push(question.prompt);
      writeAnswer(paths, question, reply(question.prompt));
      while (listQuestions(paths, runId).some((q) => q.id === question.id)) await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return asked;
}

const quiet = () => {};

describe("runs", () => {
  it("an agent asks a question, the answer comes through the inbox, and the same session goes on", async () => {
    const { paths, projectDir } = setup({
      asking: `export const meta = { name: 'asking', description: 'asks', inputs: { task: 'What to do' } }
const out = await agent('Do ' + args.task, { label: 'worker', ask: true })
return out`,
    });
    const { runner, calls } = fakeRunner((call) => (call.label === "worker" ? "QUESTION: Postgres or SQLite?" : `built with ${/answered: (\w+)/.exec(call.prompt)?.[1]}`));
    const record = createRun(paths, { workflow: "asking", projectDir, inputs: { task: "the store" } });
    const running = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    const asked = await answerWhenAsked(paths, record.runId, () => "SQLite");
    const result = await running;
    assert.equal(result?.status, "completed");
    assert.equal(result?.result, "built with SQLite");
    assert.match(asked[0]!, /worker asks: Postgres or SQLite\?/);
    assert.equal((calls[1]!.options.continueFromSession as { sessionId: string }).sessionId, "s1");
    assert.equal(loadRecord(paths, record.runId)?.pid, undefined, "the record forgets the worker once it ends");
  });

  it("a breakpoint sent back with a note runs the step again with that note, then approve goes on", async () => {
    const { paths, projectDir } = setup({
      checked: `export const meta = { name: 'checked', description: 'a breakpoint' }
const draft = await breakpoint('Check the plan', (note) => agent('Plan it' + (note ? '. Change: ' + note : ''), { label: 'planner' }))
return draft`,
    });
    const { runner, calls } = fakeRunner((call) => (call.prompt.includes("Change: shorter") ? "short plan" : "long plan"));
    const record = createRun(paths, { workflow: "checked", projectDir, inputs: {} });
    const running = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    const replies = [{ decision: "send back", note: "shorter" }, "approve"];
    const asked = await answerWhenAsked(paths, record.runId, () => replies.shift(), 2);
    const result = await running;
    assert.equal(result?.status, "completed");
    assert.equal(result?.result, "short plan");
    assert.equal(calls.length, 2);
    assert.match(asked[0]!, /^Breakpoint: Check the plan\n\nlong plan/);
    assert.match(asked[1]!, /short plan/);
  });

  it("a step that keeps failing pauses the run on it, and resume runs it again while finished steps stay done", async () => {
    const { paths, projectDir } = setup(
      {
        flaky: `export const meta = { name: 'flaky', description: 'a step that fails' }
const first = await agent('first', { label: 'first' })
const second = await agent('second', { label: 'second' })
return { first, second }`,
      },
      { retries: 1 },
    );
    let broken = true;
    const { runner, calls } = fakeRunner((call) => {
      if (call.label === "second" && broken) throw new WorkflowError("the tests fail", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
      return `${call.label} done`;
    });
    const record = createRun(paths, { workflow: "flaky", projectDir, inputs: {} });
    const paused = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(paused?.status, "paused");
    const state = managerFor(paths, projectDir).getPersistence().load(record.runId);
    assert.equal(state?.pauseReason, "step_failed");
    assert.match(String(state?.reason), /step "second" failed after 2 tries: .*the tests fail/);
    assert.deepEqual(calls.map((c) => c.label), ["first", "second", "second"]);

    broken = false;
    const resumed = await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(resumed?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(resumed?.result)), { first: "first done", second: "second done" });
    assert.deepEqual(calls.slice(3).map((c) => c.label), ["second"], "first is not run again");
  });

  it("per-run step changes and a default model reach the agent", async () => {
    const { paths, projectDir } = setup({
      changes: `export const meta = { name: 'changes', description: 'step changes' }
return await agent('review', { label: 'reviewer' })`,
    });
    const { runner, calls } = fakeRunner(() => "ok");
    const record = createRun(paths, { workflow: "changes", projectDir, inputs: {}, overrides: { reviewer: { model: "claude/opus" } } });
    await runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
    assert.equal(calls[0]!.options.model, "claude/opus");
  });
});

describe("check", () => {
  it("finds missing workflows, agents and MCP servers without running anything", () => {
    const { paths, projectDir } = setup({
      outer: `export const meta = { name: 'outer', description: 'nests', inputs: { ticket: 'The ticket' } }
await workflow('inner', {})
await workflow('ghost', {})
await agent('x', { agentType: 'implementer', mcp: ['linear'] })
await agent('y', { agentType: 'reviewer' })`,
      inner: `export const meta = { name: 'inner', description: 'inner' }
await agent('z', { agentType: 'nobody' })`,
    });
    writeFileSync(join(projectDir, ".orchestrator", "agents", "implementer.md"), "---\nname: implementer\ndescription: builds\n---\nBuild it.\n");
    writeFileSync(join(projectDir, ".orchestrator", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\n---\nReview it.\n");
    const result = checkWorkflow(paths, projectDir, "outer", { tickt: "x" });
    assert.deepEqual(result.problems.sort(), [
      'MCP server "linear" is not in mcp.json',
      'no agent "nobody" (in inner). Agents live in .orchestrator/agents/ or ~/.orchestrator/agents/ as <name>.md.',
      'no saved workflow "ghost"',
      "missing input --ticket (The ticket)",
      "unknown input --tickt. This workflow takes: --ticket",
    ].sort());
    writeFileSync(join(projectDir, ".orchestrator", "mcp.json"), JSON.stringify({ linear: { command: "npx", args: ["linear-mcp"] } }));
    assert.equal(checkWorkflow(paths, projectDir, "outer").problems.some((p) => p.includes("linear")), false);
  });
});

describe("service", () => {
  it("starts a schedule once per matching minute, and skips it while its last run is unfinished", () => {
    const { paths, projectDir } = setup({ nightly: `export const meta = { name: 'nightly', description: 'n' }\nreturn 1` });
    saveSchedules(paths, [{ name: "n", workflow: join(projectDir, ".orchestrator", "workflows", "nightly.js"), projectDir, cron: "0 3 * * *", inputs: {}, enabled: true, createdAt: "" }]);
    const started: string[] = [];
    const spawn = (runId: string) => started.push(runId);
    tick(paths, { now: new Date(2026, 10, 21, 2, 59), spawn, log: quiet });
    assert.equal(started.length, 0);
    tick(paths, { now: new Date(2026, 10, 21, 3, 0, 5), spawn, log: quiet });
    tick(paths, { now: new Date(2026, 10, 21, 3, 0, 40), spawn, log: quiet });
    assert.equal(started.length, 1, "once in that minute");
    const record = loadRecord(paths, started[0]!);
    assert.equal(record?.origin, "schedule");
    assert.equal(record?.priority, "schedule");

    // The run never started, so it counts as unfinished only once the engine knows it. Mark it paused.
    const lines: string[] = [];
    const manager = managerFor(paths, projectDir);
    const persistence = manager.getPersistence() as unknown as { save?: (state: unknown) => void };
    if (typeof persistence.save === "function") {
      persistence.save({ runId: started[0], status: "paused", pauseReason: "requested", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), agents: [], logs: [], phases: [] });
      tick(paths, { now: new Date(2026, 10, 22, 3, 0), spawn, log: (line) => lines.push(line) });
      assert.equal(started.length, 1);
      assert.match(lines.join("\n"), /skipped, run .* has not finished/);
    }
  });
});

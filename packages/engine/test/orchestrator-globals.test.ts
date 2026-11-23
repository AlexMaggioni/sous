import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, RunOptions } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { JournalEntry } from "../src/workflow-result.js";
import type { AgentDefinition, AgentRegistry } from "../src/agent-registry.js";
import { parseDurationSeconds } from "../src/orchestrator-globals.js";
import { runWorkflow } from "../src/workflow.js";
import { createSteps } from "../src/steps/steps.js";
import { homePaths } from "../src/runs/home.js";
import { WorkflowManager } from "../src/workflow-manager.js";

// Code steps, questions, breakpoints, choose(), and the per-step options.

interface Call {
  prompt: string;
  options: Record<string, unknown>;
}

function recordingRunner(answer: (prompt: string, options: Record<string, unknown>, calls: Call[]) => unknown): {
  runner: AgentRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: AgentRunner = {
    async run<S extends TSchema | undefined = undefined>(prompt: string, options?: RunOptions<S>): Promise<AgentResult<S>> {
      const opts = { ...(options ?? {}) } as Record<string, unknown>;
      calls.push({ prompt, options: opts });
      opts.onSessionOpen && (opts.onSessionOpen as (ref: unknown) => void)({
        sessionId: `session-${calls.length}`,
        backendId: "claude",
        cwd: opts.cwd,
      });
      return answer(prompt, opts, calls) as AgentResult<S>;
    },
  };
  return { runner, calls };
}

/** A folder for code steps, with a script file and the file waitUntil checks. */
function codeFolder(): string {
  const cwd = mkdtempSync(join(tmpdir(), "code-steps-"));
  mkdirSync(join(cwd, "scripts"));
  writeFileSync(join(cwd, "scripts", "check.sh"), 'echo "args $1"; cat > "$ORC_RESULT"\n');
  writeFileSync(join(cwd, "done"), "");
  return cwd;
}

describe("code steps", () => {
  it("run sh, js, py, run and waitUntil in the engine, never in the agent runner", async () => {
    const { runner, calls } = recordingRunner(() => "agent");
    const cwd = codeFolder();
    const started: Array<{ prompt: string; model?: string }> = [];
    const script = `export const meta = { name: 'code', description: 'code steps' }
const a = await sh('echo hi', { allowFail: true, timeout: '2m' })
const b = await js('return input.n + 1', { n: 1 })
const c = await py('return input', [1, 2])
const d = await run('scripts/check.sh', { args: ['x'], input: { y: 1 } })
const e = await waitUntil('test -f done', { every: '30s', timeout: '1h' })
return { a, b, c, d, e }`;
    const result = await runWorkflow<Record<string, { code: number; stdout: string; result: unknown }>>(script, {
      agent: runner,
      cwd,
      persistLogs: false,
      onAgentStart: (event) => started.push({ prompt: event.prompt, model: event.model }),
    });
    assert.equal(calls.length, 0, "code steps never reach the agent runner");
    // Each step keeps the identity it had as an agent call: the spec as JSON and the model "exec".
    assert.ok(started.every((step) => step.model === "exec"));
    const specs = started.map((step) => JSON.parse(step.prompt));
    assert.deepEqual(specs[0], { kind: "sh", command: "echo hi", allowFail: true });
    assert.deepEqual(specs[1], { kind: "js", source: "return input.n + 1", input: { n: 1 } });
    assert.deepEqual(specs[2], { kind: "py", source: "return input", input: [1, 2] });
    assert.deepEqual(specs[3], { kind: "file", file: "scripts/check.sh", args: ["x"], input: { y: 1 } });
    assert.deepEqual(specs[4], { kind: "wait", command: "test -f done", everySeconds: 30, timeoutSeconds: 3600 });
    const out = JSON.parse(JSON.stringify(result.result)) as Record<string, { code: number; stdout: string; result?: unknown }>;
    assert.equal(out.a!.stdout, "hi\n");
    assert.equal(out.b!.result, 2);
    assert.deepEqual(out.c!.result, [1, 2]);
    assert.equal(out.d!.stdout, "args x\n");
    assert.deepEqual(out.d!.result, { y: 1 });
    assert.equal(out.e!.code, 0);
    assert.equal(result.tokenUsage.input + result.tokenUsage.output, 0, "a code step uses no model");
  });

  it("need no agent program", async () => {
    const empty = mkdtempSync(join(tmpdir(), "no-programs-"));
    const steps = createSteps({
      cwd: empty,
      inner: { run: async () => "ok" } as never,
      programs: () => ({ env: { PATH: empty }, usualDirs: [] }),
    });
    const result = await runWorkflow<{ result: unknown }>(`export const meta = { name: 'plain', description: 'plain' }
return await js('return 1')`, { agent: steps, cwd: empty, persistLogs: false });
    assert.equal(result.result.result, 1);
  });

  it("keep their time limit and retries", async () => {
    const { runner } = recordingRunner(() => "agent");
    const cwd = codeFolder();
    const started = Date.now();
    const slow = await runWorkflow(`export const meta = { name: 'slow', description: 'slow' }
return await sh('sleep 5', { timeout: 0.2 })`, { agent: runner, cwd, persistLogs: false });
    assert.ok(Date.now() - started < 4000, "the time limit stopped the step");
    assert.equal(slow.result, null, "a failed step gives null when the run does not pause on it");
    assert.match(String(slow.calls?.[0]?.error?.message), /^timed out after 0s$/);
    const flaky = await runWorkflow<{ stdout: string }>(`export const meta = { name: 'flaky', description: 'flaky' }
return await sh('echo x >> tries; test $(wc -l < tries) -ge 2 && echo second', { retries: 1 })`, { agent: runner, cwd, persistLogs: false });
    assert.equal(flaky.result.stdout, "second\n");
    assert.equal(readFileSync(join(cwd, "tries"), "utf8"), "x\nx\n");
  });

  it("get the environment the run gives them", async () => {
    const { runner } = recordingRunner(() => "agent");
    const cwd = codeFolder();
    const result = await runWorkflow<{ stdout: string }>(`export const meta = { name: 'envs', description: 'envs' }
return await sh('echo "$FROM_BASE $SECRET"')`, {
      agent: runner,
      cwd,
      persistLogs: false,
      codeEnv: { env: { SECRET: "s3" }, base: { PATH: process.env.PATH, FROM_BASE: "b1" } },
    });
    assert.equal(result.result.stdout, "b1 s3\n");
  });

  it("are journaled, so a resumed run does not run them twice", async () => {
    const { runner } = recordingRunner(() => "agent");
    const cwd = codeFolder();
    const script = `export const meta = { name: 'once', description: 'once' }
const a = await sh('echo ran >> marker && wc -l < marker')
return a.stdout.trim()`;
    const journal: JournalEntry[] = [];
    const run1 = await runWorkflow<string>(script, { agent: runner, cwd, persistLogs: false, onAgentJournal: (e) => journal.push(e) });
    assert.equal(run1.result, "1");
    const run2 = await runWorkflow<string>(script, {
      agent: runner,
      cwd,
      persistLogs: false,
      resumeJournal: new Map(journal.map((e) => [e.index, e])),
    });
    assert.equal(run2.result, "1", "the replay reuses the recorded result");
    assert.equal(readFileSync(join(cwd, "marker"), "utf8"), "ran\n", "the step ran once");
  });
});

describe("ask and breakpoint", () => {
  it("ask() returns the user's answer", async () => {
    const { runner } = recordingRunner(() => "unused");
    const asked: Array<{ prompt: string; options: unknown }> = [];
    const script = `export const meta = { name: 'ask', description: 'ask' }
return await ask('Which one?', { choices: ['a', 'b'] })`;
    const result = await runWorkflow<string>(script, {
      agent: runner,
      persistLogs: false,
      confirm: async (prompt, options) => {
        asked.push({ prompt, options });
        return "b";
      },
    });
    assert.equal(result.result, "b");
    assert.equal(asked[0]!.prompt, "Which one?");
    assert.deepEqual(JSON.parse(JSON.stringify(asked[0]!.options)), { kind: "select", choices: ["a", "b"] });
  });

  it("breakpoint(title, step) reruns the step with the note until approved", async () => {
    const { runner, calls } = recordingRunner((prompt) => `draft for: ${prompt}`);
    const replies = [{ decision: "send back", note: "shorter please" }, "approve"];
    const script = `export const meta = { name: 'bp', description: 'bp' }
return await breakpoint('Check the plan', (note) => agent('write a plan' + (note ? ' / note: ' + note : ''), { label: 'plan' }))`;
    const result = await runWorkflow<string>(script, {
      agent: runner,
      persistLogs: false,
      confirm: async () => replies.shift(),
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.prompt, "write a plan / note: shorter please");
    assert.equal(result.result, "draft for: write a plan / note: shorter please");
  });

  it("a stop at a breakpoint ends the run", async () => {
    const { runner } = recordingRunner(() => "x");
    const script = `export const meta = { name: 'bp', description: 'bp' }
await breakpoint('Check', { show: 'all good?' })
return 'went on'`;
    await assert.rejects(
      () => runWorkflow(script, { agent: runner, persistLogs: false, confirm: async () => "stop" }),
      /Stopped at breakpoint "Check"/,
    );
  });
});

describe("agent options", () => {
  it("pass timeout, effort, skills and MCP names to the runner, with the step's lists replacing the definition's", async () => {
    const def: AgentDefinition = {
      name: "reviewer",
      model: "haiku",
      skills: ["review", "tdd"],
      mcp: ["linear"],
      effort: "high",
      timeout: "10m",
      prompt: "You review code.",
      source: "user",
    };
    const registry: AgentRegistry = new Map([["reviewer", def]]);
    const { runner, calls } = recordingRunner(() => "ok");
    const script = `export const meta = { name: 'opts', description: 'opts' }
await agent('review A', { label: 'a', agentType: 'reviewer' })
await agent('review B', { label: 'b', agentType: 'reviewer', skills: ['security'], mcp: [], effort: 'low', timeout: 30 })
return 1`;
    await runWorkflow(script, { agent: runner, persistLogs: false, agentRegistry: registry });
    const [a, b] = calls;
    assert.equal(a!.options.timeoutMs, 600_000);
    assert.equal(a!.options.effort, "high");
    assert.deepEqual(a!.options.skills, ["review", "tdd"]);
    assert.deepEqual(a!.options.mcpNames, ["linear"]);
    assert.equal(a!.options.agentType, "reviewer");
    assert.equal(b!.options.timeoutMs, 30_000);
    assert.equal(b!.options.effort, "low");
    assert.deepEqual(b!.options.skills, ["security"]);
    assert.deepEqual(b!.options.mcpNames, []);
    // The host tells the step's own values from the definition's.
    assert.deepEqual(a!.options.stepGiven, {});
    assert.deepEqual(b!.options.stepGiven, { effort: "low", skills: ["security"], mcp: [] });
  });

  it("pass the name of an agent no definition has, so the host can stop the step", async () => {
    const { runner, calls } = recordingRunner(() => "ok");
    const script = `export const meta = { name: 'ghost', description: 'ghost' }
await agent('go', { label: 'g', agentType: 'nobody', model: 'codex' })
return 1`;
    await runWorkflow(script, { agent: runner, persistLogs: false, agentRegistry: new Map() });
    assert.equal(calls[0]!.options.agentType, "nobody");
    assert.deepEqual(calls[0]!.options.stepGiven, { model: "codex" });
  });

  it("take the host's agents from loadAgents, for the run's folder", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "load-agents-"));
    const asked: string[] = [];
    const def: AgentDefinition = { name: "reviewer", model: "claude/haiku", prompt: "Answer FROM-HOST.", source: "user" };
    // No session ref: a stored run checks a ref's fields, and this test is about the agents.
    const calls: Call[] = [];
    const runner: AgentRunner = {
      async run(prompt, options) {
        calls.push({ prompt, options: { ...(options ?? {}) } as Record<string, unknown> });
        return "ok" as never;
      },
    };
    try {
      const manager = new WorkflowManager({
        cwd,
        persistenceRoot: join(cwd, "store"),
        agent: runner,
        loadAgents: (folder) => {
          asked.push(folder);
          return new Map([["reviewer", def]]);
        },
      });
      const run = await manager.runSync(`export const meta = { name: "host-agents", description: "host agents" };
return await agent("review", { agentType: "reviewer" });`);
      assert.equal(run.status, "completed");
      assert.equal(calls[0]!.options.model, "claude/haiku");
      assert.match(String(calls[0]!.options.instructions), /Answer FROM-HOST\./);
      assert.ok(asked.length > 0 && asked.every((folder) => folder === cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("continue reopens the session of the step with that label", async () => {
    const { runner, calls } = recordingRunner(() => "ok");
    const script = `export const meta = { name: 'cont', description: 'cont' }
await agent('implement', { label: 'implementer', keepSession: true })
await agent('fix the review', { label: 'implementer fix', continue: 'implementer' })
return 1`;
    await runWorkflow(script, { agent: runner, persistLogs: false });
    assert.equal(calls[0]!.options.continueFromSession, undefined);
    const ref = calls[1]!.options.continueFromSession as { sessionId: string };
    assert.equal(ref.sessionId, "session-1");
    // The runner sends the step's own prompt, not the resume instruction for an interrupted turn.
    assert.equal(calls[0]!.options.continueWithPrompt, undefined);
    assert.equal(calls[1]!.options.continueWithPrompt, true);
  });

  it("step overrides change one step for one run", async () => {
    const { runner, calls } = recordingRunner(() => "ok");
    const script = `export const meta = { name: 'ovr', description: 'ovr' }
await agent('review', { label: 'reviewer', model: 'sonnet' })
await agent('other', { label: 'other', model: 'sonnet' })
return 1`;
    await runWorkflow(script, { agent: runner, persistLogs: false, stepOverrides: { reviewer: { model: "haiku" } } });
    assert.equal(calls[0]!.options.model, "haiku");
    assert.equal(calls[1]!.options.model, "sonnet");
  });

  it("ask: true lets the agent stop with a question and continue in the same session", async () => {
    const { runner, calls } = recordingRunner((_prompt, _options, all) =>
      all.length === 1 ? "QUESTION: Postgres or SQLite?" : "done with SQLite",
    );
    const script = `export const meta = { name: 'askagent', description: 'askagent' }
return await agent('build the store', { label: 'builder', ask: true })`;
    const result = await runWorkflow<string>(script, {
      agent: runner,
      persistLogs: false,
      confirm: async () => "SQLite",
    });
    assert.equal(result.result, "done with SQLite");
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.prompt, /The user answered: SQLite/);
    assert.equal(calls[1]!.options.continueWithPrompt, true);
    assert.equal((calls[1]!.options.continueFromSession as { sessionId: string }).sessionId, "session-1");
  });
});

describe("choose", () => {
  it("runs the step the agent picks, among the listed ones", async () => {
    const { runner, calls } = recordingRunner((_prompt, options) =>
      options.label === "choose" ? { choice: "fix", reason: "it is a bug" } : "fixed",
    );
    const script = `export const meta = { name: 'choose', description: 'choose' }
return await choose('What next?', { steps: {
  fix: { description: 'Fix the bug', run: () => agent('fix it', { label: 'fixer' }) },
  skip: () => 'skipped',
} })`;
    const result = await runWorkflow<{ choice: string; result: string }>(script, { agent: runner, persistLogs: false });
    assert.equal(result.result.choice, "fix");
    assert.equal(result.result.result, "fixed");
    const schema = calls[0]!.options.schema as { properties: { choice: { enum: string[] } } };
    assert.deepEqual(schema.properties.choice.enum, ["fix", "skip"]);
  });

  it("can run any saved workflow when the author allows it", async () => {
    const { runner } = recordingRunner((_prompt, options) =>
      options.label === "choose" ? { choice: "triage", reason: "needs triage" } : "triaged",
    );
    const triage = `export const meta = { name: 'triage', description: 't' }
return await agent('triage ' + args.id, { label: 't' })`;
    const script = `export const meta = { name: 'choose', description: 'choose' }
return await choose('What next?', { any: true, input: { id: 7 } })`;
    const result = await runWorkflow<{ choice: string; result: string }>(script, {
      agent: runner,
      persistLogs: false,
      loadSavedWorkflow: (name) => (name === "triage" ? triage : undefined),
      listSavedWorkflows: () => [{ name: "triage", description: "Sort a ticket" }],
    });
    assert.equal(result.result.choice, "triage");
    assert.equal(result.result.result, "triaged");
  });
});

describe("nested places", () => {
  it("a nested workflow can ask for its own place", async () => {
    const { runner, calls } = recordingRunner(() => "ok");
    const child = `export const meta = { name: 'child', description: 'c' }
await agent('work', { label: 'w' })
return cwd`;
    const script = `export const meta = { name: 'parent', description: 'p' }
return await workflow('child', {}, { place: 'worktree' })`;
    const repo = mkdtempSync(join(tmpdir(), "orc-nested-place-"));
    const home = homePaths(mkdtempSync(join(tmpdir(), "orc-nested-place-home-")));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
      const result = await runWorkflow<string>(script, {
        agent: runner,
        persistLogs: false,
        cwd: repo,
        runId: "parent-run",
        home,
        loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
      });
      // The places module makes the worktree, named after the child run.
      const dir = join(home.worktrees, "parent-run-nested1");
      assert.equal(result.result, dir);
      assert.equal(calls[0]!.options.cwd, dir);
      assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim(), "orc/parent-run-nested1");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
    }
  });

  it("a nested workflow with a place that is none of the three fails", async () => {
    const { runner } = recordingRunner(() => "ok");
    const child = `export const meta = { name: 'child', description: 'c' }
return 1`;
    const script = `export const meta = { name: 'parent', description: 'p' }
return await workflow('child', {}, { place: 'cloud' })`;
    await assert.rejects(
      runWorkflow(script, { agent: runner, persistLogs: false, loadSavedWorkflow: (name) => (name === "child" ? child : undefined) }),
      /place must be worktree, folder or none, got "cloud"/,
    );
  });
});

describe("nested args", () => {
  it("a nested workflow's args get the inputs check and defaults without orc, and a wrong input fails the call", async () => {
    const { runner } = recordingRunner(() => "ok");
    const child = `export const meta = { name: 'child', description: 'c', inputs: {
  task: { type: 'string', required: true }, rounds: { type: 'number', default: 3 }, test: { type: 'string', default: 'npm test' } } }
return args`;
    const script = `export const meta = { name: 'parent', description: 'p' }
const given = await workflow('child', { task: 'fix it', rounds: '2' })
const problem = async (args) => { try { await workflow('child', args) } catch (error) { return error.message } }
const missing = await problem({ rounds: 1 })
const wrong = await problem({ task: 'x', rounds: 'many' })
const unknown = await problem({ task: 'x', colour: 'red' })
const plain = await workflow('child', 'as is')
return { given, missing, wrong, unknown, plain }`;
    const result = await runWorkflow<Record<string, unknown>>(script, {
      agent: runner,
      persistLogs: false,
      loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
      given: { task: "fix it", rounds: 2, test: "npm test" },
      missing: 'workflow("child"): missing input --task',
      wrong: 'workflow("child"): --rounds must be a number, got "many"',
      unknown: 'workflow("child"): unknown input --colour. This workflow takes: --task, --rounds, --test',
      plain: "as is",
    });
  });
});

describe("parseDurationSeconds", () => {
  it("reads numbers and units", () => {
    assert.equal(parseDurationSeconds(90), 90);
    assert.equal(parseDurationSeconds("90s"), 90);
    assert.equal(parseDurationSeconds("10m"), 600);
    assert.equal(parseDurationSeconds("2h"), 7200);
    assert.equal(parseDurationSeconds("500ms"), 0.5);
    assert.equal(parseDurationSeconds("soon"), undefined);
    assert.equal(parseDurationSeconds(-1), undefined);
  });
});

describe("nested resume", () => {
  it("a continued run replays finished nested runs, two levels deep, instead of running them again", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { WorkflowManager } = await import("../src/workflow-manager.js");
    let finalFails = true;
    const prompts: string[] = [];
    const runner: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(prompt: string): Promise<AgentResult<S>> {
        prompts.push(prompt);
        if (prompt === "final" && finalFails) {
          finalFails = false;
          throw new Error("final failed once");
        }
        return `done:${prompt}` as AgentResult<S>;
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "nested-resume-cwd-"));
    const persistenceRoot = mkdtempSync(join(tmpdir(), "nested-resume-store-"));
    try {
      const manager = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
      const grand = `export const meta = { name: 'grand', description: 'g' }\nreturn await agent('grand ' + args)`;
      const child = `export const meta = { name: 'child', description: 'c' }
const own = await agent('child ' + args)
const below = await parallel([() => workflow(${JSON.stringify(grand)}, args + '1'), () => workflow(${JSON.stringify(grand)}, args + '2')])
return [own, below]`;
      const script = `export const meta = { name: 'parent', description: 'p' }
const first = await agent('first')
const kids = await parallel([() => workflow(${JSON.stringify(child)}, 'a'), () => workflow(${JSON.stringify(child)}, 'b')])
const last = await agent('final')
if (last === null) throw new Error('final is required')
return { first, kids, last }`;
      const failed = await manager.runSync(script, undefined, { runId: "nested-resume" });
      assert.equal(failed.status, "failed");
      assert.equal(prompts.length, 8, "first, two children, four grandchildren, final");
      const persisted = manager.getPersistence().load("nested-resume");
      assert.equal(persisted?.nestedJournal?.length, 6);

      const started = await manager.resumeInBackground("nested-resume");
      if (!started.accepted) assert.fail("resume refused");
      const completed = await started.promise;
      assert.equal(completed.status, "completed");
      assert.deepEqual(prompts.slice(8), ["final"], "only the failed call runs again");
      assert.deepEqual(structuredClone(completed.result), {
        first: "done:first",
        kids: [
          ["done:child a", ["done:grand a1", "done:grand a2"]],
          ["done:child b", ["done:grand b1", "done:grand b2"]],
        ],
        last: "done:final",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(persistenceRoot, { recursive: true, force: true });
    }
  });
});

describe("failed steps", () => {
  it("pause the run with pauseOnFailedStep, even when the script catches, and resume runs the step again", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { WorkflowManager } = await import("../src/workflow-manager.js");
    let fixed = false;
    const prompts: string[] = [];
    const runner: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(prompt: string): Promise<AgentResult<S>> {
        prompts.push(prompt);
        if (prompt === "flaky" && !fixed) throw new Error("the build is broken");
        return `done:${prompt}` as AgentResult<S>;
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "failed-step-cwd-"));
    const persistenceRoot = mkdtempSync(join(tmpdir(), "failed-step-store-"));
    try {
      const manager = new WorkflowManager({ cwd, persistenceRoot, agent: runner, orchestrator: { pauseOnFailedStep: true } });
      const script = `export const meta = { name: 'steps', description: 's' }
const first = await agent('first', { label: 'first' })
let flaky
try { flaky = await agent('flaky', { label: 'flaky', retries: 1 }) } catch (e) { flaky = 'caught' }
const other = await agent('other', { label: 'other' })
return { first, flaky, other }`;
      const paused = await manager.runSync(script, undefined, { runId: "failed-step" });
      assert.equal(paused.status, "paused");
      assert.deepEqual(prompts, ["first", "flaky", "flaky"], "one retry, then nothing new starts");
      const persisted = manager.getPersistence().load("failed-step");
      assert.equal(persisted?.pauseReason, "step_failed");
      assert.match(persisted?.reason ?? "", /step "flaky" failed after 2 tries: .*the build is broken/);

      fixed = true;
      const started = await manager.resumeInBackground("failed-step");
      if (!started.accepted) assert.fail("resume refused");
      const completed = await started.promise;
      assert.equal(completed.status, "completed");
      assert.deepEqual(prompts.slice(3), ["flaky", "other"], "the finished step replays");
      assert.deepEqual(structuredClone(completed.result), { first: "done:first", flaky: "done:flaky", other: "done:other" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(persistenceRoot, { recursive: true, force: true });
    }
  });

  it("log one period between a failure that ends in a period and the pause advice", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { WorkflowManager } = await import("../src/workflow-manager.js");
    const runner: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(): Promise<AgentResult<S>> {
        throw new Error("Claude Code 1.0.0 is older than 2.1.330. Update it.");
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "failed-step-cwd-"));
    const persistenceRoot = mkdtempSync(join(tmpdir(), "failed-step-store-"));
    try {
      const manager = new WorkflowManager({ cwd, persistenceRoot, agent: runner, orchestrator: { pauseOnFailedStep: true } });
      const script = `export const meta = { name: 'steps', description: 's' }
return await agent('old', { label: 'old', retries: 0 })`;
      const paused = await manager.runSync(script, undefined, { runId: "failed-period" });
      assert.equal(paused.status, "paused");
      const line = paused.logs.find((entry) => entry.includes("The run pauses"));
      assert.equal(line, 'step "old" failed after 1 try: Claude Code 1.0.0 is older than 2.1.330. Update it. The run pauses: fix the cause and resume it.');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(persistenceRoot, { recursive: true, force: true });
    }
  });
});

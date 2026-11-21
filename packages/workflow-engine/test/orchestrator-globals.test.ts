import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, AgentRunner, JournalEntry, RunOptions } from "@automatalabs/shared-types";
import { parseAgentDefinition, type AgentRegistry } from "../src/agent-registry.js";
import { parseDurationSeconds } from "../src/orchestrator-globals.js";
import { runWorkflow } from "../src/workflow.js";

// orchestrator: code steps, questions, breakpoints, choose(), and the per-step options.

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

const execAnswer = (prompt: string) => {
  const spec = JSON.parse(prompt) as { kind: string; command?: string; source?: string; input?: unknown };
  return { code: 0, stdout: `ran ${spec.kind}`, stderr: "", result: spec.input ?? null };
};

describe("code steps", () => {
  it("send sh, js, py, run and waitUntil to the runner as exec calls with a JSON spec", async () => {
    const { runner, calls } = recordingRunner((prompt, options) =>
      options.model === "exec" ? execAnswer(prompt) : "agent",
    );
    const script = `export const meta = { name: 'code', description: 'code steps' }
const a = await sh('echo hi', { allowFail: true, timeout: '2m' })
const b = await js('return input.n + 1', { n: 1 })
const c = await py('return input', [1, 2])
const d = await run('scripts/check.sh', { args: ['x'], input: { y: 1 } })
const e = await waitUntil('test -f done', { every: '30s', timeout: '1h' })
return { a, b, c, d, e }`;
    const result = await runWorkflow<Record<string, { stdout: string; result: unknown }>>(script, {
      agent: runner,
      persistLogs: false,
    });
    assert.equal(calls.length, 5);
    assert.ok(calls.every((call) => call.options.model === "exec"));
    assert.ok(calls.every((call) => call.options.schema !== undefined), "code steps return a structured result");
    const specs = calls.map((call) => JSON.parse(call.prompt));
    assert.deepEqual(specs[0], { kind: "sh", command: "echo hi", allowFail: true });
    assert.equal(calls[0]!.options.timeoutMs, 120_000);
    assert.deepEqual(specs[1], { kind: "js", source: "return input.n + 1", input: { n: 1 } });
    assert.deepEqual(specs[2], { kind: "py", source: "return input", input: [1, 2] });
    assert.deepEqual(specs[3], { kind: "file", file: "scripts/check.sh", args: ["x"], input: { y: 1 } });
    assert.deepEqual(specs[4], { kind: "wait", command: "test -f done", everySeconds: 30, timeoutSeconds: 3600 });
    assert.equal(result.result.b!.stdout, "ran js");
    assert.deepEqual(JSON.parse(JSON.stringify(result.result.b!.result)), { n: 1 });
  });

  it("are journaled, so a resumed run does not run them twice", async () => {
    const first = recordingRunner((prompt) => execAnswer(prompt));
    const script = `export const meta = { name: 'once', description: 'once' }
const a = await sh('date > stamp')
return a.stdout`;
    const journal: JournalEntry[] = [];
    await runWorkflow<string>(script, { agent: first.runner, persistLogs: false, onAgentJournal: (e) => journal.push(e) });
    assert.equal(first.calls.length, 1);
    const second = recordingRunner((prompt) => execAnswer(prompt));
    const run2 = await runWorkflow<string>(script, {
      agent: second.runner,
      persistLogs: false,
      resumeJournal: new Map(journal.map((e) => [e.index, e])),
    });
    assert.equal(second.calls.length, 0, "the replay reuses the recorded result");
    assert.equal(run2.result, "ran sh");
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
    const def = parseAgentDefinition(
      `---\nname: reviewer\nmodel: haiku\nskills: [review, tdd]\nmcp: [linear]\neffort: high\ntimeout: 10m\n---\nYou review code.`,
      "user",
      "reviewer.md",
    )!;
    assert.deepEqual(def.skills, ["review", "tdd"]);
    assert.deepEqual(def.mcp, ["linear"]);
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
    const requests: unknown[] = [];
    const result = await runWorkflow<string>(script, {
      agent: runner,
      persistLogs: false,
      cwd: "/repo",
      loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
      prepareNestedPlace: (request) => {
        requests.push(request);
        return { cwd: "/worktrees/child-1" };
      },
    });
    assert.equal(result.result, "/worktrees/child-1");
    assert.equal(calls[0]!.options.cwd, "/worktrees/child-1");
    assert.equal((requests[0] as { place: string }).place, "worktree");
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
});

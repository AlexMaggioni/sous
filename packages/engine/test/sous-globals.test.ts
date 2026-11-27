import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, StepRequest } from "../src/steps/agent-run.js";
import type { AgentRunner, StepAsk, StepRoute } from "../src/steps/agent-runner.js";
import type { JournalEntry, WorkflowCallRecord } from "../src/workflow-result.js";
import { isStepFailedPause, runWorkflow } from "../src/workflow.js";
import { createSteps } from "../src/steps/steps.js";
import { homePaths } from "../src/runs/home.js";
import { placesIn } from "./helpers/places.js";
import { lookupAgents, lookupMcpServers } from "../src/agents.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createSousGlobals } from "../src/sous-globals.js";
import { journalResume } from "./helpers/journal-resume.js";

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
    async run<S extends TSchema | undefined = undefined>(prompt: string, options?: StepRequest<S>): Promise<AgentResult<S>> {
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
  writeFileSync(join(cwd, "scripts", "check.sh"), 'echo "args $1"; cat > "$SOUS_RESULT"\n');
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
    assert.ok(result.tokenUsage, "the run reports its token usage");
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
    const slowRows: WorkflowCallRecord[] = [];
    await assert.rejects(
      runWorkflow(`export const meta = { name: 'slow', description: 'slow' }
return await sh('sleep 5', { timeout: 0.2 })`, { agent: runner, cwd, persistLogs: false, onCallRecord: (row) => slowRows.push(row) }),
      (error: unknown) => isStepFailedPause(error as { code?: unknown; details?: unknown }),
      "a step that runs out of time pauses the run",
    );
    assert.match(String(slowRows[0]?.error?.message), /^timed out after 0s$/);
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
      ...journalResume(journal),
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

// Piece 8, questions. The author of a question says who may answer it: ask(q, { answeredBy }) takes
// "people", the default, or "anyone". An "anyone" question goes through markedCheckpoint with
// { answeredBy: "anyone" }, and a breakpoint with { breakpoint: true }. A breakpoint is always for
// people. The fake deps below give
// markedCheckpoint, the dep the design names, and no breakpointCheckpoint.
describe("piece 8: who may answer a question", () => {
  interface Asked {
    via: "checkpoint" | "markedCheckpoint";
    prompt: string;
    options: unknown;
    purpose?: unknown;
  }
  function globals(reply: unknown = "blue", agentReplies: unknown[] = []) {
    const asked: Asked[] = [];
    const agentCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const deps = {
      agent: async (prompt: string, options: Record<string, unknown> = {}) => {
        agentCalls.push({ prompt, options });
        return agentReplies.shift() ?? "done";
      },
      code: async () => undefined,
      checkpoint: async (prompt: string, options?: unknown) => {
        asked.push({ via: "checkpoint", prompt, options });
        return reply;
      },
      markedCheckpoint: async (prompt: string, options?: unknown, purpose?: unknown) => {
        asked.push({ via: "markedCheckpoint", prompt, options, purpose });
        return reply;
      },
      workflow: async () => undefined,
      log: () => {},
    };
    const made = createSousGlobals(deps as unknown as Parameters<typeof createSousGlobals>[0]) as unknown as Record<"ask" | "breakpoint" | "agent", (...args: unknown[]) => Promise<unknown>>;
    return { ask: made.ask, breakpoint: made.breakpoint, agent: made.agent, asked, agentCalls };
  }
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as unknown;

  it("ask(q, { choices, answeredBy: 'anyone' }) asks through markedCheckpoint with { answeredBy: 'anyone' }", async () => {
    const { ask, asked } = globals();
    assert.equal(await ask("Which color?", { choices: ["red", "blue"], answeredBy: "anyone" }), "blue");
    assert.equal(asked.length, 1, JSON.stringify(asked));
    assert.equal(asked[0]!.via, "markedCheckpoint", JSON.stringify(asked));
    assert.equal(asked[0]!.prompt, "Which color?");
    assert.deepEqual(plain(asked[0]!.options), { kind: "select", choices: ["red", "blue"] });
    assert.deepEqual(plain(asked[0]!.purpose), { answeredBy: "anyone" });

    // "people" is the default, and neither asks as anyone.
    for (const options of [{ choices: ["red", "blue"] }, { choices: ["red", "blue"], answeredBy: "people" }]) {
      const people = globals();
      assert.equal(await people.ask("Which color?", options), "blue");
      assert.equal(people.asked.length, 1);
      assert.notEqual((people.asked[0]!.purpose as { answeredBy?: string } | undefined)?.answeredBy, "anyone", JSON.stringify(people.asked));
    }
  });

  it("ask(q, { answeredBy: 'robots' }) fails the script and asks nothing", async () => {
    const { ask, asked } = globals();
    await assert.rejects(() => ask("Which color?", { choices: ["red", "blue"], answeredBy: "robots" }), /answeredBy/);
    await assert.rejects(() => ask("Which color?", { answeredBy: true }), /answeredBy/);
    assert.equal(asked.length, 0);
  });

  it("breakpoint(..., { answeredBy: 'anyone' }) fails, with options or with a step, and asks nothing", async () => {
    const { breakpoint, asked } = globals("approve");
    await assert.rejects(() => breakpoint("Check the plan", { show: "all good?", answeredBy: "anyone" }), /answeredBy/);
    let ran = 0;
    await assert.rejects(() => breakpoint("Check the plan", () => ran++, { answeredBy: "anyone" }), /answeredBy/);
    assert.equal(ran, 0, "the step does not run");
    assert.equal(asked.length, 0);
  });

  it("breakpoint() asks through markedCheckpoint with { breakpoint: true }, its title and the text it shows", async () => {
    const { breakpoint, asked } = globals("approve");
    await breakpoint("Check the plan", { show: "all good?" });
    assert.equal(asked.length, 1, JSON.stringify(asked));
    assert.equal(asked[0]!.via, "markedCheckpoint");
    assert.deepEqual(plain(asked[0]!.purpose), { breakpoint: true, title: "Check the plan", show: "all good?" });
  });

  it("in a run, the host's confirm gets the purpose of each: ask anyone and breakpoint", async () => {
    const { runner } = recordingRunner(() => "built it");
    const purposes: unknown[] = [];
    const script = `export const meta = { name: 'p8', description: 'p8' }
const color = await ask('Which color?', { choices: ['red', 'blue'], answeredBy: 'anyone' })
await breakpoint('Check', { show: color })
return await agent('Build it', { label: 'builder' })`;
    await runWorkflow(script, {
      agent: runner,
      persistLogs: false,
      confirm: async (_prompt, _options, context) => {
        purposes.push(plain(context?.purpose));
        return purposes.length === 1 ? "blue" : "approve";
      },
    });
    assert.deepEqual(purposes, [{ answeredBy: "anyone" }, { breakpoint: true, title: "Check", show: "blue" }]);
  });
});

describe("agent options", () => {
  // The agent comes from an agent file, and createSteps routes the step.
  it("route timeout, effort, skills and MCP names through the steps module, with the step's lists replacing the agent's", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-options-"));
    mkdirSync(join(cwd, ".rulesync", "subagents"), { recursive: true });
    writeFileSync(
      join(cwd, ".rulesync", "subagents", "reviewer.md"),
      "---\nname: reviewer\ndescription: reviews\ntimeout: 10m\neffort: high\nskills: [review, tdd]\nmcp: [linear]\nclaudecode:\n  model: haiku\n---\nYou review code.\n",
    );
    writeFileSync(join(cwd, ".rulesync", "mcp.jsonc"), `{ "mcpServers": { "linear": { "command": "npx", "args": [] } } }`);
    const settings = {
      projectDir: cwd,
      rulesyncGlobal: join(cwd, "aiglobal"),
      defaultHarness: "claude" as const,
      env: { CLAUDE_CONFIG_DIR: join(cwd, "claude"), CODEX_HOME: join(cwd, "codex"), XDG_CONFIG_HOME: join(cwd, "config") },
    };
    const calls: Call[] = [];
    const steps = createSteps({
      cwd,
      inner: {
        async run(prompt, options) {
          calls.push({ prompt, options: { ...options } as Record<string, unknown> });
          return "ok";
        },
      },
      agents: lookupAgents(settings),
      mcp: lookupMcpServers(settings, {}),
    });
    // The engine asks the steps module for each step's route. Keep each ask and route.
    const asks: StepAsk[] = [];
    const routes: StepRoute[] = [];
    const agent: AgentRunner = {
      ...steps,
      route(ask) {
        const route = steps.route(ask);
        asks.push(ask);
        routes.push(route);
        return route;
      },
    };
    const script = `export const meta = { name: 'opts', description: 'opts' }
await agent('review A', { label: 'a', agentType: 'reviewer' })
await agent('review B', { label: 'b', agentType: 'reviewer', skills: ['security'], mcp: [], effort: 'low', timeout: 30 })
return 1`;
    try {
      await runWorkflow(script, { agent, cwd, persistLogs: false });
      const [a, b] = routes;
      assert.equal(a!.plan?.timeoutMs, 600_000);
      assert.equal(a!.plan?.effort, "high");
      assert.deepEqual(a!.plan?.skills, ["review", "tdd"]);
      assert.deepEqual(a!.plan?.mcp, ["linear"]);
      assert.equal(asks[0]!.agentType, "reviewer");
      assert.equal(b!.plan?.timeoutMs, 30_000);
      assert.equal(b!.plan?.effort, "low");
      assert.deepEqual(b!.plan?.skills, ["security"]);
      assert.deepEqual(b!.plan?.mcp, []);
      // The ask holds the step's own values apart from the agent's. The script's lists come from its own context, so compare copies.
      assert.deepEqual([asks[0]!.effort, asks[0]!.skills, asks[0]!.mcp, asks[0]!.timeout], [undefined, undefined, undefined, undefined]);
      assert.deepEqual(structuredClone([asks[1]!.effort, asks[1]!.skills, asks[1]!.mcp, asks[1]!.timeout]), ["low", ["security"], [], 30]);
      // The runner gets the planned values, and the MCP server each name stands for.
      assert.deepEqual([calls[0]!.options.effort, calls[0]!.options.skills], ["high", ["review", "tdd"]]);
      assert.deepEqual((calls[0]!.options.mcpServers as Array<{ name: string }>).map((server) => server.name), ["linear"]);
      assert.deepEqual([calls[1]!.options.effort, calls[1]!.options.skills, calls[1]!.options.mcpServers], ["low", ["security"], undefined]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stop the step of an agent no file has, with its name, through the steps module", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-missing-"));
    const env = { CLAUDE_CONFIG_DIR: join(cwd, "claude"), CODEX_HOME: join(cwd, "codex"), XDG_CONFIG_HOME: join(cwd, "config") };
    const calls: Call[] = [];
    const steps = createSteps({
      cwd,
      inner: {
        async run(prompt, options) {
          calls.push({ prompt, options: { ...options } as Record<string, unknown> });
          return "ok";
        },
      },
      agents: lookupAgents({ projectDir: cwd, rulesyncGlobal: join(cwd, "aiglobal"), defaultHarness: "claude", env }),
    });
    const asks: StepAsk[] = [];
    const agent: AgentRunner = {
      ...steps,
      route(ask) {
        asks.push(ask);
        return steps.route(ask);
      },
    };
    const script = `export const meta = { name: 'ghost', description: 'ghost' }
await agent('go', { label: 'g', agentType: 'nobody', model: 'codex' })
return 1`;
    try {
      await assert.rejects(runWorkflow(script, { agent, cwd, persistLogs: false }), /step "g": no agent "nobody"\./);
      assert.deepEqual([asks[0]!.agentType, asks[0]!.model], ["nobody", "codex"]);
      assert.equal(calls.length, 0, "the step never reaches the runner");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("take the host's agents from the steps module's lookup of the run's folder", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "load-agents-"));
    mkdirSync(join(cwd, ".rulesync", "subagents"), { recursive: true });
    writeFileSync(join(cwd, ".rulesync", "subagents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\nclaudecode:\n  model: haiku\n---\nAnswer FROM-HOST.\n");
    const env = { CLAUDE_CONFIG_DIR: join(cwd, "claude"), CODEX_HOME: join(cwd, "codex"), XDG_CONFIG_HOME: join(cwd, "config") };
    // No session ref: a stored run checks a ref's fields, and this test is about the agents.
    const calls: Call[] = [];
    const agent = createSteps({
      cwd,
      inner: {
        async run(prompt, options) {
          calls.push({ prompt, options: { ...options } as Record<string, unknown> });
          return "ok";
        },
      },
      agents: lookupAgents({ projectDir: cwd, rulesyncGlobal: join(cwd, "aiglobal"), defaultHarness: "claude", env }),
    });
    try {
      const manager = new WorkflowManager({ cwd, persistenceRoot: join(cwd, "store"), agent });
      const run = await manager.runSync(`export const meta = { name: "host-agents", description: "host agents" };
return await agent("review", { agentType: "reviewer" });`);
      assert.equal(run.status, "completed");
      assert.equal(calls[0]!.options.model, "claude/haiku");
      assert.match(String(calls[0]!.options.instructions), /Answer FROM-HOST\./);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a second send() on a session reopens the session its first turn opened", async () => {
    const { runner, calls } = recordingRunner(() => "ok");
    const script = `export const meta = { name: 'cont', description: 'cont' }
const implementer = session({ label: 'implementer' })
await implementer.send('implement')
await implementer.send('fix the review', { label: 'implementer fix' })
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
      savedWorkflows: {
        load: (name) => (name === "triage" ? triage : undefined),
        list: () => [{ name: "triage", description: "Sort a ticket" }],
      },
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
    const repo = mkdtempSync(join(tmpdir(), "sous-nested-place-"));
    const home = homePaths(mkdtempSync(join(tmpdir(), "sous-nested-place-home-")));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
      const result = await runWorkflow<string>(script, {
        agent: runner,
        persistLogs: false,
        cwd: repo,
        runId: "parent-run",
        places: placesIn(home, "parent-run"),
        savedWorkflows: { load: (name) => (name === "child" ? child : undefined) },
      });
      // The places module makes the worktree, named after the child run.
      const dir = join(home.worktrees, "parent-run-nested1");
      assert.equal(result.result, dir);
      assert.equal(calls[0]!.options.cwd, dir);
      assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim(), "sous/parent-run-nested1");
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
      runWorkflow(script, { agent: runner, persistLogs: false, savedWorkflows: { load: (name) => (name === "child" ? child : undefined) } }),
      /place must be worktree, folder or none, got "cloud"/,
    );
  });

  it("with no places, a nested place of its own fails and says why, and place folder works in the parent's folder", async () => {
    const { runner } = recordingRunner(() => "ok");
    const child = `export const meta = { name: 'child', description: 'c' }
return cwd`;
    const dir = mkdtempSync(join(tmpdir(), "sous-nested-noplaces-"));
    const run = (place: string) =>
      runWorkflow<string>(`export const meta = { name: 'parent', description: 'p' }
return await workflow('child', {}, { place: '${place}' })`, {
        agent: runner,
        persistLogs: false,
        cwd: dir,
        savedWorkflows: { load: (name) => (name === "child" ? child : undefined) },
      });
    try {
      for (const place of ["worktree", "none"]) {
        await assert.rejects(run(place), new RegExp(`place "${place}" needs a home for its folder, and this run has none. Use place "folder".`));
      }
      assert.equal((await run("folder")).result, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nested args", () => {
  it("a nested workflow's args get the inputs check and defaults without sous, and a wrong input fails the call", async () => {
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
      savedWorkflows: { load: (name) => (name === "child" ? child : undefined) },
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
return { first, kids, last }`;
      const paused = await manager.runSync(script, undefined, { runId: "nested-resume" });
      assert.equal(paused.status, "paused", "the failed step pauses the run");
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

  it("a paused run saves a call row for each nested call, with its inputs hash", async () => {
    let fixed = false;
    const prompts: string[] = [];
    const runner: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(prompt: string): Promise<AgentResult<S>> {
        prompts.push(prompt);
        if (prompt === "y" && !fixed) throw new Error("y is broken");
        return `done:${prompt}` as AgentResult<S>;
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "nested-calls-cwd-"));
    const persistenceRoot = mkdtempSync(join(tmpdir(), "nested-calls-store-"));
    try {
      const manager = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
      const child = `export const meta = { name: 'child', description: 'c' }
return [await agent('x'), await agent('y')]`;
      const script = `export const meta = { name: 'parent', description: 'p' }
const first = await agent('a')
const kids = await workflow(${JSON.stringify(child)})
return [first, kids, await agent('c')]`;
      const paused = await manager.runSync(script, undefined, { runId: "nested-calls" });
      assert.equal(paused.status, "paused");
      const rows = (runId: string) =>
        (manager.getPersistence().load(runId)?.calls ?? [])
          .filter((row) => row.scope === `${runId}-nested1`)
          .map((row) => ({ index: row.index, kind: row.kind, outcome: row.outcome, inputsHash: typeof row.inputsHash }));
      assert.deepEqual(rows("nested-calls"), [
        { index: 0, kind: "agent", outcome: "result", inputsHash: "string" },
        { index: 1, kind: "agent", outcome: "error", inputsHash: "string" },
      ]);

      fixed = true;
      const started = await manager.resumeInBackground("nested-calls");
      if (!started.accepted) assert.fail("resume refused");
      const completed = await started.promise;
      assert.equal(completed.status, "completed");
      assert.deepEqual(prompts, ["a", "x", "y", "y", "c"]);
      assert.deepEqual(rows("nested-calls"), [
        { index: 0, kind: "agent", outcome: "result", inputsHash: "string" },
        { index: 1, kind: "agent", outcome: "result", inputsHash: "string" },
      ]);

      // Nested rows do not stop a reuse. A run that was never resumed is a source with call rows.
      // A reuse of it replays the root steps and the nested steps.
      const clean = await manager.runSync(script, undefined, { runId: "nested-calls-clean" });
      assert.equal(clean.status, "completed");
      assert.equal(rows("nested-calls-clean").length, 2);
      const reused = await manager.runSync(script, undefined, { runId: "nested-calls-reuse", resumeFromRunId: "nested-calls-clean" });
      assert.equal(reused.status, "completed");
      assert.deepEqual(prompts.slice(9), []);
      assert.deepEqual(JSON.parse(JSON.stringify(reused.result)), ["done:a", ["done:x", "done:y"], "done:c"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(persistenceRoot, { recursive: true, force: true });
    }
  });
});

describe("failed steps", () => {
  it("a failed step pauses the run, even when the script catches, and resume runs the step again", async () => {
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
      const manager = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
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
      const manager = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
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

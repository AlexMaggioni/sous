// The steps module. The first part runs the real adapters against the fake programs in
// test/fakes. The second part gives a runner of its own, as a test or the dry run does, and
// checks what the module plans before a step runs. Some tests moved here from orc's runner and
// programs tests.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { Account } from "@orchestrator/harnesses";
import type { AgentResultProvenance, AgentUsage, StepRequest } from "../src/steps/agent-run.js";
import type { StepAsk } from "../src/steps/agent-runner.js";
import type { AgentSessionRef } from "../src/workflow-result.js";
import { lookupAgents, lookupMcpServers } from "../src/agents.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createSteps, type StepsOptions } from "../src/steps/steps.js";
import { waitUntil } from "./helpers/async.js";

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
const temp = (name: string) => mkdtempSync(join(tmpdir(), `engine-${name}-`));
delete process.env.FAKE_VERSION;
// The fakes log which login variables a step got. Start from none, whatever the shell sets.
for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

/** One line of the fakes' request log. */
interface LogLine {
  program: string;
  model: string | null;
  effort: string | null;
  sessionId: string;
  resume: boolean;
  prompt: string;
  login: string[];
  appendSystemPrompt?: string | null;
  developerInstructions?: string | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[] | null;
  mcpServers: Array<{ name: string }>;
  images?: Array<{ mimeType: string | null; data: string | null }>;
}

/** A folder with the fakes' log and rules, a project and an account folder per program. */
function fakePlace(rules: object[] = []) {
  const dir = temp("steps");
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  const accounts: Record<"claude" | "codex", Account> = { claude: { folder: join(dir, "claude-home") }, codex: { folder: join(dir, "codex-home") } };
  for (const account of Object.values(accounts)) mkdirSync(account.folder!);
  const log = join(dir, "fake.log");
  const rulesFile = join(dir, "rules.json");
  writeFileSync(rulesFile, JSON.stringify(rules));
  // The adapters pass the caller's environment on, so the fakes read these.
  process.env.FAKE_LOG = log;
  process.env.FAKE_RULES = rulesFile;
  return {
    dir,
    cwd,
    accounts,
    gate: (name: string) => writeFileSync(join(dir, name), ""),
    lines: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine) : []),
  };
}

const onFakes = (place: ReturnType<typeof fakePlace>, extra: Partial<StepsOptions> = {}): StepsOptions => ({
  cwd: place.cwd,
  programs: (harness) => ({ path: join(FAKES, harness), env: {} }),
  accounts: place.accounts,
  ...extra,
});

/** The request the engine sends: it asks the steps module for the step's route first. */
function routed(steps: ReturnType<typeof createSteps>, ask: StepAsk, fields: Omit<StepRequest, "route"> = {}): StepRequest {
  const route = steps.route(ask);
  return { label: ask.label, ...fields, ...(route.requested === undefined ? {} : { model: route.requested }), route };
}

const RESETS_AT = 1_900_000_000;
const RESET_ISO = new Date(RESETS_AT * 1000).toISOString();

describe("steps on the fake programs", () => {
  it("runs a Claude Code step and a Codex step, each on its program, found once", async () => {
    const place = fakePlace();
    const found: string[] = [];
    const models: string[] = [];
    const sessions: AgentSessionRef[] = [];
    const usage: AgentUsage[] = [];
    const steps = createSteps(onFakes(place, { onProgram: ({ program, path, version }) => found.push(`${program} ${path} ${version}`) }));
    try {
      const common = { onModelResolved: (id: string) => models.push(id), onSessionOpen: (ref: AgentSessionRef) => sessions.push(ref), onUsage: (u: AgentUsage) => usage.push(u) };
      assert.equal(await steps.run("hello", routed(steps, { label: "a", model: "claude/haiku" }, { instructions: "Answer CLAUDE.", ...common })), "Fake claude answer.");
      assert.equal(await steps.run("again", routed(steps, { label: "b", model: "claude/haiku" }, common)), "Fake claude answer.");
      assert.equal(await steps.run("hi", routed(steps, { label: "c", model: "codex/gpt-6.1-sol", effort: "low" }, { instructions: "Answer CODEX.", ...common })), "Fake codex answer.");
    } finally {
      await steps.dispose();
    }
    assert.deepEqual(found, [`claude ${join(FAKES, "claude")} 2.1.330`, `codex ${join(FAKES, "codex")} 0.169.0`]);
    assert.deepEqual(models, ["claude/haiku", "claude/haiku", "codex/gpt-6.1-sol"]);
    assert.deepEqual(sessions.map((ref) => [ref.backendId, ref.cwd, ref.model]), [
      ["claude", place.cwd, "claude/haiku"],
      ["claude", place.cwd, "claude/haiku"],
      ["codex", place.cwd, "codex/gpt-6.1-sol"],
    ]);
    assert.equal(usage.length, 3);
    assert.ok(usage.every((u) => u.total > 0));
    const [claude, , codex] = place.lines();
    assert.deepEqual([claude?.program, claude?.model], ["claude", "haiku"]);
    assert.deepEqual([codex?.program, codex?.model, codex?.effort], ["codex", "gpt-6.1-sol", "low"]);
    // Instructions go to the system prompt on Claude Code and to developerInstructions on Codex.
    assert.match(claude?.appendSystemPrompt ?? "", /Answer CLAUDE\./);
    assert.doesNotMatch(claude?.prompt ?? "", /Answer CLAUDE\./);
    assert.match(codex?.developerInstructions ?? "", /Answer CODEX\./);
    // Each step runs as its account, and the caller's own environment stays as it was.
    assert.deepEqual(claude?.login, ["CLAUDE_CONFIG_DIR"]);
    assert.deepEqual(codex?.login, ["CODEX_HOME"]);
  });

  it("runs a step as a named login, by variable name only", async () => {
    const place = fakePlace();
    const steps = createSteps(onFakes(place, { accounts: { claude: { ...place.accounts.claude, token: "token-value", named: true } } }));
    try {
      await steps.run("hello", routed(steps, { label: "a", model: "claude/haiku" }));
    } finally {
      await steps.dispose();
    }
    assert.deepEqual(place.lines()[0]?.login, ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]);
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN === "token-value", false, "the worker's environment is left alone");
  });

  it("hands the agent's tool lists to Claude Code", async () => {
    const place = fakePlace();
    write(
      join(place.cwd, ".rulesync", "subagents", "tester.md"),
      '---\nname: tester\ndescription: tests\nclaudecode:\n  tools: ["Read", "Bash(npm test)", "mcp__linear__list_issues"]\n  disallowedTools: ["Edit", "Write"]\n---\nTest it.\n',
    );
    const home = join(place.dir, "home");
    const env = { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config") };
    const agents = lookupAgents({ projectDir: place.cwd, rulesyncGlobal: join(place.dir, "aiglobal"), defaultHarness: "claude", env });
    const steps = createSteps(onFakes(place, { agents }));
    try {
      await steps.run("hello", routed(steps, { label: "a", model: "claude/haiku", agentType: "tester" }));
    } finally {
      await steps.dispose();
    }
    const [line] = place.lines();
    assert.deepEqual(line?.tools, ["Read", "Bash"]);
    assert.deepEqual(line?.allowedTools, ["Read", "Bash(npm test)", "mcp__linear__list_issues"]);
    assert.ok(["Edit", "Write"].every((tool) => line?.disallowedTools?.includes(tool)));
  });

  it("counts only what a resumed Claude Code session adds to its cost", async () => {
    // The fake reports a total of 0.0012 for each turn, as a resumed session that spent nothing new would.
    const place = fakePlace([{ match: "city", times: 1, answer: { town: 1 } }]);
    const steps = createSteps(onFakes(place));
    const costs: number[] = [];
    const gauges: number[] = [];
    const counted = { onUsage: (u: AgentUsage) => costs.push(u.cost), onSessionCostGauge: (g: number) => gauges.push(g) };
    let first: AgentSessionRef | undefined;
    try {
      await steps.run("first", routed(steps, { label: "a", model: "claude/haiku" }, { onSessionOpen: (ref: AgentSessionRef) => (first ??= ref), ...counted }));
      const recorded = (costGauge: number) => ({ ...first!, costGauge });
      // The same total as recorded, a higher one, and a lower one, which means Claude Code started the total over.
      for (const gauge of [0.0012, 0.0005, 0.005]) await steps.run("next", routed(steps, { label: "a", model: "claude/haiku" }, { continueFromSession: recorded(gauge), ...counted }));
      // A schema repair resumes the step's own session, so its reading holds the first turn's cost.
      await steps.run("name a city", routed(steps, { label: "b", model: "claude/haiku" }, { schema: Type.Object({ city: Type.String() }, { additionalProperties: false }), ...counted }));
    } finally {
      await steps.dispose();
    }
    assert.deepEqual(costs.map((cost) => Number(cost.toFixed(6))), [0.0012, 0, 0.0007, 0.0012, 0.0012]);
    assert.deepEqual(gauges, [0.0012, 0.0012, 0.0012, 0.0012, 0.0012]);
  });

  it("gives the program the model of an agent file that names its harness, without the harness", async () => {
    const place = fakePlace();
    write(join(place.cwd, ".claude", "agents", "nobash.md"), "---\nname: nobash\nmodel: claude/haiku\n---\n");
    write(join(place.cwd, ".codex", "agents", "fixer.toml"), 'name = "fixer"\ndescription = "Fixes"\ndeveloper_instructions = "Fix."\nmodel = "codex/gpt-6.1-sol"\n');
    const home = join(place.dir, "home");
    const env = { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config") };
    const agents = lookupAgents({ projectDir: place.cwd, rulesyncGlobal: join(place.dir, "aiglobal"), defaultHarness: "claude", env });
    const steps = createSteps(onFakes(place, { agents }));
    try {
      await steps.run("hi", routed(steps, { label: "a", agentType: "nobash" }));
      await steps.run("hi", routed(steps, { label: "b", agentType: "fixer" }));
    } finally {
      await steps.dispose();
    }
    assert.deepEqual(place.lines().map((line) => [line.program, line.model]), [["claude", "haiku"], ["codex", "gpt-6.1-sol"]]);
  });

  it("records the harness alone as the model of an agent that picks none", async () => {
    const place = fakePlace();
    write(join(place.cwd, ".rulesync", "subagents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\ntargets: [\"*\"]\n---\nAnswer CODEX.\n");
    const home = join(place.dir, "home");
    const env = { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config") };
    const agents = lookupAgents({ projectDir: place.cwd, rulesyncGlobal: join(place.dir, "aiglobal"), defaultHarness: "codex", env });
    const models: string[] = [];
    const sessions: AgentSessionRef[] = [];
    const steps = createSteps(onFakes(place, { agents }));
    try {
      await steps.run("hi", routed(steps, { label: "codex agent", agentType: "reviewer" }, { onModelResolved: (id: string) => models.push(id), onSessionOpen: (ref: AgentSessionRef) => sessions.push(ref) }));
    } finally {
      await steps.dispose();
    }
    assert.deepEqual(models, ["codex"]);
    assert.deepEqual([sessions[0]?.backendId, sessions[0]?.model], ["codex", undefined]);
    assert.equal(place.lines()[0]?.program, "codex");
  });

  it("reports once per step what its program could not do as asked, also when the step fails", async () => {
    const place = fakePlace([
      { match: "city", times: 1, answer: { town: 1 } },
      { match: "broken", fail: "server fell over" },
    ]);
    const reported: Array<{ label?: string; notes: string[] }> = [];
    const steps = createSteps(onFakes(place, { onNotes: (event) => reported.push(event) }));
    const schema = Type.Object({ city: Type.String() }, { additionalProperties: false });
    try {
      await steps.run("name a city", routed(steps, { label: "codex", model: "codex/gpt-6.1-sol", skills: ["review"] }, { schema }));
      await assert.rejects(steps.run("broken", routed(steps, { label: "claude", model: "claude/haiku" }, { mode: "careful" })));
      await steps.run("hello", routed(steps, { label: "plain", model: "claude/haiku" }));
    } finally {
      await steps.dispose();
    }
    // The Codex step took a repair turn, and both its turns said the same.
    assert.equal(place.lines().filter((line) => line.program === "codex").length, 2);
    assert.deepEqual(reported, [
      { label: "codex", notes: ["Codex gets no skills from a step, so review did not reach it."] },
      { label: "claude", notes: ["Claude Code has no permission mode careful, so the user's default stays."] },
    ]);
  });

  for (const harness of ["claude", "codex"] as const) {
    const model = harness === "claude" ? "claude/haiku" : "codex/gpt-6.1-sol";

    it(`repairs a ${harness} schema answer that does not fit, in the same session`, async () => {
      const place = fakePlace([{ match: "city", times: 1, answer: { town: 1 } }]);
      const steps = createSteps(onFakes(place));
      const schema = Type.Object({ city: Type.String() }, { additionalProperties: false });
      let value: unknown;
      try {
        value = await steps.run("name a city", routed(steps, { label: "a", model }, { schema }));
      } finally {
        await steps.dispose();
      }
      assert.equal(typeof (value as { city?: unknown }).city, "string");
      const [first, repair] = place.lines();
      assert.equal(place.lines().length, 2);
      assert.equal(repair?.resume, true);
      assert.equal(repair?.sessionId, first?.sessionId);
      assert.match(repair?.prompt ?? "", /did not return valid JSON matching the required output schema/);
    });

    it(`gives up on a ${harness} schema answer that never fits after its repair turns`, async () => {
      const schema = Type.Object({ city: Type.String() }, { additionalProperties: false });
      const place = fakePlace([{ answer: { town: 1 } }]);
      const steps = createSteps(onFakes(place));
      try {
        await assert.rejects(steps.run("name a city", routed(steps, { label: "lbl", model }, { schema })), (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
          assert.equal(error.recoverable, false);
          assert.equal(error.agentLabel, "lbl");
          return true;
        });
      } finally {
        await steps.dispose();
      }
      // The first answer, then two repair turns, all in one session.
      assert.equal(place.lines().length, 3);
      assert.ok(place.lines().every((line) => line.sessionId === place.lines()[0]?.sessionId));
    });

    it(`sends a ${harness} step's images with its prompt, and refuses a bad one before it starts`, async () => {
      const place = fakePlace();
      const steps = createSteps(onFakes(place));
      const image = { data: "aGVsbG8=", mimeType: "image/png" };
      try {
        await steps.run("look", routed(steps, { label: "a", model }, { images: [image] }));
        await assert.rejects(steps.run("look", routed(steps, { label: "b", model }, { images: [{ data: "", mimeType: "image/png" }] })), (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
          assert.match(error.message, /images\[0\]\.data must be a non-empty string/);
          return true;
        });
      } finally {
        await steps.dispose();
      }
      assert.equal(place.lines().length, 1, "the bad image never reaches the program");
      assert.match(place.lines()[0]?.prompt ?? "", /\n\nlook$/);
      assert.deepEqual(place.lines()[0]?.images, [image]);
    });

    it(`pauses a ${harness} step at the usage limit, with its reset time`, async () => {
      const place = fakePlace([{ limit: { resetsAt: RESETS_AT } }]);
      const limits: string[] = [];
      const steps = createSteps(onFakes(place, { onLimit: ({ program, label }) => limits.push(`${program} ${label}`) }));
      try {
        await assert.rejects(steps.run("hello", routed(steps, { label: "a", model })), (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
          assert.equal(error.resetHint, `Resets at ${RESET_ISO}`);
          return true;
        });
      } finally {
        await steps.dispose();
      }
      assert.deepEqual(limits, [`${harness} a`]);
    });

    it(`fails a ${harness} step whose login is gone as AUTH_REQUIRED, so the run pauses for a login`, async () => {
      const place = fakePlace([{ auth: true }]);
      const steps = createSteps(onFakes(place));
      try {
        await assert.rejects(steps.run("hello", routed(steps, { label: "a", model })), (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.AUTH_REQUIRED);
          assert.equal(error.recoverable, false);
          assert.equal(error.authContext?.backendId, harness);
          return true;
        });
      } finally {
        await steps.dispose();
      }
    });

    it(`stops a ${harness} step the engine aborts, after it reported its session`, async () => {
      const place = fakePlace([{ hold: "never" }]);
      const steps = createSteps(onFakes(place));
      const controller = new AbortController();
      const sessions: string[] = [];
      try {
        const running = steps.run("hello", routed(steps, { label: "a", model }, { signal: controller.signal, onSessionOpen: (ref: AgentSessionRef) => sessions.push(ref.sessionId) }));
        await waitUntil(() => place.lines().length === 1, "the program should receive the step", 10_000);
        controller.abort();
        await assert.rejects(running);
      } finally {
        await steps.dispose();
      }
      assert.deepEqual(sessions, [place.lines()[0]?.sessionId]);
    });

    it(`times out a ${harness} step as a failure a retry can fix`, async () => {
      const place = fakePlace([{ hold: "never" }]);
      const steps = createSteps(onFakes(place));
      try {
        await assert.rejects(steps.run("hello", routed(steps, { label: "slow", model, timeout: "500ms" })), (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.match(error.message, /timed out after 1s/);
          assert.equal(error.recoverable, true);
          return true;
        });
      } finally {
        await steps.dispose();
      }
    });

    it(`fails a ${harness} step with an empty answer as a failure a retry can fix`, async () => {
      const place = fakePlace([{ answer: "  " }]);
      const steps = createSteps(onFakes(place));
      try {
        await assert.rejects(steps.run("hello", routed(steps, { label: "a", model })), (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
          assert.equal(error.recoverable, true);
          assert.equal(error.agentLabel, "a");
          return true;
        });
      } finally {
        await steps.dispose();
      }
    });

    it(`fails a ${harness} step its program failed, or that crashed, as a failure a retry can fix`, async () => {
      for (const rule of [{ fail: "server fell over" }, { exit: 3 }]) {
        const place = fakePlace([rule]);
        const steps = createSteps(onFakes(place));
        try {
          await assert.rejects(steps.run("hello", routed(steps, { label: "a", model })), (error: unknown) => {
            assert.ok(error instanceof WorkflowError);
            assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
            assert.equal(error.recoverable, true);
            assert.equal(error.agentLabel, "a");
            assert.match(error.message, "fail" in rule ? /server fell over/ : /fake crash/);
            return true;
          });
        } finally {
          await steps.dispose();
        }
      }
    });

    it(`fails a ${harness} step the model refused or cut off as a failure no retry fixes`, async () => {
      // Claude Code says so in its stop reason, Codex in the error of its failed turn.
      const cases =
        harness === "claude"
          ? [
              { rule: { stop: "refusal" }, message: /refused to answer/ },
              { rule: { stop: "max_tokens" }, message: /cut off/ },
            ]
          : [{ rule: { fail: "The input is too long.", errorInfo: "contextWindowExceeded" }, message: /too long/ }];
      for (const { rule, message } of cases) {
        const place = fakePlace([rule]);
        const steps = createSteps(onFakes(place));
        try {
          await assert.rejects(steps.run("hello", routed(steps, { label: "a", model })), (error: unknown) => {
            assert.ok(error instanceof WorkflowError);
            assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
            assert.equal(error.recoverable, false);
            assert.equal(error.agentLabel, "a");
            assert.match(error.message, message);
            return true;
          });
        } finally {
          await steps.dispose();
        }
        assert.equal(place.lines().length, 1);
      }
    });

    it(`continues a recorded ${harness} session, and runs fresh when it is gone`, async () => {
      const place = fakePlace();
      const steps = createSteps(onFakes(place));
      const provenance: AgentResultProvenance[] = [];
      let first: AgentSessionRef | undefined;
      try {
        await steps.run("first", routed(steps, { label: "a", model }, { onSessionOpen: (ref: AgentSessionRef) => (first ??= ref) }));
        assert.ok(first);
        // A journal from before the harnesses records only these three fields.
        const old = { sessionId: first.sessionId, backendId: first.backendId, cwd: first.cwd } as AgentSessionRef;
        await steps.run("second", routed(steps, { label: "a", model }, { continueFromSession: old, onResultProvenance: (p: AgentResultProvenance) => provenance.push(p) }));
        const gone = { ...old, sessionId: "00000000-0000-4000-8000-000000000000" };
        assert.equal(
          await steps.run("third", routed(steps, { label: "a", model }, { continueFromSession: gone, onResultProvenance: (p: AgentResultProvenance) => provenance.push(p) })),
          `Fake ${harness} answer.`,
        );
      } finally {
        await steps.dispose();
      }
      assert.deepEqual(provenance, [
        { source: "live", continuation: { reattached: true, method: "resume" } },
        { source: "live", continuation: { reattached: false, reason: "reattach-failed" } },
      ]);
      const lines = place.lines();
      assert.deepEqual([lines[1]?.resume, lines[1]?.sessionId], [true, first!.sessionId]);
      assert.equal(lines.at(-1)?.resume, false);
      assert.notEqual(lines.at(-1)?.sessionId, first!.sessionId);
    });
  }
});

describe("steps with a runner of their own", () => {
  it("passes agent steps on with effort, skills and listed MCP servers", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const root = temp("steps-mcp");
    const projectDir = join(root, "project");
    mkdirSync(join(projectDir, ".rulesync"), { recursive: true });
    writeFileSync(join(projectDir, ".rulesync", "mcp.jsonc"), `{ "mcpServers": { "linear": { "command": "npx", "args": [] } } }`);
    const env = { CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), XDG_CONFIG_HOME: join(root, "config") };
    const steps = createSteps({
      cwd: temp("runner"),
      inner: { run: async (_prompt: string, options: unknown) => { seen.push(options as Record<string, unknown>); return "ok"; } },
      mcp: lookupMcpServers({ projectDir, rulesyncGlobal: join(root, "aiglobal"), defaultHarness: "claude", env }, {}),
    });
    assert.equal(await steps.run("go", routed(steps, { label: "a", effort: "high", skills: ["tdd"], mcp: ["linear"] })), "ok");
    assert.deepEqual([seen[0]!.effort, seen[0]!.skills], ["high", ["tdd"]]);
    assert.equal((seen[0]!.mcpServers as Array<{ name: string }>)[0]!.name, "linear");
    assert.equal(seen[0]!.mcpNames, undefined);
    await assert.rejects(steps.run("go", routed(steps, { label: "b", mcp: ["gmail"] })), /step "b": no MCP server "gmail" for Claude Code\. orc looks in .*Add it to \.rulesync\/mcp\.jsonc\./);
  });

  it("times out an agent step as a failure a retry can fix", async () => {
    const steps = createSteps({
      cwd: temp("runner-timeout"),
      inner: {
        run: (_prompt: string, options: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      },
    });
    await assert.rejects(steps.run("slow", routed(steps, { label: "slow", timeout: "100ms" })), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.match(error.message, /timed out after 0s/);
      assert.equal(error.recoverable, true);
      return true;
    });
  });

  it("refuses a step whose model names Pi or OpenCode instead of running it on Claude Code", async () => {
    let calls = 0;
    const steps = createSteps({ cwd: temp("runner-removed"), inner: { run: async () => { calls += 1; return "ok"; } } });
    for (const model of ["pi/gpt-test", "opencode/big", "OpenCode"]) {
      await assert.rejects(steps.run("go", routed(steps, { label: "old", model })), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.match(error.message, /^step "old": model "[^"]+" names the harness "(pi|opencode)", which orc no longer runs\. Use one of claude, codex\.$/);
        assert.equal(error.recoverable, false);
        return true;
      });
    }
    assert.equal(calls, 0, "no agent session starts");
  });

  it("stops a step whose program is missing, before the agent runner sees it", async () => {
    let calls = 0;
    const empty = temp("no-programs");
    const steps = createSteps({
      cwd: temp("runner-missing"),
      inner: { run: async () => { calls++; return "ok"; } },
      programs: () => ({ env: { PATH: empty }, usualDirs: [] }),
    });
    await assert.rejects(steps.run("go", routed(steps, { label: "writer", model: "codex/gpt-6.1-sol" })), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.match(error.message, /^step "writer": Codex is not installed: no codex program on PATH/);
      assert.equal(error.recoverable, false);
      return true;
    });
    assert.equal(calls, 0);
    // A Claude Code step needs Claude Code.
    await assert.rejects(steps.run("go", routed(steps, { label: "other", model: "claude/some-model" })), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.match(error.message, /^step "other": Claude Code is not installed: no claude program on PATH/);
      return true;
    });
    assert.equal(calls, 0);
  });

  it("finds each program once per run and reports it, without changing the environment", async () => {
    const saved = { claude: process.env.CLAUDE_CODE_EXECUTABLE, codex: process.env.CODEX_PATH };
    const looked: string[] = [];
    const reported: string[] = [];
    const steps = createSteps({
      cwd: temp("runner-programs"),
      inner: { run: async () => "ok" },
      programs: (harness) => {
        looked.push(harness);
        return { path: join(FAKES, harness), env: {} };
      },
      onProgram: ({ program, path }) => reported.push(`${program} ${path}`),
    });
    await steps.run("one", routed(steps, { label: "a", model: "claude/haiku" }));
    await steps.run("two", routed(steps, { label: "b", model: "claude/opus" }));
    await steps.run("three", routed(steps, { label: "c", model: "codex/gpt-6.1-sol" }));
    await steps.dispose();
    assert.deepEqual(looked, ["claude", "codex"]);
    assert.deepEqual(reported, [`claude ${join(FAKES, "claude")}`, `codex ${join(FAKES, "codex")}`]);
    assert.deepEqual({ claude: process.env.CLAUDE_CODE_EXECUTABLE, codex: process.env.CODEX_PATH }, saved);
  });

  it("gives the runner the account of the step's harness", async () => {
    const seen: unknown[] = [];
    const steps = createSteps({
      cwd: temp("runner-account"),
      inner: { run: async (_prompt: string, options: { account?: unknown }) => { seen.push(options.account); return "ok"; } },
      accounts: { claude: { token: "t", named: true }, codex: { folder: "/codex" } },
    });
    await steps.run("one", routed(steps, { label: "a", model: "claude/haiku" }));
    await steps.run("two", routed(steps, { label: "b", model: "codex/gpt-6.1-sol" }));
    assert.deepEqual(seen, [{ token: "t", named: true }, { folder: "/codex" }]);
  });
});

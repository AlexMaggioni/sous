import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type AgentDefinition, agentDefinitionKey } from "../src/agent-registry.js";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";
import { homePaths } from "../src/runs/home.js";
import { lookupAgents } from "../src/agents.js";
import { createSteps, type InnerRunner } from "../src/steps/steps.js";

describe("agentDefinitionKey", () => {
  it("is null for undefined and stable for the same def", () => {
    assert.equal(agentDefinitionKey(undefined), null);
    const def: AgentDefinition = { name: "x", prompt: "p", tools: ["read"], source: "project" };
    assert.equal(
      agentDefinitionKey(def),
      agentDefinitionKey({ ...def, source: "user" }),
      "source is not part of identity",
    );
  });

  it("serializes the EXACT, UNCHANGED key shape (so an old journal's resume hash still matches)", () => {
    // The serialization is deliberately frozen: it is part of each agent call's resume
    // hash, so old journals must still match. Pin the literal key (field order + null
    // sentinels for absent tools/disallowedTools/model/isolation; source/name/description
    // are NOT part of identity).
    const def: AgentDefinition = { name: "x", prompt: "p", tools: ["read"], source: "project" };
    assert.equal(
      agentDefinitionKey(def),
      '{"tools":["read"],"disallowedTools":null,"model":null,"isolation":null,"prompt":"p"}',
    );
    const full: AgentDefinition = {
      name: "y",
      description: "ignored for identity",
      prompt: "body",
      tools: ["read", "grep"],
      disallowedTools: ["bash"],
      model: "vendor/m",
      isolation: "worktree",
      source: "user",
    };
    assert.equal(
      agentDefinitionKey(full),
      '{"tools":["read","grep"],"disallowedTools":["bash"],"model":"vendor/m","isolation":"worktree","prompt":"body"}',
    );
  });

  it("changes when tools/model/prompt change", () => {
    const base: AgentDefinition = { name: "x", prompt: "p", model: "m", tools: ["read"], source: "project" };
    assert.notEqual(agentDefinitionKey(base), agentDefinitionKey({ ...base, prompt: "p2" }));
    assert.notEqual(agentDefinitionKey(base), agentDefinitionKey({ ...base, model: "m2" }));
    assert.notEqual(agentDefinitionKey(base), agentDefinitionKey({ ...base, tools: ["read", "write"] }));
  });

  it("changes when isolation changes", () => {
    const base: AgentDefinition = { name: "x", prompt: "p", source: "project" };
    assert.notEqual(agentDefinitionKey(base), agentDefinitionKey({ ...base, isolation: "worktree" }));
  });
});

// ── agentType through runWorkflow ──
// capturingAgent's runner stands in for the program. Under createSteps it is the inner runner and
// gets the planned model, tools, instructions and folder. Alone it is a runner with no route().

function capturingAgent() {
  const seen: Array<{
    model?: string;
    tier?: string;
    toolNames?: string[];
    disallowedToolNames?: string[];
    instructions?: string;
    cwd?: string;
    cwdExists?: boolean;
  }> = [];
  const runner = {
    async run(_prompt: string, options: Record<string, unknown>) {
      seen.push({
        model: options.model as string | undefined,
        tier: options.tier as string | undefined,
        toolNames: options.toolNames as string[] | undefined,
        disallowedToolNames: options.disallowedToolNames as string[] | undefined,
        instructions: options.instructions as string | undefined,
        cwd: options.cwd as string | undefined,
        cwdExists: typeof options.cwd === "string" ? existsSync(options.cwd) : undefined,
      });
      return "ok";
    },
  };
  return { seen, runner };
}

describe("agentType with a runner that has no route of its own", () => {
  it("passes an agentType on as a prose hint, and binds no tools or model", async () => {
    const { seen, runner } = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
await agent('do it', { label: 'a', agentType: 'nope' })
return {}`;
    await runWorkflow(script, { agent: runner, persistLogs: false });
    assert.equal(seen[0].model, undefined, "no model bound");
    assert.equal(seen[0].toolNames, undefined, "no tool allowlist bound");
    assert.ok(seen[0].instructions?.includes("nope"), "falls back to the prose hint");
  });
});

// ── Through the steps module: the agent comes from an agent file, and createSteps routes the step ──

const AUDITOR = "---\nname: security-auditor\ndescription: sec\nclaudecode:\n  model: auditor-model\n  tools: [read, grep]\n  disallowedTools: [write, bash]\n---\nYou are a security auditor.\n";

/** A project whose agent files are given, in a folder of its own, so no real home is read. */
function agentFiles(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "ap-agent-files-"));
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".rulesync", "subagents"), { recursive: true });
  const write = (name: string, content: string) => writeFileSync(join(projectDir, ".rulesync", "subagents", `${name}.md`), content);
  for (const [name, content] of Object.entries(files)) write(name, content);
  const env = { CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), XDG_CONFIG_HOME: join(root, "config") };
  /** The steps module as the worker builds it, with the agent files as they are now. */
  const steps = (inner: InnerRunner) =>
    createSteps({ cwd: projectDir, inner, agents: lookupAgents({ projectDir, rulesyncGlobal: join(root, "aiglobal"), defaultHarness: "claude", env }) });
  return { root, write, steps };
}

describe("agentType binding through the steps module", () => {
  it("binds tools, model, and the body prompt for a known agentType", async () => {
    const { seen, runner } = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
const r = await agent('audit', { label: 'a', agentType: 'security-auditor' })
return r`;
    await runWorkflow(script, { agent: agentFiles({ "security-auditor": AUDITOR }).steps(runner), persistLogs: false });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, "claude/auditor-model", "agentType model is applied");
    assert.deepEqual(seen[0].toolNames, ["read", "grep"], "allowlist forwarded");
    assert.deepEqual(seen[0].disallowedToolNames, ["write", "bash"], "denylist forwarded");
    assert.ok(seen[0].instructions?.includes("You are a security auditor."), "body prompt injected");
  });

  it("explicit opts.model beats the agentType model", async () => {
    const { seen, runner } = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
await agent('audit', { label: 'a', agentType: 'security-auditor', model: 'explicit/model' })
return {}`;
    await runWorkflow(script, { agent: agentFiles({ "security-auditor": AUDITOR }).steps(runner), persistLogs: false });
    assert.equal(seen[0].model, "explicit/model");
  });

  it("agentType model beats the run's model", async () => {
    const { seen, runner } = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
await agent('audit', { label: 'a', agentType: 'security-auditor' })
return {}`;
    await runWorkflow(script, { agent: agentFiles({ "security-auditor": AUDITOR }).steps(runner), persistLogs: false, defaultModel: "codex/gpt-run" });
    assert.equal(seen[0].model, "claude/auditor-model", "definition model wins over the run's model");
  });

  it("agentType model beats a tier (model passed, tier still forwarded)", async () => {
    const { seen, runner } = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
await agent('audit', { label: 'a', agentType: 'security-auditor', tier: 'small' })
return {}`;
    await runWorkflow(script, { agent: agentFiles({ "security-auditor": AUDITOR }).steps(runner), persistLogs: false });
    assert.equal(seen[0].model, "claude/auditor-model", "definition model wins over tier");
  });

  it("agentType isolation: worktree runs the agent in an isolated cwd", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ap-agent-isolation-"));
    const home = homePaths(mkdtempSync(join(tmpdir(), "ap-agent-isolation-home-")));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    const files = agentFiles({ "isolated-auditor": "---\nname: isolated-auditor\ndescription: iso\nisolation: worktree\n---\nRun isolated.\n" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");

      const { seen, runner } = capturingAgent();
      const script = `export const meta = { name: 'isolated', description: 'agentType isolation' }
await agent('audit', { label: 'a', agentType: 'isolated-auditor' })
return {}`;

      await runWorkflow(script, { cwd: repo, runId: "iso-test", agent: files.steps(runner), persistLogs: false, home });

      assert.equal(seen.length, 1);
      assert.ok(seen[0].cwd, "isolated agent should receive a cwd");
      assert.notEqual(seen[0].cwd, repo, "agent cwd should not be the base repo");
      assert.equal(seen[0].cwd, join(home.worktrees, "iso-test-0-a"), "isolated cwd is under the home's worktrees folder");
      assert.equal(seen[0].cwdExists, true, "worktree cwd should exist while the agent runs");
      assert.ok(seen[0].instructions?.includes("Requested isolation: worktree"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home.home, { recursive: true, force: true });
      rmSync(files.root, { recursive: true, force: true });
    }
  });

  it("unknown agentType stops the step and binds no tools/model", async () => {
    const { seen, runner } = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
await agent('do it', { label: 'a', agentType: 'nope' })
return {}`;
    await assert.rejects(runWorkflow(script, { agent: agentFiles({ "security-auditor": AUDITOR }).steps(runner), persistLogs: false }), /step "a": no agent "nope"\./);
    assert.equal(seen.length, 0, "the step never reaches the runner, so no model or tools are bound");
  });

  it("editing a definition invalidates the resume cache for that call", async () => {
    // First run journals the call under the original definition's hash.
    const files = agentFiles({ "security-auditor": AUDITOR });
    const journal: JournalEntry[] = [];
    const first = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
const r = await agent('audit', { label: 'a', agentType: 'security-auditor' })
return r`;
    await runWorkflow(script, { agent: files.steps(first.runner), persistLogs: false, onAgentJournal: (e) => journal.push(e) });
    assert.equal(first.seen.length, 1);

    // Resume with an EDITED definition (different model) → cache must miss → re-run.
    files.write("security-auditor", AUDITOR.replace("model: auditor-model", "model: changed-model"));
    const second = capturingAgent();
    await runWorkflow(script, {
      agent: files.steps(second.runner),
      persistLogs: false,
      resumeJournal: new Map(journal.map((e) => [e.index, e])),
    });
    assert.equal(second.seen.length, 1, "edited definition busts the cache and re-runs live");
    assert.equal(second.seen[0].model, "claude/changed-model");
  });

  it("resume cache HITS when the definition is unchanged", async () => {
    const files = agentFiles({ "security-auditor": AUDITOR });
    const journal: JournalEntry[] = [];
    const first = capturingAgent();
    const script = `export const meta = { name: 'at', description: 'agentType' }
const r = await agent('audit', { label: 'a', agentType: 'security-auditor' })
return r`;
    await runWorkflow(script, { agent: files.steps(first.runner), persistLogs: false, onAgentJournal: (e) => journal.push(e) });
    const second = capturingAgent();
    await runWorkflow(script, {
      agent: files.steps(second.runner),
      persistLogs: false,
      resumeJournal: new Map(journal.map((e) => [e.index, e])),
    });
    assert.equal(second.seen.length, 0, "unchanged definition → cache hit → no live run");
  });
});

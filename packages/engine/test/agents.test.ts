// Agents and MCP servers: where the engine looks each one up, and the step it plans from it. Moved
// from orc's units test with the code it tests.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { definitionOf, lookupAgents, lookupMcpServers, planStep, routeStep, type LookupSettings } from "../src/agents.js";
import type { StepAsk, StepRoute } from "../src/steps/agent-runner.js";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `engine-${name}-`));

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A project, a global rulesync folder and harness homes of its own, so no real home is read. */
function lookupPlace(defaultHarness: LookupSettings["defaultHarness"] = "claude"): LookupSettings & { home: string; global: string } {
  const root = temp("lookup");
  const home = join(root, "home");
  const settings = {
    projectDir: join(root, "project"),
    rulesyncGlobal: join(root, "aiglobal"),
    defaultHarness,
    env: { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config") },
    home,
  };
  mkdirSync(settings.projectDir, { recursive: true });
  return { ...settings, global: join(root, "aiglobal") };
}

const rulesyncAgent = (word: string, extra = "") =>
  `---\nname: reviewer\ndescription: reviews\ntargets: ["*"]\n${extra}---\nAnswer ${word}.\n`;

describe("agents", () => {
  it("looks each agent up in the project's rulesync, the global one, then the harnesses' folders", () => {
    const place = lookupPlace();
    const project = join(place.projectDir, ".rulesync", "subagents", "reviewer.md");
    const global = join(place.global, ".rulesync", "subagents", "reviewer.md");
    const folder = join(place.projectDir, ".claude", "agents", "reviewer.md");
    const home = join(place.home, ".claude", "agents", "reviewer.md");
    write(home, "---\nname: reviewer\ndescription: reviews\n---\nAnswer HOME.\n");
    write(folder, "---\nname: reviewer\ndescription: reviews\n---\nAnswer FOLDER.\n");
    write(global, rulesyncAgent("GLOBAL"));
    write(project, rulesyncAgent("PROJECT"));
    const prompt = () => lookupAgents(place).agents.get("reviewer")?.prompt;
    assert.equal(prompt(), "Answer PROJECT.");
    writeFileSync(project, rulesyncAgent("PROJECT").replace("name: reviewer", "name: someone"));
    assert.equal(prompt(), "Answer GLOBAL.", "a file is found by the name inside it");
    writeFileSync(global, rulesyncAgent("GLOBAL").replace("name: reviewer", "name: someone-else"));
    assert.equal(prompt(), "Answer FOLDER.");
    writeFileSync(folder, "---\nname: not-reviewer\n---\nx\n");
    assert.equal(prompt(), "Answer HOME.");
  });

  it("runs a rulesync agent on the default harness or the step's, with that harness's block", () => {
    const place = lookupPlace();
    write(
      join(place.global, ".rulesync", "subagents", "reviewer.md"),
      rulesyncAgent("X", "claudecode:\n  model: haiku\n  tools: [Read, Grep]\ncodexcli:\n  model: gpt-test\n  model_reasoning_effort: low\n"),
    );
    const lookup = lookupAgents(place);
    const reviewer = lookup.agents.get("reviewer");
    assert.ok(reviewer);
    assert.equal(definitionOf(reviewer).model, "claude/haiku");
    const onClaude = planStep(lookup, "reviewer");
    assert.ok("plan" in onClaude);
    assert.deepEqual([onClaude.plan.harness, onClaude.plan.model, onClaude.plan.tools], ["claude", "claude/haiku", ["Read", "Grep"]]);
    const onCodex = planStep(lookup, "reviewer", { model: "codex" });
    assert.ok("plan" in onCodex);
    assert.deepEqual([onCodex.plan.harness, onCodex.plan.model, onCodex.plan.effort, onCodex.plan.tools], ["codex", "codex/gpt-test", "low", undefined]);
    const pinned = planStep(lookup, "reviewer", { model: "codex/gpt-other" });
    assert.ok("plan" in pinned);
    assert.equal(pinned.plan.model, "codex/gpt-other", "a full model spec in the step wins over the block");
  });

  it("keeps an agent from a harness's own folder on that harness", () => {
    const place = lookupPlace();
    const file = join(place.home, ".codex", "agents", "fixer.toml");
    write(file, 'name = "fixer"\ndescription = "fixes"\nmodel = "gpt-test"\ndeveloper_instructions = "Fix it."\n');
    const lookup = lookupAgents(place);
    const plain = planStep(lookup, "fixer");
    assert.ok("plan" in plain);
    assert.deepEqual([plain.plan.harness, plain.plan.model, plain.plan.agent.prompt], ["codex", "codex/gpt-test", "Fix it."]);
    const sent = planStep(lookup, "fixer", { model: "claude/haiku" });
    assert.ok("problem" in sent);
    assert.equal(
      sent.problem,
      `agent "fixer" comes from ${file}, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code. Move it to rulesync, as .rulesync/subagents/fixer.md in the project or in the global rulesync folder, so one file serves every harness.`,
    );
  });

  it("gives the default harness's copy of an agent in both harnesses' folders", () => {
    const place = lookupPlace();
    const claude = join(place.projectDir, ".claude", "agents", "reviewer.md");
    const codex = join(place.projectDir, ".codex", "agents", "reviewer.toml");
    write(claude, "---\nname: reviewer\ndescription: reviews\n---\nAnswer CLAUDE.\n");
    write(codex, 'name = "reviewer"\ndescription = "reviews"\ndeveloper_instructions = "Answer CODEX."\n');
    assert.equal(lookupAgents(place).agents.get("reviewer")?.prompt, "Answer CLAUDE.");
    assert.equal(lookupAgents({ ...place, defaultHarness: "codex" }).agents.get("reviewer")?.prompt, "Answer CODEX.");
    const missing = planStep(lookupAgents(place), "nobody");
    assert.ok("problem" in missing);
    assert.match(missing.problem, /^no agent "nobody"\. orc looks in \.rulesync\/subagents\/, then the global rulesync folder/);
  });

  it("refuses a broken rulesync file instead of falling back to another copy", () => {
    const place = lookupPlace();
    write(join(place.projectDir, ".rulesync", "subagents", "reviewer.md"), "---\nname: reviewer\norc:\n  harness: gemini\n---\nx\n");
    write(join(place.projectDir, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\n---\nAnswer FOLDER.\n");
    const planned = planStep(lookupAgents(place), "reviewer");
    assert.ok("problem" in planned);
    assert.match(planned.problem, /orc\.harness is "gemini"\. Use one of claude, codex\./);
  });

  it("finds an MCP server in rulesync before the harness's own config", () => {
    const place = lookupPlace();
    write(join(place.projectDir, ".rulesync", "mcp.jsonc"), `{\n  // ours\n  "mcpServers": { "word": { "command": "node", "args": ["rulesync.js"], }, },\n}`);
    write(join(place.projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { word: { command: "node", args: ["claude.js"] }, docs: { url: "http://localhost:9/mcp" } } }));
    write(join(place.home, ".codex", "config.toml"), '[mcp_servers.word]\ncommand = "node"\nargs = ["codex.js"]\n\n[mcp_servers.tickets]\ncommand = "tickets"\nenv = { TOKEN = "${TOKEN}" }\n');
    const mcp = lookupMcpServers(place, { TOKEN: "t1" });
    const args = (found: ReturnType<typeof mcp.find>) => (found?.server as { args?: string[] } | undefined)?.args;
    assert.deepEqual(args(mcp.find("word", "claude")), ["rulesync.js"]);
    assert.deepEqual(args(mcp.find("word", "codex")), ["rulesync.js"]);
    assert.equal(mcp.find("docs", "claude")?.server.name, "docs");
    assert.equal(mcp.find("docs", "codex"), undefined, "Claude Code's config is not Codex's");
    assert.deepEqual((mcp.find("tickets", "codex")?.server as { env?: unknown }).env, [{ name: "TOKEN", value: "t1" }]);
  });
});

/** The agents of the call hash pins (test/runs/call-hash-pin.test.ts), with a broken file and a Codex one. */
function pinnedLookup() {
  const place = lookupPlace();
  const files: Record<string, string> = {
    reviewer: "---\nname: reviewer\ndescription: reviews\nclaudecode:\n  model: haiku\n  tools: [Read]\n  effort: high\ncodexcli:\n  model: gpt-test\n  model_reasoning_effort: low\n---\nAnswer REVIEW.\n",
    implementer: "---\nname: implementer\ndescription: builds\n---\nBuild it.\n",
    doubler: "---\nname: doubler\ndescription: doubles\nclaudecode:\n  model: claude/haiku\n---\nDouble it.\n",
    isolated: "---\nname: isolated\ndescription: works apart\nisolation: worktree\n---\nWork apart.\n",
    broken: "---\nname: broken\norc:\n  harness: gemini\n---\nx\n",
  };
  for (const [name, content] of Object.entries(files)) write(join(place.projectDir, ".rulesync", "subagents", `${name}.md`), content);
  const fixer = join(place.home, ".codex", "agents", "fixer.toml");
  write(fixer, 'name = "fixer"\ndescription = "fixes"\nmodel = "gpt-test"\ndeveloper_instructions = "Fix it."\n');
  return { place, lookup: lookupAgents(place), fixer };
}

// The agent keys the engine hashes today. Each is agentDefinitionKey of the agent's default harness block.
const REVIEWER_KEY = '{"tools":["Read"],"disallowedTools":null,"model":"claude/haiku","isolation":null,"effort":"high","prompt":"Answer REVIEW."}';
const DOUBLER_KEY = '{"tools":null,"disallowedTools":null,"model":"claude/claude/haiku","isolation":null,"prompt":"Double it."}';
const ISOLATED_KEY = '{"tools":null,"disallowedTools":null,"model":null,"isolation":"worktree","prompt":"Work apart."}';
const IMPLEMENTER_KEY = '{"tools":null,"disallowedTools":null,"model":null,"isolation":null,"prompt":"Build it."}';
const FIXER_KEY = '{"tools":null,"disallowedTools":null,"model":"codex/gpt-test","isolation":null,"prompt":"Fix it."}';

describe("routeStep", () => {
  it("routes each pinned step with the model and agent key the call hash has today", () => {
    const { lookup } = pinnedLookup();
    const cases: Array<[string, StepAsk, StepRoute]> = [
      ["plain", {}, { agentKey: null, plan: { harness: "claude" } }],
      ["haiku", { model: "claude/haiku" }, { requested: "claude/haiku", agentKey: null, plan: { harness: "claude", model: "claude/haiku" } }],
      [
        "reviewer",
        { agentType: "reviewer" },
        { requested: "claude/haiku", agentKey: REVIEWER_KEY, prompt: "Answer REVIEW.", plan: { harness: "claude", model: "claude/haiku", effort: "high", tools: ["Read"] } },
      ],
      [
        // Case a: the hash keeps "codex" and the default block's key. The step runs the Codex block.
        "reviewer on codex",
        { agentType: "reviewer", model: "codex" },
        { requested: "codex", agentKey: REVIEWER_KEY, prompt: "Answer REVIEW.", plan: { harness: "codex", model: "codex/gpt-test", effort: "low" } },
      ],
      [
        "doubled",
        { agentType: "doubler" },
        { requested: "claude/claude/haiku", agentKey: DOUBLER_KEY, prompt: "Double it.", plan: { harness: "claude", model: "claude/claude/haiku" } },
      ],
      ["effort", { effort: "high", skills: ["tdd"] }, { agentKey: null, plan: { harness: "claude", effort: "high", skills: ["tdd"] } }],
      [
        "isolated",
        { agentType: "isolated" },
        { agentKey: ISOLATED_KEY, isolation: "worktree", prompt: "Work apart.", plan: { harness: "claude", model: "claude" } },
      ],
      ["run model", { runModel: "codex/gpt-run" }, { requested: "codex/gpt-run", agentKey: null, plan: { harness: "codex", model: "codex/gpt-run" } }],
      ["over", { model: "claude/sonnet", runModel: "codex/gpt-run" }, { requested: "claude/sonnet", agentKey: null, plan: { harness: "claude", model: "claude/sonnet" } }],
      [
        // Case b: the hash has the run's model, and the agent runs on its own harness alone.
        "no block model",
        { agentType: "implementer", runModel: "codex/gpt-run" },
        { requested: "codex/gpt-run", agentKey: IMPLEMENTER_KEY, prompt: "Build it.", plan: { harness: "claude", model: "claude" } },
      ],
      ["meta model", { runModel: "claude/sonnet" }, { requested: "claude/sonnet", agentKey: null, plan: { harness: "claude", model: "claude/sonnet" } }],
      ["phase route", { runModel: "codex/gpt-phase" }, { requested: "codex/gpt-phase", agentKey: null, plan: { harness: "codex", model: "codex/gpt-phase" } }],
    ];
    for (const [label, ask, route] of cases) assert.deepEqual(routeStep(lookup, { label, ...ask }), route, label);
  });

  it("gives today's problem for a step that cannot run, still with its model and agent key", () => {
    const { place, lookup, fixer } = pinnedLookup();
    assert.deepEqual(routeStep(lookup, { agentType: "nobody", model: "claude/haiku" }), {
      requested: "claude/haiku",
      agentKey: null,
      problem: `no agent "nobody". orc looks in .rulesync/subagents/, then the global rulesync folder (${place.global}/.rulesync/subagents/), then .claude/agents/ and .codex/agents/ in the project and in the home folder.`,
    });
    assert.deepEqual(routeStep(lookup, { agentType: "broken" }), {
      agentKey: null,
      problem: `${join(place.projectDir, ".rulesync", "subagents", "broken.md")}: orc.harness is "gemini". Use one of claude, codex.`,
    });
    assert.deepEqual(routeStep(lookup, { agentType: "fixer", model: "claude/haiku" }), {
      requested: "claude/haiku",
      agentKey: FIXER_KEY,
      prompt: "Fix it.",
      problem: `agent "fixer" comes from ${fixer}, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code. Move it to rulesync, as .rulesync/subagents/fixer.md in the project or in the global rulesync folder, so one file serves every harness.`,
    });
    assert.deepEqual(routeStep(lookup, { agentType: "reviewer", model: "pi/x" }), {
      requested: "pi/x",
      agentKey: REVIEWER_KEY,
      prompt: "Answer REVIEW.",
      problem: 'model "pi/x" names the harness "pi", which orc no longer runs. Use one of claude, codex.',
    });
    assert.deepEqual(routeStep(lookup, { model: "opencode/x" }), {
      requested: "opencode/x",
      agentKey: null,
      problem: 'model "opencode/x" names the harness "opencode", which orc no longer runs. Use one of claude, codex.',
    });
  });

  it("routes a step with no lookup on the model's harness, with no agent", () => {
    assert.deepEqual(routeStep(undefined, { agentType: "reviewer", model: "claude/haiku", isolation: "worktree" }), {
      requested: "claude/haiku",
      agentKey: null,
      isolation: "worktree",
      plan: { harness: "claude", model: "claude/haiku" },
    });
  });

  // The engine's agent tests, through routeStep: test/agent-type.test.ts and test/orchestrator-globals.test.ts.
  it("gives the agent's timeout, effort, skills and MCP names, with the step's own values replacing them", () => {
    const place = lookupPlace();
    write(
      join(place.projectDir, ".rulesync", "subagents", "reviewer.md"),
      "---\nname: reviewer\ndescription: reviews\ntimeout: 10m\neffort: high\nskills: [review, tdd]\nmcp: [linear]\nclaudecode:\n  model: haiku\n---\nYou review code.\n",
    );
    const lookup = lookupAgents(place);
    const a = routeStep(lookup, { label: "a", agentType: "reviewer" });
    const b = routeStep(lookup, { label: "b", agentType: "reviewer", skills: ["security"], mcp: [], effort: "low", timeout: 30 });
    assert.equal(a.plan?.timeoutMs, 600_000);
    assert.equal(a.plan?.effort, "high");
    assert.deepEqual(a.plan?.skills, ["review", "tdd"]);
    assert.deepEqual(a.plan?.mcp, ["linear"]);
    assert.equal(a.prompt, "You review code.");
    assert.equal(b.plan?.timeoutMs, 30_000);
    assert.equal(b.plan?.effort, "low");
    assert.deepEqual(b.plan?.skills, ["security"]);
    assert.deepEqual(b.plan?.mcp, []);
  });

  it("finds a known agent, and none for a missing name or no name", () => {
    const { lookup } = pinnedLookup();
    assert.equal(routeStep(lookup, { agentType: "reviewer" }).agentKey, REVIEWER_KEY);
    const missing = routeStep(lookup, { agentType: "missing" });
    assert.deepEqual([missing.agentKey, missing.prompt, missing.plan], [null, undefined, undefined]);
    assert.match(missing.problem ?? "", /^no agent "missing"\./);
    const none = routeStep(lookup, {});
    assert.deepEqual([none.agentKey, none.prompt, none.problem], [null, undefined, undefined]);
  });

  it("binds no model or tools for an agent no file has, and stops the step with its name", () => {
    const { lookup } = pinnedLookup();
    const nope = routeStep(lookup, { label: "a", agentType: "nope" });
    assert.equal(nope.requested, undefined, "no model bound");
    assert.equal(nope.plan, undefined, "no tool allowlist bound");
    assert.match(nope.problem ?? "", /^no agent "nope"\./);
    const nobody = routeStep(lookup, { label: "g", agentType: "nobody", model: "codex" });
    assert.equal(nobody.requested, "codex");
    assert.match(nobody.problem ?? "", /^no agent "nobody"\./);
  });

  it("puts the step's own model before the agent's, and the agent's before the run's", () => {
    const { lookup } = pinnedLookup();
    assert.equal(routeStep(lookup, { agentType: "reviewer", model: "explicit/model" }).requested, "explicit/model");
    assert.equal(routeStep(lookup, { agentType: "reviewer", runModel: "codex/gpt-run" }).requested, "claude/haiku", "the agent's model wins over the run's");
  });
});

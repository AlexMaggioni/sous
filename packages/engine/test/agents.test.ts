// Agents and MCP servers: where the engine looks each one up, and the step it plans from it. Moved
// from orc's units test with the code it tests.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { lookupAgents, lookupMcpServers, planStep, registryOf, type LookupSettings } from "../src/agents.js";

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
    assert.equal(registryOf(lookup).get("reviewer")?.model, "claude/haiku");
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

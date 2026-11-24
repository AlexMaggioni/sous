// Two parts of agent and MCP lookup that the main agents tests leave open. One is the places the
// MCP lookup names. The other is an agent file of Claude Code's own that strict YAML rejects.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { lookupAgents, lookupMcpServers, missingServer, planStep, type LookupSettings } from "../src/agents.js";
import { write } from "./helpers/files.js";

/** A project, a global rulesync folder and harness homes of its own, so no real home is read. */
function lookupPlace(global = true): LookupSettings & { home: string; globalDir: string } {
  const root = mkdtempSync(join(tmpdir(), "engine-agent-lookup-"));
  const home = join(root, "home");
  const globalDir = join(root, "aiglobal");
  const settings: LookupSettings = {
    projectDir: join(root, "project"),
    ...(global ? { rulesyncGlobal: globalDir } : {}),
    defaultHarness: "claude",
    env: { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config") },
  };
  mkdirSync(settings.projectDir, { recursive: true });
  return { ...settings, home, globalDir };
}

describe("where the MCP lookup looks", () => {
  it("names the project's rulesync file, the global one, then Claude Code's own files", () => {
    const place = lookupPlace();
    const places = lookupMcpServers(place, {}).places("claude");
    assert.deepEqual(places, [
      join(place.projectDir, ".rulesync", "mcp.jsonc"),
      join(place.globalDir, ".rulesync", "mcp.jsonc"),
      join(place.projectDir, ".mcp.json"),
      join(place.home, ".claude", ".claude.json"),
    ]);
  });

  it("names the project's rulesync file, the global one, then Codex's own files", () => {
    const place = lookupPlace();
    const places = lookupMcpServers(place, {}).places("codex");
    assert.deepEqual(places, [
      join(place.projectDir, ".rulesync", "mcp.jsonc"),
      join(place.globalDir, ".rulesync", "mcp.jsonc"),
      join(place.projectDir, ".codex", "config.toml"),
      join(place.home, ".codex", "config.toml"),
    ]);
  });

  it("leaves the global file out when no global rulesync folder is set", () => {
    const place = lookupPlace(false);
    const places = lookupMcpServers(place, {}).places("claude");
    assert.deepEqual(places, [join(place.projectDir, ".rulesync", "mcp.jsonc"), join(place.projectDir, ".mcp.json"), join(place.home, ".claude", ".claude.json")]);
  });

  it("lists the global file in the message for a server that is nowhere", () => {
    const place = lookupPlace();
    const message = missingServer("gmail", "codex", lookupMcpServers(place, {}));
    assert.ok(message.startsWith('no MCP server "gmail" for Codex. sous looks in '), message);
    assert.ok(message.includes(join(place.globalDir, ".rulesync", "mcp.jsonc")), message);
    assert.ok(message.endsWith(" Add it to .rulesync/mcp.jsonc."), message);
  });

  it("finds a server in the global rulesync file when the project has none", () => {
    const place = lookupPlace();
    write(join(place.globalDir, ".rulesync", "mcp.jsonc"), JSON.stringify({ mcpServers: { tickets: { command: "tickets", args: ["serve"] } } }));
    const found = lookupMcpServers(place, {}).find("tickets", "codex");
    assert.equal(found?.file, join(place.globalDir, ".rulesync", "mcp.jsonc"));
    assert.deepEqual((found?.server as { args?: string[] }).args, ["serve"]);
  });
});

describe("an agent file of Claude Code's own that strict YAML rejects", () => {
  // A colon inside the description is not valid YAML, and Claude Code accepts it.
  const file = "---\nname: auditor\ndescription: Checks: the diff\nmodel: haiku\ntools: [Read, Grep]\ndisallowedTools: [\"Write\", 'Edit']\n---\nYou audit.\n";

  it("keeps its name, description and prompt", () => {
    const place = lookupPlace();
    write(join(place.projectDir, ".claude", "agents", "auditor.md"), file);
    const agent = lookupAgents(place).agents.get("auditor");
    assert.equal(agent?.description, "Checks: the diff");
    assert.equal(agent?.prompt, "You audit.");
  });

  it("reads a bracketed value as a list, and drops the quotes around its items", () => {
    const place = lookupPlace();
    write(join(place.projectDir, ".claude", "agents", "auditor.md"), file);
    const planned = planStep(lookupAgents(place), "auditor");
    assert.ok("plan" in planned, JSON.stringify(planned));
    assert.deepEqual(planned.plan.tools, ["Read", "Grep"]);
    assert.deepEqual(planned.plan.disallowedTools, ["Write", "Edit"]);
  });

  it("reads a value without brackets as one text", () => {
    const place = lookupPlace();
    write(join(place.projectDir, ".claude", "agents", "auditor.md"), file);
    const planned = planStep(lookupAgents(place), "auditor");
    assert.ok("plan" in planned, JSON.stringify(planned));
    assert.equal(planned.plan.model, "claude/haiku");
  });
});

import { describe, expect, test } from "vitest";
import type { AgentRow, McpRow, SkillRow, WorkflowRow } from "../src/api/contract.ts";
import { agentsSummary, harnesses, mcpSummary, skillsSummary, workflowsSummary } from "../src/pages/catalog-summary.ts";

const workflow = (from: WorkflowRow["from"], startedBy: WorkflowRow["startedBy"] = "anyone"): WorkflowRow => ({ name: "w", file: "w.ts", from, changed: false, problems: 0, startedBy });
const agent = (only?: AgentRow["only"]): AgentRow => ({ name: "a", harness: only ?? "claude", file: "a.md", ...(only ? { only } : {}) });
const skill = (...list: SkillRow["harnesses"]): SkillRow => ({ name: "s", harnesses: list, file: "SKILL.md" });
const mcp = (type: McpRow["type"]): McpRow => ({ name: "m", type, seenBy: ["claude"], source: ".mcp.json" });

describe("the sentence under a catalog home's title", () => {
  test("counts the workflows by where they live, and says who may start them", () => {
    expect(workflowsSummary([workflow("project"), workflow("project", "people"), workflow("home")], "shop")).toBe("3 saved workflows: 2 in shop, 1 in your home. 1 only people can start.");
    expect(workflowsSummary([workflow("project"), workflow("project")], "shop")).toBe("2 saved workflows: all in shop.");
    expect(workflowsSummary([workflow("home")], "shop")).toBe("1 saved workflow: all in your home.");
  });

  test("leaves out the groups with nothing in them", () => {
    expect(agentsSummary([agent(), agent("codex")])).toBe("2 agents: 1 for both harnesses, 1 for Codex only.");
    expect(skillsSummary([skill("claude", "codex"), skill("claude")])).toBe("2 skills: 1 found by both harnesses, 1 found by Claude Code only.");
    expect(mcpSummary([mcp("stdio"), mcp("http"), mcp("sse")])).toBe("3 MCP servers: 1 local over stdio, 2 remote over http or sse.");
  });

  test("names the harnesses that see an item", () => {
    expect(harnesses(["claude", "codex"])).toBe("Both");
    expect(harnesses(["codex"])).toBe("Codex");
    expect(harnesses([])).toBe("Neither");
  });
});

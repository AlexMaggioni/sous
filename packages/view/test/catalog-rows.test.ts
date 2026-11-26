import { describe, expect, test } from "vitest";
import type { AgentRow, McpRow, SkillRow, WorkflowRow } from "../src/api/contract.ts";
import { groupWorkflows, onlyOn, pickAgents, pickMcps, pickSkills, workflowMark } from "../src/lists/catalog-rows.ts";

const workflow = (name: string, more: Partial<WorkflowRow> = {}): WorkflowRow => ({
  name,
  file: `/work/shop/.sous/workflows/${name}.js`,
  from: "project",
  changed: false,
  problems: 0,
  startedBy: "anyone",
  ...more,
});

describe("the workflows list", () => {
  const rows = [workflow("review", { description: "Draft release notes" }), workflow("build", { from: "home" }), workflow("fanout"), workflow("review", { from: "home" })];

  test("shows the project's workflows first, then the home's, each by name", () => {
    expect(groupWorkflows(rows, "shop", "").map((g) => [g.label, g.items.map((w) => w.name)])).toEqual([
      ["shop", ["fanout", "review"]],
      ["Home", ["build", "review"]],
    ]);
  });

  test("searches the name and the description, and drops an empty group", () => {
    expect(groupWorkflows(rows, "shop", "release").map((g) => [g.key, g.items.map((w) => w.name)])).toEqual([["project", ["review"]]]);
    expect(groupWorkflows(rows, "shop", "nothing")).toEqual([]);
  });

  test("marks a problem over a change, and nothing when all is well", () => {
    expect(workflowMark(workflow("a", { problems: 1, changed: true }))).toBe("problem");
    expect(workflowMark(workflow("a", { changed: true }))).toBe("changed");
    expect(workflowMark(workflow("a"))).toBeUndefined();
  });
});

describe("the agents, skills and MCP lists", () => {
  const agents: AgentRow[] = [
    { name: "writer", harness: "codex", only: "codex", file: "w.md", description: "Writes the notes" },
    { name: "reviewer", harness: "claude", file: "r.md", model: "opus" },
  ];

  test("sorts agents by name and searches the description, harness and model", () => {
    expect(pickAgents(agents, "").map((a) => a.name)).toEqual(["reviewer", "writer"]);
    expect(pickAgents(agents, "notes").map((a) => a.name)).toEqual(["writer"]);
    expect(pickAgents(agents, "claude code").map((a) => a.name)).toEqual(["reviewer"]);
    expect(pickAgents(agents, "opus").map((a) => a.name)).toEqual(["reviewer"]);
  });

  test("says which harness alone runs an agent", () => {
    expect(onlyOn(agents[0] as AgentRow)).toBe("Codex only");
    expect(onlyOn(agents[1] as AgentRow)).toBeUndefined();
  });

  test("sorts skills and MCP servers by name and searches their words", () => {
    const skills: SkillRow[] = [
      { name: "tdd", harnesses: ["claude"], file: "t" },
      { name: "release-notes", description: "From merged pull requests", harnesses: ["claude", "codex"], file: "r" },
    ];
    expect(pickSkills(skills, "").map((s) => s.name)).toEqual(["release-notes", "tdd"]);
    expect(pickSkills(skills, "pull").map((s) => s.name)).toEqual(["release-notes"]);

    const mcps: McpRow[] = [
      { name: "linear", type: "http", seenBy: ["claude"], source: "~/.claude.json" },
      { name: "files", type: "stdio", seenBy: ["claude", "codex"], source: ".rulesync/mcp.jsonc" },
    ];
    expect(pickMcps(mcps, "").map((m) => m.name)).toEqual(["files", "linear"]);
    expect(pickMcps(mcps, "rulesync").map((m) => m.name)).toEqual(["files"]);
    expect(pickMcps(mcps, "http").map((m) => m.name)).toEqual(["linear"]);
  });
});

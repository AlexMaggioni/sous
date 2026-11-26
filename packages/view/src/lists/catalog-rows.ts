import type { AgentRow, Harness, McpRow, SkillRow, WorkflowRow } from "../api/contract.ts";
import { matches } from "./filter.ts";
import type { ListGroup } from "./run-groups.ts";

// The rows of the Workflows, Agents, Skills and MCP lists. A row is the name alone, and a mark
// shows only when something is off, as DESIGN.md says.

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/**
 * The project's workflows first, under the project's name, since they win over the home's on a
 * name clash. Then the home's, under "Home". The search looks at the name and the description.
 */
export function groupWorkflows(rows: readonly WorkflowRow[], projectName: string, query: string): ListGroup<WorkflowRow>[] {
  const shown = rows.filter((row) => matches([row.name, row.description], query)).sort(byName);
  const groups: ListGroup<WorkflowRow>[] = [
    { key: "project", label: projectName, items: shown.filter((row) => row.from === "project") },
    { key: "home", label: "Home", items: shown.filter((row) => row.from === "home") },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** A check problem wins over a change since the person's yes. */
export function workflowMark(row: WorkflowRow): "problem" | "changed" | undefined {
  if (row.problems > 0) return "problem";
  if (row.changed) return "changed";
  return undefined;
}

export const HARNESS_NAME: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };

/** "Codex only" for an agent that lives in one harness's own folder. */
export const onlyOn = (agent: AgentRow): string | undefined => (agent.only ? `${HARNESS_NAME[agent.only]} only` : undefined);

/** Agents by name. The search looks at the name, the description and the harness. */
export const pickAgents = (rows: readonly AgentRow[], query: string): AgentRow[] =>
  rows.filter((row) => matches([row.name, row.description, HARNESS_NAME[row.harness], row.model], query)).sort(byName);

/** Skills by name. The search looks at the name and the description. */
export const pickSkills = (rows: readonly SkillRow[], query: string): SkillRow[] => rows.filter((row) => matches([row.name, row.description], query)).sort(byName);

/** MCP servers by name. The search looks at the name, the type and the file that defines it. */
export const pickMcps = (rows: readonly McpRow[], query: string): McpRow[] => rows.filter((row) => matches([row.name, row.type, row.source], query)).sort(byName);

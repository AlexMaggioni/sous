// Who names an agent, a skill or an MCP server: the project's agents, and the steps of the saved
// workflows the project sees, read from their text. A name made while a run runs is not seen.

import type { AgentLookup } from "../agents.js";
import type { HomePaths } from "../runs/home.js";
import { projectWorkflows, workflowText } from "../workflows/dir.js";
import { readWorkflowScript, type ScriptCall } from "../workflows/script.js";
import type { UsedBy } from "./types.js";

/** One step call of a saved workflow. */
export interface SavedCall {
  workflow: string;
  call: ScriptCall;
}

/** Each step call of the saved workflows the project sees, the project's then the home's. A file
 *  that does not parse gives none. */
export function savedCalls(paths: HomePaths, projectDir: string): SavedCall[] {
  const calls: SavedCall[] = [];
  for (const entry of projectWorkflows(paths, projectDir).list()) {
    const text = entry.error ? undefined : workflowText(entry.file);
    if (text === undefined) continue;
    try {
      for (const call of readWorkflowScript(text).refs.calls) calls.push({ workflow: entry.name, call });
    } catch {
      // The file changed since the list read it, and no longer parses.
    }
  }
  return calls;
}

/** A step as a page names it: its literal label, else its kind, as the workflow's graph does. */
export const stepName = (call: ScriptCall): string => call.label ?? call.kind;

/** The rows of a list, each once, in their first order. */
export function once<T>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The agents and the agent steps that list a skill or an MCP server. An agent counts when its
 *  common settings or any of its harness blocks list it. */
export function usedBy(lookup: AgentLookup, calls: SavedCall[], list: "skills" | "mcp", name: string): UsedBy {
  const agents = [...lookup.agents.values()]
    .filter((agent) => [agent.common, ...Object.values(agent.blocks)].some((settings) => settings?.[list]?.includes(name)))
    .map((agent) => agent.name)
    .sort();
  const steps = calls.filter(({ call }) => call[list]?.includes(name));
  return once([
    ...agents.map((agent) => ({ kind: "agent" as const, name: agent })),
    ...steps.map(({ workflow, call }) => ({ kind: "step" as const, name: stepName(call), workflow })),
  ]);
}

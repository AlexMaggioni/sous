/**
 * Named workflow subagent definitions ("agentType" registry).
 *
 * A workflow script can route an agent() call to a reusable, named definition:
 *
 *   agent("audit this dir", { agentType: "security-auditor" })
 *
 * The host builds the registry and passes it as the `agentRegistry` run option.
 * orc reads agent files with its own parser. A definition binds the subagent's
 * tools, model, and a body prompt. This mirrors Claude Code's `.claude/agents`
 * registry: agentType is a real binding of tools+model+system-prompt, not a prose hint.
 *
 * Bound: `tools` (allowlist), `disallowedTools` (denylist), `model`, and the
 * markdown body (`prompt`). `skills`, `mcp`, `effort` and `timeout` are defaults that
 * a step's own values replace. Wired: `isolation` ("worktree") → createWorktree().
 *
 * Keep the `agentDefinitionKey` serialization as it is: it is part of each agent
 * call's resume hash, so a change would make every old journal miss.
 */

export interface AgentDefinition {
  /** Stable identity used as the `agentType` value. */
  name: string;
  /** One-line summary (for discoverability in the tool guideline). */
  description?: string;
  /** Allowlist of coding-tool names the subagent may use. Undefined = all. */
  tools?: string[];
  /** Denylist of coding-tool names, applied after the allowlist. */
  disallowedTools?: string[];
  /** Model spec: optional registered harness prefix plus a verbatim id, or a backend-only name. */
  model?: string;
  /** Isolation mode. When "worktree", agents using this type run in a git worktree. */
  isolation?: "worktree";
  /** Default skills for this agent. A step's list replaces them. */
  skills?: string[];
  /** Default MCP server names (from the host's servers file). A step's list replaces them. */
  mcp?: string[];
  /** Default reasoning effort. */
  effort?: string;
  /** Default time limit for one attempt, such as "10m". */
  timeout?: string;
  /** Markdown body, prepended to the subagent's task as role guidance. */
  prompt: string;
  /** Where the definition was loaded from (project wins over user). */
  source: "project" | "user";
}

export type AgentRegistry = Map<string, AgentDefinition>;

/** Resolve an agentType name to its definition, or undefined if not registered. */
export function resolveAgentType(name: string | undefined, registry: AgentRegistry): AgentDefinition | undefined {
  if (!name) return undefined;
  return registry.get(name);
}

/**
 * A stable identity string for a resolved definition, folded into the resume
 * call-hash so editing an agent `.md` invalidates that call's cached result.
 */
export function agentDefinitionKey(def: AgentDefinition | undefined): string | null {
  if (!def) return null;
  return JSON.stringify({
    tools: def.tools ?? null,
    disallowedTools: def.disallowedTools ?? null,
    model: def.model ?? null,
    isolation: def.isolation ?? null,
    // Only when set, so older journals keep replaying.
    ...(def.skills ? { skills: def.skills } : {}),
    ...(def.effort ? { effort: def.effort } : {}),
    prompt: def.prompt,
  });
}

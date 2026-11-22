/**
 * Named workflow subagent definitions ("agentType" registry).
 *
 * A workflow script can route an agent() call to a reusable, named definition:
 *
 *   agent("audit this dir", { agentType: "security-auditor" })
 *
 * Definitions live as Markdown files under `<AGENTS_DIR>/*.md` (project,
 * cwd-relative) and `~/<AGENTS_DIR>/*.md` (user). Frontmatter binds the subagent's
 * tools, model, and a body prompt; project definitions win on a name collision.
 * This mirrors Claude Code's `.claude/agents` registry: agentType is a real binding
 * of tools+model+system-prompt, not a prose hint.
 *
 * Bound: `tools` (allowlist), `disallowedTools` (denylist), `model`, and the
 * markdown body (`prompt`). `skills`, `mcp`, `effort` and `timeout` are defaults that
 * a step's own values replace. Other keys, such as `background`, are ignored. Wired: `isolation`
 * ("worktree") → createWorktree().
 *
 * The scanned directory is PARAMETERIZED (loadAgentRegistry's `opts`), replacing
 * Pi's old hardcoded agents directory. The `agentDefinitionKey` serialization is
 * unchanged so a resume hash computed under Pi still matches.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { AGENTS_DIR } from "./config.js";
import { parseFrontmatter } from "./frontmatter.js";

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

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const arr = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return arr.length ? arr : undefined;
}

/**
 * Parse one agent-definition markdown file. Returns null only when there is no
 * usable content (no name derivable and an empty body).
 */
function optionalString(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

// Skills, MCP servers, effort and timeout. Set only when present, so a
// definition without them keeps its old shape and journal identity.
function orchestratorFields(fm: Record<string, unknown>): Pick<AgentDefinition, "skills" | "mcp" | "effort" | "timeout"> {
  const skills = toStringArray(fm.skills);
  const mcp = toStringArray(fm.mcp ?? fm.mcpServers);
  const effort = optionalString(fm.effort);
  const timeout = optionalString(fm.timeout);
  return {
    ...(skills ? { skills } : {}),
    ...(mcp ? { mcp } : {}),
    ...(effort ? { effort } : {}),
    ...(timeout ? { timeout } : {}),
  };
}

export function parseAgentDefinition(
  content: string,
  source: "project" | "user",
  fileName: string,
): AgentDefinition | null {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(content);
  } catch {
    // Malformed frontmatter: treat the whole file as a body, name from filename.
    parsed = { frontmatter: {}, body: content };
  }
  const fm = parsed.frontmatter;
  const fmName = typeof fm.name === "string" ? fm.name.trim() : "";
  const name = fmName || basename(fileName).replace(/\.md$/i, "").trim();
  const prompt = parsed.body.trim();
  if (!name && !prompt) return null;

  return {
    name,
    description: typeof fm.description === "string" ? fm.description.trim() || undefined : undefined,
    tools: toStringArray(fm.tools),
    disallowedTools: toStringArray(fm.disallowedTools),
    model: typeof fm.model === "string" ? fm.model.trim() || undefined : undefined,
    isolation:
      typeof fm.isolation === "string" && fm.isolation.toLowerCase().trim() === "worktree" ? "worktree" : undefined,
    ...orchestratorFields(fm),
    prompt,
    source,
  };
}

function readDefsFromDir(dir: string, source: "project" | "user"): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
  const defs: AgentDefinition[] = [];
  for (const file of files.sort()) {
    try {
      const def = parseAgentDefinition(readFileSync(join(dir, file), "utf-8"), source, file);
      if (def) defs.push(def);
    } catch {
      // Skip unreadable/invalid files; never let one bad file break the registry.
    }
  }
  return defs;
}

/**
 * Load the agent registry once for a run. Scans the project dir then the user
 * dir; the FIRST definition for a name wins (project > user, then filename
 * order), so a name collision is resolved deterministically and silently.
 *
 * `opts` overrides the scanned directories. By default the project dir is
 * `<cwd>/<AGENTS_DIR>` and the user dir is `~/<AGENTS_DIR>`, where AGENTS_DIR is
 * the engine's default (`.orchestrator/engine/agents`). The engine threads its
 * `agentsDir` option through here so a host can point the registry anywhere.
 */
export function loadAgentRegistry(cwd: string, opts?: { projectDir?: string; userDir?: string }): AgentRegistry {
  const projectDir = opts?.projectDir ?? join(cwd, AGENTS_DIR);
  const userDir = opts?.userDir ?? join(homedir(), AGENTS_DIR);
  const registry: AgentRegistry = new Map();
  for (const def of readDefsFromDir(projectDir, "project")) {
    if (def.name && !registry.has(def.name)) registry.set(def.name, def);
  }
  if (userDir !== projectDir) {
    for (const def of readDefsFromDir(userDir, "user")) {
      if (def.name && !registry.has(def.name)) registry.set(def.name, def);
    }
  }
  return registry;
}

/**
 * Turn the engine's `agentsDir` option into the registry's dirs. It may hold
 * a project dir and a user dir joined by the path delimiter, so the project wins over the user.
 */
export function agentDirsFromOption(agentsDir: string | undefined): { projectDir: string; userDir: string } | undefined {
  if (!agentsDir) return undefined;
  const [projectDir, userDir] = agentsDir.split(delimiter);
  return { projectDir: projectDir!, userDir: userDir || projectDir! };
}

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

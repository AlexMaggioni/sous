// What the catalog and the two removals give the page `sous serve` opens. The engine can't import
// the view, so these copy the "Agents", "Skills", "MCP" and "Removals" types of
// packages/view/src/api/contract.ts, with the same names and fields. The server returns them as
// they are. Each of its routes names the contract's type of its answer (cli serve/routes.ts), so
// its typecheck fails when one of these no longer fits the contract.

import type { HarnessId as Harness } from "@sous-run/harnesses";

export interface AgentSettings {
  harness: Harness;
  model?: string;
  effort?: string;
  /** Claude Code's permission mode. */
  mode?: string;
  /** "all" when it has no allow list. */
  tools: string[] | "all";
  disallowedTools?: string[];
  skills?: string[];
  mcp?: string[];
}

export interface AgentPage {
  name: string;
  description?: string;
  /** The body of the file, the agent's prompt, in markdown. */
  prompt: string;
  /** The whole file. */
  raw: string;
  file: string;
  from: "rulesync" | Harness;
  scope: "project" | "global";
  /** The harness a step runs it on when the step names none. */
  harness: Harness;
  /** One entry per harness it can run on, the default harness first. */
  settings: AgentSettings[];
  /** Where it works: "worktree" for a worktree of its own. */
  place?: "worktree";
  timeout?: string;
  /** The workflow steps that name it. */
  usedBy: Array<{ workflow: string; step: string }>;
  /** Files with the same name that lose to this one. */
  copies: Array<{ file: string; from: "rulesync" | Harness; scope: "project" | "global" }>;
  problem?: string;
}

export interface SkillRow {
  name: string;
  description?: string;
  /** The harnesses that find it. */
  harnesses: Harness[];
  file: string;
}

/** Who lists a skill or an MCP server: an agent by its name, or a step by its label in a workflow. */
export type UsedBy = Array<{ kind: "agent" | "step"; name: string; workflow?: string }>;

export interface SkillPage {
  name: string;
  description?: string;
  /** SKILL.md without its front matter. */
  body: string;
  raw: string;
  file: string;
  /** Where each copy lives, one row per folder that has it. */
  copies: Array<{ harness: Harness | "rulesync"; scope: "project" | "global"; file: string }>;
  /** Harnesses that don't find it. */
  missing: Harness[];
  usedBy: UsedBy;
}

export interface McpRow {
  name: string;
  type: "stdio" | "http" | "sse";
  /** The harnesses whose steps can name it. */
  seenBy: Harness[];
  /** Where it is defined, such as ".rulesync/mcp.jsonc" or "~/.claude.json". */
  source: string;
}

export interface McpPage extends McpRow {
  command?: string;
  args?: string[];
  url?: string;
  /** Values that hold a secret are masked, such as "••••3f9a" or "${LINEAR_API_KEY}". */
  env: McpValue[];
  headers: McpValue[];
  /** Every file that defines it, the one that wins first. */
  files: Array<{ file: string; scope: "project" | "global"; harness: Harness | "rulesync" }>;
  usedBy: UsedBy;
  /** The server's entry as the file writes it, with secrets masked. */
  raw: string;
}

export interface McpValue {
  key: string;
  value: string;
  secret: boolean;
  /** Where sous reads it: "secrets.env", "the environment", or nothing for a literal. */
  from?: string;
}

export interface Removed {
  removed: string;
  /** Where the file went, for a workflow. */
  trash?: string;
}

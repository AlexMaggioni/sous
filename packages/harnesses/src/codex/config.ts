// What a step sends Codex: the mode preset, the thread config with its MCP servers and deny
// list, and how the adapter reads token usage and rate limits back.

import { mcpTool, toolName } from "../tools.js";
import type { McpServer, Step, Usage } from "../types.js";
import { usage } from "../failure.js";
import type { JsonValue } from "./generated/serde_json/JsonValue.js";
import type { ApprovalsReviewer } from "./generated/v2/ApprovalsReviewer.js";
import type { AskForApproval } from "./generated/v2/AskForApproval.js";
import type { ConfigReadResponse } from "./generated/v2/ConfigReadResponse.js";
import type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot.js";
import type { RateLimitWindow } from "./generated/v2/RateLimitWindow.js";
import type { SandboxMode } from "./generated/v2/SandboxMode.js";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy.js";
import type { TokenUsageBreakdown } from "./generated/v2/TokenUsageBreakdown.js";

export interface Mode {
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  sandbox: SandboxMode;
  sandboxPolicy: SandboxPolicy;
}

const workspaceWrite: SandboxPolicy = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };

/** The modes a step can name. "agent" asks only for actions its reviewer finds unsafe. */
export const MODES: Record<string, Mode> = {
  "read-only": { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } },
  "workspace-write": { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", sandboxPolicy: workspaceWrite },
  agent: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write", sandboxPolicy: workspaceWrite },
  "agent-full-access": { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } },
};
export const DEFAULT_MODE = "agent";

/** Codex config keys cannot hold whitespace, so a server name's whitespace becomes underscores. */
export const serverName = (name: string) => name.replace(/\p{White_Space}/gu, "_");

/** The MCP server names the user's config files give, from config/read with its layers. */
export function configuredServers(read: ConfigReadResponse): Set<string> {
  const names = new Set<string>();
  const tables = [read.config.mcp_servers, ...(read.layers ?? []).map((layer) => asObject(layer.config)?.mcp_servers)];
  for (const table of tables) for (const name of Object.keys(asObject(table) ?? {})) names.add(name);
  return names;
}

function asObject(value: unknown): Record<string, JsonValue | undefined> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue | undefined>) : undefined;
}

export function serverConfig(server: McpServer): Record<string, JsonValue> {
  if (server.type === "http") return { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) };
  return { command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}) };
}

/**
 * The thread's config object, and the notes on what it could not honor.
 *
 * Codex deep-merges a thread's mcp_servers into the user's config, so a step server with a
 * configured name would keep the configured keys, and a clash of transports fails the thread.
 * The step turns the configured server off and runs its own under a new name instead.
 * Deny entries for MCP tools become disabled_tools on the server that runs.
 */
export function threadConfig(step: Step, configured: Set<string>): { config: Record<string, JsonValue>; notes: string[] } {
  const notes: string[] = [];
  const servers: Record<string, Record<string, JsonValue>> = {};
  // A step server's name, or a configured name, to the name it runs under.
  const runsAs = new Map<string, string>();
  const taken = new Set(configured);
  for (const server of step.mcpServers ?? []) {
    const name = serverName(server.name);
    let as = name;
    if (configured.has(name)) {
      servers[name] = { enabled: false };
      as = `${name}_step`;
      for (let i = 2; taken.has(as); i++) as = `${name}_step${i}`;
      notes.push(`Codex merges a step's MCP server into a configured one of the same name, so ${name} runs as ${as} for this step and the configured ${name} is off.`);
    }
    taken.add(as);
    runsAs.set(name, as);
    servers[as] = serverConfig(server);
  }
  for (const name of configured) if (!runsAs.has(name)) runsAs.set(name, name);

  for (const entry of step.tools?.deny ?? []) {
    const name = toolName(entry);
    const whole = /^mcp__(.+)$/.exec(name);
    if (!whole) continue;
    const parsed = mcpTool(entry);
    const server = serverName(parsed?.server ?? whole[1]!);
    const as = runsAs.get(server);
    if (!as) {
      notes.push(`No MCP server ${server} runs in this step, so the deny entry ${entry} has nothing to turn off.`);
      continue;
    }
    const table = (servers[as] ??= {});
    if (!parsed) {
      table.enabled = false;
      continue;
    }
    const off = Array.isArray(table.disabled_tools) ? table.disabled_tools : [];
    if (!off.includes(parsed.tool)) table.disabled_tools = [...off, parsed.tool];
  }

  const config: Record<string, JsonValue> = { projects: { [step.cwd]: { trust_level: "trusted" } } };
  if (Object.keys(servers).length) config.mcp_servers = servers;
  // Codex offers request_user_input outside plan mode only with this feature on.
  if (step.ask) config.features = { default_mode_request_user_input: true };
  return { config, notes };
}

/** Notes for the parts of a step's tool lists that Codex has no switch for. */
export function toolNotes(step: Step): string[] {
  const notes: string[] = [];
  const builtIn = (step.tools?.deny ?? []).filter((entry) => !entry.startsWith("mcp__"));
  if (builtIn.length) {
    notes.push(`Codex has no switch to turn off ${builtIn.join(", ")}. It runs sandboxed actions without asking, and the adapter declines the approval requests these entries match.`);
  }
  if (step.tools?.allow?.length) {
    notes.push("Codex has no allow list. The adapter declines the approval requests the allow list does not cover, and Codex runs sandboxed actions without asking.");
  }
  return notes;
}

/**
 * A turn's tokens. Codex counts cached and cache-write tokens inside inputTokens, so input is
 * what is left, and total equals Codex's own totalTokens.
 */
export function turnUsage(last: TokenUsageBreakdown): Usage {
  const input = Math.max(0, last.inputTokens - last.cachedInputTokens - last.cacheWriteInputTokens);
  return usage(input, last.outputTokens, last.cachedInputTokens, last.cacheWriteInputTokens);
}

/** A sparse rate-limit update keeps the earlier window where it has none. */
export function mergeLimits(previous: RateLimitSnapshot | undefined, update: RateLimitSnapshot): RateLimitSnapshot {
  if (!previous) return update;
  return {
    ...update,
    primary: update.primary ?? previous.primary,
    secondary: update.secondary ?? previous.secondary,
    credits: update.credits ?? previous.credits,
    individualLimit: update.individualLimit ?? previous.individualLimit,
    spendControlReached: update.spendControlReached ?? previous.spendControlReached,
    planType: update.planType ?? previous.planType,
    rateLimitReachedType: update.rateLimitReachedType ?? previous.rateLimitReachedType,
  };
}

/** When the spent limit resets: a full window's reset, else the latest reset, as ISO. */
export function resetAt(snapshots: Iterable<RateLimitSnapshot>): string | undefined {
  const windows = [...snapshots]
    .flatMap((snapshot) => [snapshot.primary, snapshot.secondary])
    .filter((window): window is RateLimitWindow & { resetsAt: number } => typeof window?.resetsAt === "number");
  if (!windows.length) return undefined;
  const full = windows.find((window) => window.usedPercent >= 100);
  const at = full ? full.resetsAt : Math.max(...windows.map((window) => window.resetsAt));
  return new Date(at * 1000).toISOString();
}

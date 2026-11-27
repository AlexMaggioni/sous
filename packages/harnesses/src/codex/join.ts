// The arguments that open a step's Codex thread by hand, with `codex resume`, in the program's own
// view. Codex reads each -c value as TOML, and a value that does not parse becomes a plain string.

import type { JsonValue } from "./generated/serde_json/JsonValue.js";
import type { Harness } from "../types.js";
import { serverConfig, serverName } from "./config.js";

type JoinStep = Parameters<Harness["joinArgs"]>[0];

/** The flags for each mode a step can name, as runCodex sets them on the thread. */
const MODE_FLAGS: Record<string, string[]> = {
  "read-only": ["-s", "read-only", "-a", "on-request"],
  "workspace-write": ["-s", "workspace-write", "-a", "on-request"],
  agent: ["--approve-for-me"],
  "agent-full-access": ["-s", "danger-full-access", "-a", "never"],
};

/** A TOML basic string. JSON escapes every control character but DEL, which TOML also forbids. */
function tomlString(text: string): string {
  return JSON.stringify(text).replace(/\x7f/g, "\\u007f");
}

/** A TOML key: bare when it can be, quoted otherwise. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** A TOML value on one line, with inline tables and arrays. */
function tomlValue(value: JsonValue): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value === null) return '""';
  const entries = Object.entries(value).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined);
  return entries.length ? `{ ${entries.map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`).join(", ")} }` : "{}";
}

export function codexJoinArgs(join: JoinStep): { args: string[]; notes: string[] } {
  const args = ["resume", join.sessionId, "-C", join.cwd];
  const notes: string[] = [];
  if (join.model) args.push("-m", join.model);
  if (join.effort) args.push("-c", `model_reasoning_effort=${tomlString(join.effort)}`);
  if (join.mode) {
    const flags = MODE_FLAGS[join.mode];
    if (flags) args.push(...flags);
    else notes.push(`Codex has no mode ${join.mode}, so the user's default stays.`);
  }
  if (join.instructions) args.push("-c", `developer_instructions=${tomlString(join.instructions)}`);
  if (join.mcpServers?.length) {
    // One table for every server, so a name with a dot stays one key. -c splits a key path on dots.
    const servers = Object.fromEntries(join.mcpServers.map((server) => [serverName(server.name), serverConfig(server)]));
    args.push("-c", `mcp_servers=${tomlValue(servers)}`);
    const names = Object.keys(servers).join(", ");
    notes.push(`Codex merges each MCP server ${names} into a configured server of the same name, which keeps the keys the step's server does not set.`);
    if (join.mcpServers.some((server) => (server.type === "stdio" ? server.env : server.headers))) {
      notes.push("Codex takes these MCP servers only on its command line, so their env and headers show in the process list.");
    }
  }
  return { args, notes };
}

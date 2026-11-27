// The arguments that open a step's Claude Code session by hand, in the program's own view.
// Claude Code finds a session by the folder it starts in, so the caller starts it in join.cwd.

import type { Harness } from "../types.js";
import { EFFORTS, MODES, mcpConfig } from "./run.js";

type JoinStep = Parameters<Harness["joinArgs"]>[0];

export function claudeJoinArgs(join: JoinStep, write: (name: string, text: string) => string): { args: string[]; notes: string[] } {
  const args = ["--resume", join.sessionId];
  const notes: string[] = [];
  if (join.model) args.push("--model", join.model);
  if (join.effort) {
    if ((EFFORTS as string[]).includes(join.effort)) args.push("--effort", join.effort);
    else notes.push(`Claude Code has no effort ${join.effort}, so the model's default stays.`);
  }
  if (join.mode) {
    // The command line names the SDK's default mode manual.
    if ((MODES as string[]).includes(join.mode)) args.push("--permission-mode", join.mode === "default" ? "manual" : join.mode);
    else notes.push(`Claude Code has no permission mode ${join.mode}, so the user's default stays.`);
    if (join.mode === "bypassPermissions") args.push("--allow-dangerously-skip-permissions");
  }
  if (join.instructions) args.push("--append-system-prompt", join.instructions);
  if (join.mcpServers?.length) {
    // A file keeps the servers' env and headers out of the process list.
    const servers = Object.fromEntries(join.mcpServers.map((server) => [server.name, mcpConfig(server)]));
    args.push("--mcp-config", write("mcp.json", JSON.stringify({ mcpServers: servers }, null, 2)));
  }
  return { args, notes };
}

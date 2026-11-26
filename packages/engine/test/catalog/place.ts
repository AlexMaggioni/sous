// A sous home, a project, a global rulesync folder and a user's home folder, all in a new temp
// folder, so no catalog test reads a real ~/.claude, ~/.codex or ~/.agents.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { testHome } from "../../src/testing.js";

export interface CatalogPlace {
  paths: ReturnType<typeof testHome>["paths"];
  projectDir: string;
  /** The global rulesync folder, the one that holds .rulesync. */
  global: string;
  /** The user's home folder, as HOME names it. */
  user: string;
  env: Record<string, string>;
}

/** The place, with each workflow saved in the project as `<name>.js`. */
export function catalogPlace(workflows: Record<string, string> = {}): CatalogPlace {
  const { paths, projectDir } = testHome(workflows);
  const root = dirname(paths.home);
  const global = join(root, "aiglobal");
  const user = join(root, "user");
  mkdirSync(user, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder", rulesyncGlobal: global }));
  const env = { HOME: user, CLAUDE_CONFIG_DIR: join(user, ".claude"), CODEX_HOME: join(user, ".codex"), XDG_CONFIG_HOME: join(user, ".config") };
  return { paths, projectDir, global, user, env };
}

/** A workflow with one agent step that names an agent, a skill and an MCP server. */
export const reviewWorkflow = `export const meta = { name: "review", description: "reviews the change" }
const found = await agent("Review the change", { label: "check", agentType: "reviewer", skills: ["deploy"], mcp: ["linear"] })
await agent("Say it again", { agentType: "reviewer" })
return found
`;

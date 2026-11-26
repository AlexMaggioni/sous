// The skills sous sees from a project, found where Claude Code and Codex find them. Claude Code
// reads the project's .claude/skills and its own skills folder, Codex the project's .agents/skills
// and ~/.agents/skills. `sous skill install` links the sous skill into the two programs' own
// folders. rulesync's .rulesync/skills, the project's and the global one, are listed too, though
// neither program reads them: `rulesync generate` copies them into the programs' folders.

import { join } from "node:path";
import { createHarness, type HarnessId } from "@sous/harnesses";
import { HARNESSES, lookupAgents, lookupSettings, splitFrontmatter, type LookupSettings } from "../agents.js";
import { loadConfig, type HomePaths } from "../runs/home.js";
import { readText, skillFiles } from "./files.js";
import type { SkillPage, SkillRow } from "./types.js";
import { savedCalls, usedBy } from "./used-by.js";

type Env = Record<string, string | undefined>;

/** One SKILL.md, in one of the folders. */
interface SkillCopy {
  name: string;
  description?: string;
  harness: HarnessId | "rulesync";
  scope: "project" | "global";
  file: string;
  raw: string;
  body: string;
}

/** The skill folders in the order a skill's copies are listed: rulesync's, then the project's
 *  own folders, then the user's, the default harness first in each. The first copy is the one a
 *  page shows. */
function skillFolders(settings: LookupSettings): Array<Pick<SkillCopy, "harness" | "scope"> & { dir: string }> {
  const p = settings.projectDir;
  const order = [settings.defaultHarness, ...HARNESSES.filter((harness) => harness !== settings.defaultHarness)];
  const project: Record<HarnessId, string> = { claude: join(p, ".claude", "skills"), codex: join(p, ".agents", "skills") };
  return [
    { harness: "rulesync", scope: "project", dir: join(p, ".rulesync", "skills") },
    ...(settings.rulesyncGlobal ? [{ harness: "rulesync" as const, scope: "global" as const, dir: join(settings.rulesyncGlobal, ".rulesync", "skills") }] : []),
    ...order.map((harness) => ({ harness, scope: "project" as const, dir: project[harness] })),
    ...order.map((harness) => ({ harness, scope: "global" as const, dir: createHarness(harness).places(settings.env).skills })),
  ];
}

/** Every copy of every skill, by name, each name's copies in the folders' order. A skill is
 *  named by its frontmatter's name, else by its folder. */
function findSkills(settings: LookupSettings): Map<string, SkillCopy[]> {
  const skills = new Map<string, SkillCopy[]>();
  for (const { harness, scope, dir } of skillFolders(settings)) {
    for (const { folder, file } of skillFiles(dir)) {
      const raw = readText(file);
      if (raw === undefined) continue;
      const { data, body } = splitFrontmatter(raw, file, true);
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : folder;
      const description = typeof data.description === "string" && data.description.trim() ? data.description.trim() : undefined;
      const copy: SkillCopy = { name, ...(description ? { description } : {}), harness, scope, file, raw, body };
      skills.set(name, [...(skills.get(name) ?? []), copy]);
    }
  }
  return skills;
}

/** The harnesses that find one of the copies. */
const finders = (copies: SkillCopy[]): HarnessId[] => HARNESSES.filter((harness) => copies.some((copy) => copy.harness === harness));

const describe = (copies: SkillCopy[]) => {
  const description = copies.find((copy) => copy.description)?.description;
  return description ? { description } : {};
};

/** The skills seen from a project, by name. */
export function listSkills(paths: HomePaths, projectDir: string, env?: Env): SkillRow[] {
  const skills = findSkills(lookupSettings(paths, projectDir, loadConfig(paths), env));
  return [...skills.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, copies]) => ({ name, ...describe(copies), harnesses: finders(copies), file: copies[0]!.file }));
}

/** One skill's page: its first copy's text, every copy, the harnesses that miss it, and the
 *  agents and steps that list it. Undefined when no folder has the name. */
export function skillPage(paths: HomePaths, projectDir: string, name: string, env?: Env): SkillPage | undefined {
  const settings = lookupSettings(paths, projectDir, loadConfig(paths), env);
  const copies = findSkills(settings).get(name);
  if (!copies) return undefined;
  const first = copies[0]!;
  const found = finders(copies);
  return {
    name,
    ...describe(copies),
    body: first.body,
    raw: first.raw,
    file: first.file,
    copies: copies.map(({ harness, scope, file }) => ({ harness, scope, file })),
    missing: HARNESSES.filter((harness) => !found.includes(harness)),
    usedBy: usedBy(lookupAgents(settings), savedCalls(paths, projectDir), "skills", name),
  };
}

// The catalog's only reads of the disk: a file's text, and the skills in a skill folder. The rest
// of the catalog works on what these return.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A file's text, or undefined when it can't be read. */
export function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Each `<folder>/SKILL.md` under a skill folder, sorted by folder name. A link to a folder counts,
 *  as the sous skill is one. A hidden folder is left out. */
export function skillFiles(dir: string): Array<{ folder: string; file: string }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith(".") && existsSync(join(dir, name, "SKILL.md")))
    .sort()
    .map((folder) => ({ folder, file: join(dir, folder, "SKILL.md") }));
}

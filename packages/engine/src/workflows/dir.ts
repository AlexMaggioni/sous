/**
 * openWorkflowDir: a read-only view over folders of workflow scripts. Opening one reads nothing,
 * and each call reads the folders again, so a long-lived view sees a checkout or a save at once.
 * A folder that does not exist gives no workflows.
 *
 * The file's stem is the workflow's name (`review-pr.workflow.js` or `review-pr.js` give
 * "review-pr"). The first folder that has a name wins, and in one folder `.workflow.js` beats `.js`.
 *
 * `resolve(name)` is the manager's `loadSavedWorkflow` hook, which also gets inline nested
 * scripts. It returns undefined for anything that is not one plain name, which also keeps a
 * lookup inside the folders.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import { workflowDirs, type HomePaths } from "../runs/home.js";
import { Refusal } from "../runs/refusal.js";
import type { WorkflowMeta } from "../workflow-result.js";
import { workflowExtras, type WorkflowExtras } from "./meta.js";
import { parseWorkflowScript, readWorkflowScript, type ScriptRefs } from "./script.js";

/** One workflow file found by WorkflowDir.list(). */
export interface WorkflowDirEntry {
  /** The lookup name: the filename stem. */
  name: string;
  /** Absolute path of the file that wins for this name. */
  file: string;
  /** The parsed `export const meta` literal — undefined when the file doesn't parse. */
  meta?: WorkflowMeta;
  /** The meta's inputs, place, schedule, time limit and who may start it, checked. Set with meta. */
  extras?: WorkflowExtras;
  /** Parse error message when `meta` is undefined. */
  error?: string;
}

/** A read-only view over folders of workflow scripts that reads them again on each call. */
export interface WorkflowDir {
  /** The folders, absolute, the first winning. */
  dirs: string[];
  /** Every workflow file, the first per name winning, sorted by name. */
  list(): WorkflowDirEntry[];
  /** A workflow's script by name, or undefined when no file matches or the text is not one
   *  plain name, such as an inline script. It is the `loadSavedWorkflow` hook as it stands. */
  resolve(name: string): string | undefined;
}

/** Extension priority within a directory: more specific first. */
const WORKFLOW_FILE_EXTENSIONS = [".workflow.js", ".workflow.mjs", ".js", ".mjs"] as const;

/** A plausible workflow NAME (vs an inline script / a path): one flat path segment. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

function isPlausibleName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.includes("..") && name.length <= 128;
}

function stemOf(fileName: string): { stem: string; priority: number } | undefined {
  for (let i = 0; i < WORKFLOW_FILE_EXTENSIONS.length; i++) {
    const ext = WORKFLOW_FILE_EXTENSIONS[i];
    if (fileName.toLowerCase().endsWith(ext) && fileName.length > ext.length) {
      return { stem: fileName.slice(0, -ext.length), priority: i };
    }
  }
  return undefined;
}

/** Open a view over `dir`, or several folders with the first winning. It reads nothing yet. */
export function openWorkflowDir(dir: string | string[]): WorkflowDir {
  const dirs = (Array.isArray(dir) ? dir : [dir]).map((d) => resolvePath(d));
  if (dirs.length === 0) throw new Error("openWorkflowDir requires at least one directory");

  /** name -> winning file, honoring dir precedence then extension priority. */
  const scan = (): Map<string, string> => {
    const winners = new Map<string, { file: string; dirIndex: number; priority: number }>();
    for (let dirIndex = 0; dirIndex < dirs.length; dirIndex++) {
      let fileNames: string[];
      try {
        fileNames = readdirSync(dirs[dirIndex]);
      } catch {
        continue; // missing/unreadable dir contributes nothing
      }
      for (const fileName of fileNames) {
        if (fileName.startsWith(".")) continue;
        const parsed = stemOf(fileName);
        if (!parsed) continue;
        const file = join(dirs[dirIndex], fileName);
        try {
          if (!statSync(file).isFile()) continue; // follows symlinks; skips subdirs
        } catch {
          continue;
        }
        const existing = winners.get(parsed.stem);
        const loses =
          existing !== undefined &&
          (existing.dirIndex < dirIndex || (existing.dirIndex === dirIndex && existing.priority <= parsed.priority));
        if (!loses) winners.set(parsed.stem, { file, dirIndex, priority: parsed.priority });
      }
    }
    return new Map([...winners].map(([name, w]) => [name, w.file]));
  };

  const resolve = (name: string): string | undefined => {
    if (typeof name !== "string" || !isPlausibleName(name)) return undefined;
    for (const d of dirs) {
      for (const ext of WORKFLOW_FILE_EXTENSIONS) {
        const file = join(d, `${name}${ext}`);
        try {
          if (statSync(file).isFile()) return readFileSync(file, "utf8");
        } catch {
          /* try the next candidate */
        }
      }
    }
    return undefined;
  };

  return {
    dirs,
    resolve,
    list(): WorkflowDirEntry[] {
      const entries: WorkflowDirEntry[] = [];
      for (const [name, file] of scan()) {
        try {
          const { meta } = parseWorkflowScript(readFileSync(file, "utf8"));
          entries.push({ name, file, meta, extras: workflowExtras(meta) });
        } catch (error) {
          entries.push({ name, file, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

/** The workflows a project sees: those in its own folder, then those in the home folder. */
export function projectWorkflows(paths: HomePaths, projectDir: string): WorkflowDir {
  return openWorkflowDir(workflowDirs(projectDir, paths));
}

/** A saved workflow, read once: its meta as written, the meta checked, and the names it uses. */
export interface ResolvedWorkflow {
  name: string;
  file: string;
  script: string;
  meta: WorkflowMeta;
  extras: WorkflowExtras;
  refs: ScriptRefs;
}

/** A saved workflow by name (project first, then home), or a script file by path. */
export function resolveWorkflow(paths: HomePaths, projectDir: string, nameOrPath: string): ResolvedWorkflow {
  let file: string | undefined;
  const asPath = isAbsolute(nameOrPath) ? nameOrPath : resolvePath(process.cwd(), nameOrPath);
  if ((nameOrPath.includes("/") || nameOrPath.endsWith(".js") || nameOrPath.endsWith(".mjs")) && existsSync(asPath)) {
    file = asPath;
  } else {
    const view = projectWorkflows(paths, projectDir);
    const entries = view.list();
    const entry = entries.find((candidate) => candidate.name === nameOrPath);
    if (!entry) {
      const names = entries.map((candidate) => candidate.name);
      throw new Refusal(
        "no_such_workflow",
        `no workflow "${nameOrPath}". Looked in ${view.dirs.join(" and ")}.${names.length ? ` Saved workflows: ${names.join(", ")}.` : ""}`,
        "Give the name of a saved workflow, or the path of a workflow file.",
        "sous workflows --json",
      );
    }
    if (entry.error) {
      throw new Refusal("workflow_invalid", `${entry.file} does not parse: ${entry.error}`, `Fix the workflow file ${entry.file}.`, `sous check ${entry.name} --json`);
    }
    file = entry.file;
  }
  const script = readFileSync(file, "utf8");
  const { meta, refs } = readWorkflowScript(script);
  const name = basename(file).replace(/(\.workflow)?\.m?js$/, "");
  return { name, file, script, meta, extras: workflowExtras(meta), refs };
}

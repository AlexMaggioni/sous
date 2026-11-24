// The person's yes to a workflow's exact text. <home>/approvals.json maps each absolute workflow
// file to its last 20 approvals, the newest last, and a text is approved when its hash is among
// them. Each approval also keeps the text as <home>/approved/<hash>.json, {text}, so a diff has
// the approved text to compare.
//
// At first use, when approvals.json is absent, every workflow of every known project and of the
// home is approved as it is, by sous, seeded. Each function here seeds first.
//
// approval-check.ts holds the check of a start, which reads these.

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readJsonFile, readStrictJsonFile, writeJsonFileInDir } from "../json-file.js";
import { openWorkflowDir } from "../workflows/dir.js";
import type { Through, Who } from "./actions.js";
import { knownProjects, type HomePaths } from "./home.js";

export interface Approval {
  hash: string;
  by: Who["by"];
  through?: Through;
  at: string;
  /** Set on the approvals of the first use. */
  seeded?: true;
}

type Approvals = Record<string, Approval[]>;

/** The approvals a file keeps. */
const KEPT = 20;

/** The sha256 of a workflow's text, in hex. */
export function workflowHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The approvals file, or undefined when it is absent. One that does not parse throws, so a
 *  broken file is never seeded over. */
const readApprovals = (paths: HomePaths) => readStrictJsonFile<Approvals | undefined>(paths.approvals, undefined);

function saveText(paths: HomePaths, hash: string, text: string): void {
  writeJsonFileInDir(join(paths.approved, `${hash}.json`), { text });
}

/** The folders the seed approves: each known project's, each folder a schedule names, and the home's. */
function seedFolders(paths: HomePaths): string[] {
  const scheduled = (readJsonFile<Array<{ projectDir?: unknown }>>(paths.schedules) ?? [])
    .map((schedule) => schedule?.projectDir)
    .filter((dir): dir is string => typeof dir === "string");
  const projects = [...new Set([...knownProjects(paths), ...scheduled].map((dir) => resolve(dir)))];
  return [...projects.map((dir) => join(dir, ".sous", "workflows")), paths.workflows];
}

/** At first use, approve every workflow sous knows as it is now. With approvals.json there, it does nothing. */
export function seedApprovals(paths: HomePaths): void {
  if (readApprovals(paths) !== undefined) return;
  const at = new Date().toISOString();
  const approvals: Approvals = {};
  for (const folder of seedFolders(paths)) {
    const dir = openWorkflowDir(folder);
    for (const entry of dir.list()) {
      const text = dir.resolve(entry.name);
      if (text === undefined || approvals[entry.file]) continue;
      const hash = workflowHash(text);
      approvals[entry.file] = [{ hash, by: "sous", at, seeded: true }];
      saveText(paths, hash, text);
    }
  }
  writeJsonFileInDir(paths.approvals, approvals);
}

/** Whether the person approved this text of this file, among its kept approvals. */
export function isApproved(paths: HomePaths, file: string, text: string): boolean {
  seedApprovals(paths);
  const hash = workflowHash(text);
  return (readApprovals(paths)?.[resolve(file)] ?? []).some((approval) => approval.hash === hash);
}

/** Record a yes to this text of this file and keep the text. A text already the newest yes is
 *  left as it is. An older one moves to the end. Returns the approval that holds. */
export function approveWorkflow(paths: HomePaths, file: string, text: string, who: Who): Approval {
  seedApprovals(paths);
  const key = resolve(file);
  const approvals = readApprovals(paths) ?? {};
  const hash = workflowHash(text);
  const list = approvals[key] ?? [];
  const newest = list.at(-1);
  if (newest?.hash === hash) return newest;
  const approval: Approval = { hash, by: who.by, through: who.through, at: new Date().toISOString() };
  approvals[key] = [...list.filter((kept) => kept.hash !== hash), approval].slice(-KEPT);
  saveText(paths, hash, text);
  writeJsonFileInDir(paths.approvals, approvals);
  return approval;
}


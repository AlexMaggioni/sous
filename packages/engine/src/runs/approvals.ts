// The person's yes to a workflow's exact text. <home>/approvals.json maps each absolute workflow
// file to its last 20 approvals, the newest last, and a text is approved when its hash is among
// them. Each approval also keeps the text as <home>/approved/<hash>.json, {text}, so a diff has
// the approved text to compare.
//
// At first use, every workflow of every known project and of the home is approved as it is, by
// sous, seeded. The first command of a sous with approvals seeds, and so does the service at its
// start. Each function here seeds first too. <home>/seeded.json marks the seed done, so a missing
// approvals.json after it means no approvals, and a moved or deleted file approves nothing.
//
// approval-check.ts holds the check of a start, which reads these.

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readJsonFile, readStrictJsonFile, writeJsonFileInDir } from "../json-file.js";
import { openWorkflowDir, workflowText } from "../workflows/dir.js";
import type { Through, Who } from "./actions.js";
import { knownProjects, type HomePaths } from "./home.js";
import { Refusal } from "./refusal.js";

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

/** The approvals file, or undefined when it is absent. One that does not parse is refused as
 *  broken_record, and sous starts nothing that needs a yes until the person fixes it. */
function readApprovals(paths: HomePaths): Approvals | undefined {
  try {
    return readStrictJsonFile<Approvals | undefined>(paths.approvals, undefined);
  } catch (error) {
    const message = `${paths.approvals}, where sous keeps the person's yes to each workflow, does not parse: ${(error as Error).message}. Until it does, sous starts no workflow that needs the person's yes.`;
    const change = "Tell the person. They fix the file or put back a copy of it. Do not delete or move it: without it, no workflow counts as approved.";
    throw new Refusal("broken_record", message, change, null);
  }
}

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

/** At first use, approve every workflow sous knows as it is now, and mark the seed done. Once
 *  marked, it does nothing. A home with approvals.json and no mark, from before the mark, gets
 *  the mark only. */
export function seedApprovals(paths: HomePaths): void {
  if (readJsonFile(paths.seeded) !== undefined) return;
  const at = new Date().toISOString();
  if (readApprovals(paths) === undefined) {
    const approvals: Approvals = {};
    for (const folder of seedFolders(paths)) {
      for (const entry of openWorkflowDir(folder).list()) {
        const text = workflowText(entry.file);
        if (text === undefined || approvals[entry.file]) continue;
        const hash = workflowHash(text);
        approvals[entry.file] = [{ hash, by: "sous", at, seeded: true }];
        saveText(paths, hash, text);
      }
    }
    writeJsonFileInDir(paths.approvals, approvals);
  }
  writeJsonFileInDir(paths.seeded, { approvalsAt: at });
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


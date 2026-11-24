// `sous workflows show`: what an agent needs to know of a workflow before it runs or changes it.
// The outline gives its steps as the file writes them, the check's problems, the person's yes and
// its last runs. The diff gives what changed since that yes. Both only read.

import { dirname, resolve } from "node:path";
import type { Who } from "../runs/actions.js";
import { approvalName } from "../runs/approval-check.js";
import { approvalFor, approvedText, type Approval } from "../runs/approvals.js";
import type { HomePaths } from "../runs/home.js";
import { listRecords } from "../runs/records.js";
import { runDetail, shortRun } from "../runs/run.js";
import { checkWorkflow } from "./check.js";
import { lineDiff } from "./diff.js";
import { projectWorkflows, resolveWorkflow, type ResolvedWorkflow } from "./dir.js";
import type { InputSpec } from "./meta.js";
import type { ScriptCall } from "./script.js";

/** One step as the file writes it. `step` is its literal label. */
export interface OutlineStep {
  step?: string;
  kind: ScriptCall["kind"];
  /** The question of an ask, the title of a breakpoint. */
  title?: string;
  agent?: string;
  model?: string;
  keepsSession?: boolean;
  /** The saved workflow a workflow() step starts. */
  workflow?: string;
}

/** The person's yes that speaks for the file: the one of its text, else the newest. */
export interface OutlineApproval {
  by: Who["by"];
  at: string;
  /** True when the text is not the one approved, so an agent's run of it is refused. */
  changedSince: boolean;
  /** The yes sous gave every workflow it knew at its first use. */
  seeded?: true;
}

export interface WorkflowOutline {
  name: string;
  file: string;
  from: "project" | "home" | "path";
  description?: string;
  inputs: Record<string, InputSpec>;
  place?: string;
  startedBy: "anyone" | "people";
  steps: OutlineStep[];
  asks: number;
  workflows: string[];
  check: { problems: string[]; notes: string[] };
  approved: OutlineApproval | null;
  lastRuns: Array<{ runId: string; status: string; seconds: number; tokens: number }>;
}

/** What the calls about a workflow name it by: its name, or its file when that name finds another file. */
export interface Target {
  target: string;
}

/** The runs of a file the outline lists. */
const LAST_RUNS = 3;

/** Where the workflow comes from: a path given, the home's folder, or the project's. */
function fromOf(paths: HomePaths, nameOrPath: string, resolved: ResolvedWorkflow): WorkflowOutline["from"] {
  if (nameOrPath !== resolved.name) return "path";
  return dirname(resolved.file) === resolve(paths.workflows) ? "home" : "project";
}

function approvalView(found: { approval: Approval; changedSince: boolean } | null): OutlineApproval | null {
  if (!found) return null;
  const { approval, changedSince } = found;
  return { by: approval.by, at: approval.at, changedSince, ...(approval.seeded ? { seeded: true as const } : {}) };
}

function stepOf(call: ScriptCall): OutlineStep {
  const { kind, label, ...rest } = call;
  return { ...(label === undefined ? {} : { step: label }), kind, ...rest };
}

/** The last runs of a file, newest first. A dry run of `sous check` ran stand-in agents, so it is left out. */
function lastRuns(paths: HomePaths, file: string, now: Date): WorkflowOutline["lastRuns"] {
  const runs: WorkflowOutline["lastRuns"] = [];
  for (const record of listRecords(paths)) {
    if (runs.length === LAST_RUNS) break;
    if (record.file !== file || record.origin === "check") continue;
    try {
      const short = shortRun(runDetail(paths, record.runId), now);
      runs.push({ runId: short.runId, status: short.status, seconds: short.seconds ?? 0, tokens: short.tokens });
    } catch {
      // A run whose record went away while sous read it is not listed.
    }
  }
  return runs;
}

/** The target of the calls about this workflow, as the not_approved refusal names it. */
function targetOf(paths: HomePaths, projectDir: string, resolved: ResolvedWorkflow): string {
  return approvalName(projectWorkflows(paths, projectDir).list(), resolved);
}

/** The outline of a saved workflow, by name, or of a workflow file, by path. It writes nothing. */
export function workflowOutline(paths: HomePaths, projectDir: string, nameOrPath: string, now = new Date()): WorkflowOutline & Target {
  const resolved = resolveWorkflow(paths, projectDir, nameOrPath);
  const { extras, refs } = resolved;
  const { problems, notes } = checkWorkflow(paths, projectDir, nameOrPath);
  return {
    name: resolved.name,
    file: resolved.file,
    from: fromOf(paths, nameOrPath, resolved),
    ...(extras.description === undefined ? {} : { description: extras.description }),
    inputs: extras.inputs,
    ...(extras.place === undefined ? {} : { place: extras.place }),
    startedBy: extras.startedBy,
    steps: refs.calls.map(stepOf),
    asks: refs.asks,
    workflows: refs.workflows,
    check: { problems, notes },
    approved: approvalView(approvalFor(paths, resolved.file, resolved.script)),
    lastRuns: lastRuns(paths, resolved.file, now),
    target: targetOf(paths, projectDir, resolved),
  };
}

export interface WorkflowDiff {
  name: string;
  file: string;
  approved: OutlineApproval | null;
  /** Every line of the file against the approved text, from lineDiff. A new file is all "+ " lines. */
  diff: string[];
  /** True when the approved text's copy is gone, so the diff shows the file as new. */
  approvedTextGone?: true;
}

/** What changed in a workflow since the person's yes that speaks for it. It writes nothing. */
export function workflowDiff(paths: HomePaths, projectDir: string, nameOrPath: string): WorkflowDiff & Target {
  const resolved = resolveWorkflow(paths, projectDir, nameOrPath);
  const found = approvalFor(paths, resolved.file, resolved.script);
  const before = found ? (found.changedSince ? approvedText(paths, found.approval.hash) : resolved.script) : "";
  return {
    name: resolved.name,
    file: resolved.file,
    approved: approvalView(found),
    diff: lineDiff(before ?? "", resolved.script),
    ...(before === undefined ? { approvedTextGone: true as const } : {}),
    target: targetOf(paths, projectDir, resolved),
  };
}

// The saved workflows as the page reads them: the list, one workflow whole with its graph, and
// what changed since the person's yes. Each maps the engine's reads to the contract's shape.

import { dirname, resolve } from "node:path";
import {
  checkWorkflow,
  isRequired,
  listRecords,
  listRuns,
  projectWorkflows,
  Refusal,
  resolveWorkflow,
  workflowDiff,
  workflowFlow,
  workflowOutline,
  type HomePaths,
  type InputSpec,
  type RunRecord,
} from "@sous-run/engine";
import type { Input, WorkflowDiff, WorkflowPage, WorkflowRow } from "@sous-run/view";
import { runRow, statusOf } from "./runs.js";

/** The most lines a diff gives, and the matching lines it keeps around each change once it is
 *  longer than that. */
const DIFF_LINES = 200;
const CONTEXT = 3;
/** The runs a workflow's page lists. */
const LAST_RUNS = 10;

/** Every saved workflow of the project and the home, the project's first, with its check, its
 *  yes and its last run. A file that does not parse has one problem. */
export function workflowRows(paths: HomePaths, projectDir: string): WorkflowRow[] {
  const entries = projectWorkflows(paths, projectDir).list();
  const files = new Set(entries.map((entry) => entry.file));
  // The newest run of each file. Only those runs' states are read.
  const newest = new Map<string, RunRecord>();
  for (const record of listRecords(paths)) if (record.origin !== "check" && files.has(record.file) && !newest.has(record.file)) newest.set(record.file, record);
  const runs = new Map(listRuns(paths, { records: [...newest.values()] }).map((run) => [run.record.file, run]));
  return entries.map((entry) => {
    const run = runs.get(entry.file);
    const row: WorkflowRow = {
      name: entry.name,
      file: entry.file,
      from: dirname(entry.file) === resolve(paths.workflows) ? "home" : "project",
      ...(entry.extras?.description ? { description: entry.extras.description } : {}),
      changed: true,
      problems: 1,
      startedBy: entry.extras?.startedBy ?? "anyone",
      ...(run ? { lastRun: { id: run.record.runId, status: statusOf(run), startedAt: run.record.createdAt } } : {}),
    };
    if (entry.error) return row;
    try {
      const { approved } = workflowDiff(paths, projectDir, entry.name);
      const { problems } = checkWorkflow(paths, projectDir, entry.name);
      return { ...row, changed: !approved || approved.changedSince, problems: problems.length };
    } catch (error) {
      if (error instanceof Refusal) return row;
      throw error;
    }
  });
}

/** An input as the start form shows it. */
function inputOf(name: string, spec: InputSpec): Input {
  return {
    name,
    type: spec.type ?? "string",
    ...(spec.description ? { description: spec.description } : {}),
    required: isRequired(spec),
    ...(spec.default === undefined ? {} : { default: spec.default }),
    ...(spec.choices ? { choices: spec.choices.map(String) } : {}),
  };
}

/** One saved workflow whole: its meta, its check, its yes, its last runs, the workflows it starts
 *  and those that start it, its text and its graph. */
export function workflowPage(paths: HomePaths, projectDir: string, name: string): WorkflowPage {
  const outline = workflowOutline(paths, projectDir, name);
  const resolved = resolveWorkflow(paths, projectDir, name);
  const { extras, refs, script } = resolved;
  const records = listRecords(paths).filter((record) => record.file === resolved.file && record.origin !== "check").slice(0, LAST_RUNS);
  const lastRuns = listRuns(paths, { records }).map((run) => {
    const { id, status, startedAt, durationMs, tokens } = runRow(run);
    return { id, status, startedAt, ...(durationMs === undefined ? {} : { durationMs }), tokens };
  });
  const usedBy = projectWorkflows(paths, projectDir)
    .list()
    .filter((entry) => entry.name !== resolved.name && !entry.error)
    .filter((entry) => {
      try {
        return resolveWorkflow(paths, projectDir, entry.name).refs.workflows.includes(resolved.name);
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name);
  return {
    name: outline.name,
    file: outline.file,
    from: outline.from,
    ...(outline.description === undefined ? {} : { description: outline.description }),
    inputs: Object.entries(outline.inputs).map(([input, spec]) => inputOf(input, spec)),
    ...(outline.place === undefined ? {} : { place: outline.place }),
    startedBy: outline.startedBy,
    ...(extras.schedule ? { schedule: extras.schedule } : {}),
    ...(extras.timeout ? { timeout: extras.timeout } : {}),
    approved: outline.approved,
    problems: outline.check.problems,
    notes: outline.check.notes,
    lastRuns,
    calls: refs.workflows,
    usedBy,
    waitsOn: outline.waitsOn,
    source: script,
    flow: workflowFlow(script),
  };
}

/** The lines within CONTEXT of a change. */
function aroundChanges(lines: WorkflowDiff["lines"]): WorkflowDiff["lines"] {
  const near = new Set<number>();
  lines.forEach((line, i) => {
    if (line.op === " ") return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) near.add(j);
  });
  return lines.filter((_, i) => near.has(i));
}

/** What changed since the person's yes: the whole file when it fits, else the lines around each
 *  change, cut at 200 lines. A file with no yes is all new. */
export function workflowDiffOf(paths: HomePaths, projectDir: string, name: string): WorkflowDiff {
  const found = workflowDiff(paths, projectDir, name);
  const all = found.diff.map((line) => ({ op: line.startsWith("+ ") ? ("+" as const) : line.startsWith("- ") ? ("-" as const) : (" " as const), text: line.slice(2) }));
  const kept = all.length > DIFF_LINES ? aroundChanges(all) : all;
  return { isNew: found.approved === null, lines: kept.slice(0, DIFF_LINES), ...(kept.length > DIFF_LINES ? { cut: true as const } : {}) };
}

import { randomUUID } from "node:crypto";
import type { ResumeRow } from "../../src/resume-rows.js";
import type { JournalEntry, WorkflowRunOptions } from "../../src/workflow.js";

/**
 * The options that resume a run from its journal. Each entry becomes a result row of the run's
 * own scope, and a call pairs with the rows by occurrence, as a resume from saved call rows does.
 * The rows belong to one run id, so the helper sets it too.
 */
export function journalResume(
  journal: Iterable<JournalEntry> | ReadonlyMap<number, JournalEntry>,
  runId = `run-${randomUUID()}`,
): Pick<WorkflowRunOptions, "runId" | "resume"> {
  const entries = journal instanceof Map
    ? [...(journal as ReadonlyMap<number, JournalEntry>).values()]
    : [...journal as Iterable<JournalEntry>];
  const rows: ResumeRow[] = entries
    .sort((left, right) => left.index - right.index)
    .map((entry) => ({
      index: entry.index,
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
      hash: entry.hash,
      outcome: "result",
      sourceRunId: runId,
      entry,
      own: true,
    }));
  return { runId, resume: { rows: new Map([[runId, { rows, key: "hash" }]]) } };
}

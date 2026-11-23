import { randomUUID } from "node:crypto";
import { journalRows } from "../../src/resume-rows.js";
import type { JournalEntry, WorkflowRunOptions } from "../../src/workflow.js";

/**
 * The options that resume a run from a journal with no call rows. A call replays the row at its
 * own index when the hashes agree. The rows belong to one run id, so the helper sets it too.
 */
export function journalResume(
  journal: Iterable<JournalEntry> | ReadonlyMap<number, JournalEntry>,
  runId = `run-${randomUUID()}`,
): Pick<WorkflowRunOptions, "runId" | "resume"> {
  const byIndex = journal instanceof Map
    ? journal as ReadonlyMap<number, JournalEntry>
    : new Map([...journal as Iterable<JournalEntry>].map((entry) => [entry.index, entry] as const));
  return { runId, resume: { rows: journalRows(runId, byIndex) } };
}

// Journal rows and call rows for tests of the rows a run saves and a resume pairs with.

import { WorkflowErrorCode } from "../../src/errors.js";
import type { JournalEntry, WorkflowCallRecord } from "../../src/workflow-result.js";

/** The scope of a row, unless a test names one. */
export const RUN = "run";

/** A journal row. A null scope gives a row with none, as an old journal saved it. */
export function entry(index: number, hash: string, scope: string | null = RUN): JournalEntry {
  return { index, hash, result: `${hash} done`, kind: "agent", ...(scope === null ? {} : { scope }) };
}

/** A call row with inputs hash `<hash>-in`. */
export function call(index: number, hash: string, outcome: WorkflowCallRecord["outcome"], scope = RUN): WorkflowCallRecord {
  return { index, kind: "agent", hash, inputsHash: `${hash}-in`, outcome, origin: "runner", scope };
}

/** A hash of one repeated hex digit, so the seed checks take it. */
export const H = (digit: string) => digit.repeat(64);

/** A call row a seed can hold: with a path and an inputs hash. */
export function full(index: number, digit: string, outcome: WorkflowCallRecord["outcome"], scope = RUN): WorkflowCallRecord {
  const base = {
    index, kind: "agent", hash: H(digit), path: `step-${digit}`, inputsHash: H(digit).slice(0, 63) + "0",
    origin: "runner", scope,
  } as const;
  return outcome === "result" ? { ...base, outcome } : { ...base, outcome, error: { form: "workflow-error", message: "stopped", code: WorkflowErrorCode.AGENT_EXECUTION_ERROR } };
}

/** A journal row a seed can hold. */
export function fullEntry(index: number, digit: string, scope = RUN): JournalEntry {
  return { index, hash: H(digit), result: `${digit} done`, kind: "agent", scope };
}

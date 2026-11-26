// The Runs home's summary: each workflow that ran in the last 7 days, with its recent outcomes,
// how often it ran, and what it spent. Pure, so the tests read it without a page.
import type { RunRow, Status } from "../api/contract.ts";

const WEEK = 7 * 24 * 60 * 60 * 1000;
/** How many outcomes a row shows, newest last. */
const RECENT = 8;

export interface WorkflowWeek {
  workflow: string;
  runs: number;
  /** The last outcomes, oldest first, at most RECENT. */
  recent: { id: string; status: Status }[];
  tokens: number;
  /** Unset when no run of it reported a cost. */
  cost?: number;
  lastAt: string;
}

/** The workflows that ran since a week before `now`, the latest first. */
export function workflowWeek(runs: readonly RunRow[], now: number): WorkflowWeek[] {
  const byName = new Map<string, RunRow[]>();
  for (const run of runs) {
    if (now - Date.parse(run.startedAt) > WEEK) continue;
    byName.set(run.workflow, [...(byName.get(run.workflow) ?? []), run]);
  }
  return [...byName]
    .map(([workflow, list]) => {
      const sorted = [...list].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
      const costs = sorted.flatMap((run) => (run.cost === undefined ? [] : [run.cost]));
      return {
        workflow,
        runs: sorted.length,
        recent: sorted.slice(-RECENT).map(({ id, status }) => ({ id, status })),
        tokens: sorted.reduce((sum, run) => sum + run.tokens, 0),
        ...(costs.length ? { cost: costs.reduce((sum, cost) => sum + cost, 0) } : {}),
        lastAt: sorted[sorted.length - 1]!.startedAt,
      };
    })
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

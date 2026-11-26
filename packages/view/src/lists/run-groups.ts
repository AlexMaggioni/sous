import type { RunRow } from "../api/contract.ts";
import { isEnded } from "../status.ts";
import { matches } from "./filter.ts";

// How the runs list orders its rows: by status, with what needs the person first, or by project,
// with the runs that need the person first in each project. Newest first everywhere else.

export type GroupBy = "status" | "project";

/** One headed group of a list in the list column. */
export type ListGroup<T> = {
  /** Unique in the list, such as "needs" or "p:/Users/me/shop". */
  key: string;
  label: string;
  /** The "Needs you" group, whose heading is copper. */
  needs?: boolean;
  items: T[];
};

/** The run waits on the person: a question, an approval or a breakpoint. */
export const needsPerson = (run: RunRow): boolean => run.status === "needs" || run.waiting > 0;

/** The run ended, so it can leave the list. A paused run may still resume, so it stays. */
export const hasEnded = (run: RunRow): boolean => run.endedAt !== undefined || isEnded(run.status);

const STATUS_GROUPS = ["needs", "failed", "running", "queued", "paused", "done"] as const;
type StatusGroup = (typeof STATUS_GROUPS)[number];
const STATUS_LABEL: Record<StatusGroup, string> = { needs: "Needs you", failed: "Failed", running: "Running", queued: "Queued", paused: "Paused", done: "Done" };

function statusGroupOf(run: RunRow): StatusGroup {
  if (needsPerson(run)) return "needs";
  if (run.status === "failed" || run.status === "running" || run.status === "queued" || run.status === "paused") return run.status;
  return "done";
}

const time = (at: string | undefined): number => {
  const t = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
};
const newestFirst = (a: RunRow, b: RunRow) => time(b.startedAt) - time(a.startedAt) || a.id.localeCompare(b.id);
const needsFirst = (a: RunRow, b: RunRow) => Number(needsPerson(b)) - Number(needsPerson(a)) || newestFirst(a, b);

function bucket<K>(runs: readonly RunRow[], keyOf: (run: RunRow) => K): Map<K, RunRow[]> {
  const out = new Map<K, RunRow[]>();
  for (const run of runs) {
    const key = keyOf(run);
    const list = out.get(key);
    if (list) list.push(run);
    else out.set(key, [run]);
  }
  return out;
}

/**
 * The groups of the runs list, empty groups left out. By status: Needs you, Failed, Running,
 * Queued, Paused, then Done, which holds stopped runs too. By project: the projects with a run
 * that needs the person first, then the one with the newest run. Two projects with one name show
 * their folders.
 */
export function groupRuns(runs: readonly RunRow[], by: GroupBy): ListGroup<RunRow>[] {
  if (by === "status") {
    const buckets = bucket(runs, statusGroupOf);
    return STATUS_GROUPS.flatMap((key) => {
      const list = buckets.get(key);
      return list ? [{ key, label: STATUS_LABEL[key], needs: key === "needs", items: list.sort(newestFirst) }] : [];
    });
  }
  const groups = [...bucket(runs, (run) => run.project.dir).values()].map((list) => ({
    project: list[0].project,
    runs: list.sort(needsFirst),
    waits: list.some(needsPerson),
    latest: Math.max(...list.map((run) => time(run.startedAt))),
  }));
  const named = new Map<string, number>();
  for (const g of groups) named.set(g.project.name, (named.get(g.project.name) ?? 0) + 1);
  return groups
    .sort((a, b) => Number(b.waits) - Number(a.waits) || b.latest - a.latest || a.project.name.localeCompare(b.project.name))
    .map((g) => ({ key: `p:${g.project.dir}`, label: (named.get(g.project.name) ?? 0) > 1 ? g.project.dir : g.project.name, items: g.runs }));
}

/**
 * The runs the list shows: the ones the person did not just remove, in the picked project, that
 * match the search. The search looks at the title, workflow, project, id and status words.
 */
export function pickRuns(runs: readonly RunRow[], { query = "", project = "", hidden }: { query?: string; project?: string; hidden?: ReadonlySet<string> }): RunRow[] {
  return runs.filter(
    (run) => !hidden?.has(run.id) && (!project || run.project.dir === project) && matches([run.title, run.workflow, run.project.name, run.id, run.statusText], query),
  );
}

/** The workflow, muted after the title, when it says something the title does not. */
export function runMeta(run: RunRow, { withProject }: { withProject: boolean }): string {
  const parts = run.workflow === run.title ? [] : [run.workflow];
  if (withProject) parts.push(run.project.name);
  return parts.join(", ");
}

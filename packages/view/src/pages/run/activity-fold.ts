// How a step's activity reads: five or more tool calls in a row fold into one line that names
// them, such as "7 tool calls: Read 4, Bash 3". Pure, so the tests check it without a page.
import type { Activity } from "../../api/contract.ts";
import { plural } from "../../format.ts";

/** One line of the activity, or a run of tool calls folded into one. */
export type ActivityItem = { t: "line"; line: Activity } | { t: "tools"; lines: Activity[]; calls: number; summary: string };

/** A run this long or longer folds. */
const FOLD_AT = 5;

const isTool = (line: Activity) => line.kind === "tool" || line.kind === "tool-result";

/** "Read 4, Bash 3", by count, then by first use. */
function toolCounts(lines: Activity[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) if (line.kind === "tool") counts.set(line.tool ?? "tool", (counts.get(line.tool ?? "tool") ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${n}`)
    .join(", ");
}

/**
 * The lines to show, oldest first, without the prompt, which has its own part. A tool call and
 * its result count as one call. The last run of a live step stays open, so new calls show as
 * they come.
 */
export function foldActivity(activity: readonly Activity[], live: boolean): ActivityItem[] {
  const lines = activity.filter((line) => line.kind !== "prompt");
  const out: ActivityItem[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && isTool(lines[j]!)) j++;
    if (j === i) {
      out.push({ t: "line", line: lines[i]! });
      i++;
      continue;
    }
    const run = lines.slice(i, j);
    const calls = run.filter((line) => line.kind === "tool").length;
    const tail = j === lines.length && live;
    if (calls >= FOLD_AT && !tail) out.push({ t: "tools", lines: run, calls, summary: `${plural(calls, "tool call")}: ${toolCounts(run)}` });
    else for (const line of run) out.push({ t: "line", line });
    i = j;
  }
  return out;
}

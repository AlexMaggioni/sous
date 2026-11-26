import { describe, expect, test } from "vitest";
import type { RunRow, Status } from "../src/api/contract.ts";
import { workflowWeek } from "../src/pages/runs-week.ts";

/** How many outcomes a row shows. */
const RECENT = 8;

const NOW = Date.parse("2026-11-25T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

let n = 0;
const run = (workflow: string, h: number, status: Status = "done", more: Partial<RunRow> = {}): RunRow => ({
  id: `r${++n}`,
  workflow,
  title: workflow,
  project: { dir: "/p", name: "p" },
  status,
  statusText: status,
  startedAt: hoursAgo(h),
  tokens: 0,
  waiting: 0,
  origin: "cli",
  ...more,
});

describe("this week's workflows", () => {
  test("each workflow that ran in 7 days, the latest first, with its runs and spend", () => {
    const rows = workflowWeek(
      [run("build", 30, "done", { tokens: 1200, cost: 0.02 }), run("build", 2, "failed", { tokens: 300 }), run("lint", 5), run("old", 24 * 8)],
      NOW,
    );
    expect(rows.map((row) => [row.workflow, row.runs, row.tokens, row.cost, row.lastAt])).toEqual([
      ["build", 2, 1500, 0.02, hoursAgo(2)],
      ["lint", 1, 0, undefined, hoursAgo(5)],
    ]);
    expect(rows[0]!.recent.map((r) => r.status)).toEqual(["done", "failed"]);
  });

  test("shows only the last outcomes, oldest first", () => {
    const many = Array.from({ length: RECENT + 3 }, (_, i) => run("loop", RECENT + 3 - i, i === RECENT + 2 ? "failed" : "done"));
    const [row] = workflowWeek(many, NOW);
    expect(row!.runs).toBe(RECENT + 3);
    expect(row!.recent).toHaveLength(RECENT);
    expect(row!.recent.at(-1)!.status).toBe("failed");
  });
});

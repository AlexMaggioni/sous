// The one sentence under a catalog home's title that counts what it holds, and the words its
// table uses for where each item runs. Pure, so the tests read them without a page.
import type { AgentRow, Harness, McpRow, SkillRow, WorkflowRow } from "../api/contract.ts";
import { plural } from "../format.ts";
import { HARNESS_NAME } from "../lists/catalog-rows.ts";

/** "1 Claude Code only" style counts, leaving out the zeros, joined with commas. */
const parts = (counts: Array<[number, string]>) =>
  counts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(", ");

/** "Both", or the one harness's name, for a list of the harnesses that see an item. */
export function harnesses(list: readonly Harness[]): string {
  if (list.length > 1) return "Both";
  return list[0] ? HARNESS_NAME[list[0]] : "Neither";
}

export function workflowsSummary(rows: readonly WorkflowRow[], project: string): string {
  const own = rows.filter((w) => w.from === "project").length;
  const home = rows.length - own;
  // "all in shop" reads better than "8 in shop" when nothing lives elsewhere.
  const where = own === 0 || home === 0 ? `all in ${home ? "your home" : project}` : parts([[own, `in ${project}`], [home, "in your home"]]);
  const people = rows.filter((w) => w.startedBy === "people").length;
  return `${plural(rows.length, "saved workflow")}: ${where}.${people ? ` ${people === 1 ? "1 only people can start" : `${people} only people can start`}.` : ""}`;
}

export function agentsSummary(rows: readonly AgentRow[]): string {
  const split = parts([
    [rows.filter((a) => !a.only).length, "for both harnesses"],
    [rows.filter((a) => a.only === "claude").length, "for Claude Code only"],
    [rows.filter((a) => a.only === "codex").length, "for Codex only"],
  ]);
  return `${plural(rows.length, "agent")}: ${split}.`;
}

export function skillsSummary(rows: readonly SkillRow[]): string {
  const split = parts([
    [rows.filter((s) => s.harnesses.length > 1).length, "found by both harnesses"],
    [rows.filter((s) => s.harnesses.length === 1 && s.harnesses[0] === "claude").length, "found by Claude Code only"],
    [rows.filter((s) => s.harnesses.length === 1 && s.harnesses[0] === "codex").length, "found by Codex only"],
  ]);
  return `${plural(rows.length, "skill")}: ${split}.`;
}

export function mcpSummary(rows: readonly McpRow[]): string {
  const split = parts([
    [rows.filter((m) => m.type === "stdio").length, "local over stdio"],
    [rows.filter((m) => m.type !== "stdio").length, "remote over http or sse"],
  ]);
  return `${plural(rows.length, "MCP server")}: ${split}.`;
}

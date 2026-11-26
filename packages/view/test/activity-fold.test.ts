import { describe, expect, test } from "vitest";
import type { Activity } from "../src/api/contract.ts";
import { foldActivity } from "../src/pages/run/activity-fold.ts";

let seq = 0;
const line = (kind: Activity["kind"], more: Partial<Activity> = {}): Activity => ({ seq: ++seq, at: "2026-11-25T12:00:00Z", kind, text: kind, ...more });
/** A tool call and its result, which count as one call. */
const call = (tool: string) => [line("tool", { tool }), line("tool-result")];
const calls = (...tools: string[]) => tools.flatMap(call);

describe("folding tool calls", () => {
  test("five calls in a row fold into one line that names them, by count, then by first use", () => {
    const items = foldActivity([line("text"), ...calls("Bash", "Read", "Read", "Bash", "Read", "Grep"), line("text")], false);
    expect(items.map((i) => i.t)).toEqual(["line", "tools", "line"]);
    const fold = items[1]!;
    expect(fold.t === "tools" && fold).toMatchObject({ calls: 6, summary: "6 tool calls: Read 3, Bash 2, Grep 1" });
    expect(fold.t === "tools" && fold.lines).toHaveLength(12);
  });

  test("four calls stay as their own lines", () => {
    const items = foldActivity(calls("Read", "Read", "Read", "Read"), false);
    expect(items).toHaveLength(8);
    expect(items.every((i) => i.t === "line")).toBe(true);
  });

  test("the last run of a live step stays open, so new calls show as they come", () => {
    const five = calls("Read", "Read", "Read", "Read", "Read");
    expect(foldActivity(five, true).every((i) => i.t === "line")).toBe(true);
    expect(foldActivity(five, false).map((i) => i.t)).toEqual(["tools"]);
    // A run before the live tail folds as usual.
    expect(foldActivity([...five, line("text"), ...calls("Bash")], true).map((i) => i.t)).toEqual(["tools", "line", "line", "line"]);
  });

  test("the prompt is left out, since it has its own part", () => {
    expect(foldActivity([line("prompt"), line("text")], false)).toEqual([{ t: "line", line: expect.objectContaining({ kind: "text" }) }]);
  });
});

import { describe, expect, test } from "vitest";
import { type Place, wentPast } from "../src/ui/motion.ts";

const H = 28;
const row = (key: string, was: number, now: number, parent = "list") => ({ key, parent, was: at(was), now: at(now) });
const at = (i: number): Place => ({ x: 0, y: i * H, w: 200, h: H });
const keys = (moves: { key: string }[]) => moves.map((m) => m.key);

describe("which moved rows went past others", () => {
  test("a run that changed group went past the rows it crossed, and they did not", () => {
    // d went from the fourth row to the first, and a, b and c each moved down one.
    expect(keys(wentPast([row("a", 0, 1), row("b", 1, 2), row("c", 2, 3), row("d", 3, 0)]))).toEqual(["d"]);
    expect(keys(wentPast([row("a", 0, 3), row("b", 1, 0), row("c", 2, 1), row("d", 3, 2)]))).toEqual(["a"]);
  });

  test("rows pushed down by a new run and its group kept their order, so none went past", () => {
    expect(wentPast([row("a", 0, 2), row("b", 1, 3), row("c", 2, 4)])).toEqual([]);
  });

  test("rows that close the gap of a removed run kept their order", () => {
    expect(wentPast([row("c", 3, 2), row("d", 4, 3)])).toEqual([]);
  });

  test("two rows that swapped both went past each other", () => {
    expect(keys(wentPast([row("a", 0, 1), row("b", 1, 0)]))).toEqual(["a", "b"]);
  });

  test("items compare only with those in the same parent", () => {
    expect(wentPast([row("a", 0, 1, "frame"), row("b", 1, 0, "canvas")])).toEqual([]);
  });
});

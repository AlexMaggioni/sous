import { describe, expect, test } from "vitest";
import type { Flow, FlowNode, FlowStep } from "../src/api/contract.ts";
import { layoutGraph, type Layout } from "../src/graph/layout.ts";
import { pageMeasure } from "../src/graph/measure.ts";
import { savedGraph } from "../src/graph/model.ts";
import type { Seq } from "../src/graph/tree.ts";
import { GRAPH_STATES, planOfState, type GraphInput } from "../src/kit/fixtures.ts";

// jsdom has no canvas, so the widths come from the estimate.
const measure = pageMeasure();
const graphOf = (p: GraphInput): Seq => planOfState(p)!.graph;
const lay = (g: Seq, width: number, folds: Record<string, boolean> = {}) => layoutGraph(g, { width, narrow: width < 700, measure, folds });

type Rect = { x: number; y: number; w: number; h: number };
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
const near = (a: number, b: number) => Math.abs(a - b) <= 1;
const within = (v: number, lo: number, hi: number) => v >= lo - 1 && v <= hi + 1;

/** The node, box or end mark an arrowhead points into, from the side it comes in by. */
function target(l: Layout, h: Layout["heads"][number]): string | null {
  const rects: Array<Rect & { name: string }> = [
    ...l.nodes.map((n) => ({ ...n, name: n.part.key })),
    ...l.under.map((u) => ({ ...u, name: u.t === "box" ? u.part.key : "plate" })),
  ];
  const hit = rects.find((r) => {
    if (h.dir === "r") return near(h.x, r.x) && within(h.y, r.y, r.y + r.h);
    if (h.dir === "l") return near(h.x, r.x + r.w) && within(h.y, r.y, r.y + r.h);
    if (h.dir === "d") return near(h.y, r.y) && within(h.x, r.x, r.x + r.w);
    return near(h.y, r.y + r.h) && within(h.x, r.x, r.x + r.w);
  });
  if (hit) return hit.name;
  const end = l.marks.find((m) => m.kind === "end" && Math.hypot(m.x - h.x, m.y - h.y) <= 6);
  return end ? "end" : null;
}

const WIDTHS = [375, 768, 1016, 1440];

describe("the layout of each state the kit shows", () => {
  for (const s of GRAPH_STATES) {
    for (const width of WIDTHS) {
      test(`${s.title} at ${width}px: no two nodes overlap, and every arrowhead ends at a node`, () => {
        const l = lay(graphOf(s.props), width);
        for (let i = 0; i < l.nodes.length; i++)
          for (let j = i + 1; j < l.nodes.length; j++) expect(overlap(l.nodes[i], l.nodes[j]), `${l.nodes[i].part.key} and ${l.nodes[j].part.key}`).toBe(false);
        // Two boxes are side by side or one holds the other.
        const boxes = l.under.filter((u) => u.t === "box");
        for (const a of boxes)
          for (const b of boxes) {
            if (a === b || !overlap(a, b)) continue;
            const holds = (o: Rect, i: Rect) => o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;
            expect(holds(a, b) || holds(b, a), `${a.part.key} and ${b.part.key}`).toBe(true);
          }
        for (const h of l.heads) expect(target(l, h), `head at ${h.x},${h.y} ${h.dir}`).not.toBeNull();
        for (const n of l.nodes) expect(l.heads.some((h) => target(l, h) === n.part.key), `nothing comes into ${n.part.key}`).toBe(true);
        for (const n of l.nodes) {
          expect(n.x).toBeGreaterThanOrEqual(0);
          expect(n.y).toBeGreaterThanOrEqual(0);
          expect(n.x + n.w).toBeLessThanOrEqual(l.width);
          expect(n.y + n.h).toBeLessThanOrEqual(l.height);
        }
      });
    }
  }
});

let n = 0;
const at = () => ({ id: `n${++n}`, line: n });
const step = (kind: FlowStep["kind"], label: string, more: Partial<FlowStep> = {}): FlowStep => ({ t: "step", ...at(), kind, label, ...more });
const flow = (...nodes: FlowNode[]): Flow => ({ nodes, notes: [] });
const long = savedGraph(flow(...["fetch", "triager", "planner", "implementer", "reviewer", "tests", "commit", "push", "notify"].map((l) => step("agent", l))));

describe("how the layout fits its width", () => {
  test("a short graph reads left to right in one row when there is room", () => {
    const l = lay(savedGraph(flow(step("sh", "tests"), step("sh", "commit"))), 1440);
    expect(l.mode).toBe("h");
    expect(new Set(l.nodes.map((x) => x.y)).size).toBe(1);
  });

  test("a long graph wraps into rows that each fit the width", () => {
    const l = lay(long, 900);
    expect(l.mode).toBe("w");
    expect(l.width).toBeLessThanOrEqual(900);
    expect(new Set(l.nodes.map((x) => x.y)).size).toBeGreaterThan(1);
  });

  test("on a narrow screen it reads top to bottom with 40px nodes, under the width", () => {
    for (const s of GRAPH_STATES) {
      const l = lay(graphOf(s.props), 375);
      expect(l.mode, s.title).toBe("v");
      expect(l.width, s.title).toBeLessThanOrEqual(375);
      for (const x of l.nodes) if (x.part.t === "leaf") expect(x.h).toBe(40);
    }
    const l = lay(long, 375);
    const ys = l.nodes.map((x) => x.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  test("a box folds to one node, and a fold by hand stays", () => {
    const g = graphOf(GRAPH_STATES.find((s) => s.title === "Saved workflow with a nested workflow")!.props);
    const closed = lay(g, 1440);
    const docs = closed.nodes.find((x) => x.part.t === "box");
    expect(docs).toBeDefined();
    expect(closed.folded[docs!.part.key]).toBe(true);
    const open = lay(g, 1440, { [docs!.part.key]: false });
    expect(open.folded[docs!.part.key]).toBe(false);
    expect(open.under.some((u) => u.t === "box" && u.part.key === docs!.part.key)).toBe(true);
    expect(open.nodes.map((x) => x.part.key)).not.toContain(docs!.part.key);
  });
});

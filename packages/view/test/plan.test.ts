import { describe, expect, test } from "vitest";
import type { Flow, FlowNode, FlowStep, RunPage } from "../src/api/contract.ts";
import { findPart, type Leaf, type Part, type Seq } from "../src/graph/tree.ts";
import { aroundOf, insideOf, nameOf, nodeOf, planOf, readsOf } from "../src/plan/plan.ts";
import { groupsAround, planRows, startFolded } from "../src/plan/rows.ts";

let n = 0;
const at = () => ({ id: `n${++n}`, line: n });
const step = (kind: FlowStep["kind"], label: string, more: Partial<FlowStep> = {}): FlowStep => ({ t: "step", ...at(), kind, label, ...more });
const flow = (...nodes: FlowNode[]): Flow => ({ nodes, notes: [] });
const graphOf = (f: Flow, flows?: Record<string, Flow>): Seq => planOf(f, flows)!.graph;
/** The key of a node at the root. Inside a group, a key also names the group, so find it by name. */
const keyOf = (node: FlowNode) => `/${node.id}`;
const names = (refs: { name: string }[]) => refs.map((r) => r.name);

describe("the plan", () => {
  test("is null with nothing to show, for a workflow with no text or a run with no text and no steps", () => {
    expect(planOf(undefined, undefined)).toBeNull();
    expect(planOf(undefined, undefined, { steps: [], questions: [], status: "running" } as unknown as RunPage)).toBeNull();
  });

  test("a part leads back to its node, also inside a nested workflow", () => {
    const inner = step("sh", "changes");
    const flows = { docs: flow(inner) };
    const outer = step("workflow", "docs", { workflow: "docs" });
    const graph = graphOf(flow(outer), flows);
    const box = findPart(graph, keyOf(outer))!;
    expect(nodeOf(box, flow(outer), flows)).toBe(outer);
    expect(nodeOf(findLeaf(graph, "changes")!, flow(outer), flows)).toBe(inner);
  });

  test("a run's part is found by the key of each call it made", () => {
    const leaf: Leaf = { t: "leaf", key: "/a", label: "reviewer", kind: "agent", step: "r1:4", calls: ["r1:2", "r1:4"] };
    const graph: Seq = { t: "seq", key: "", items: [leaf] };
    expect(findPart(graph, "r1:2")).toBe(leaf);
    expect(findPart(graph, "r1:4")).toBe(leaf);
    expect(findPart(graph, "r1:9")).toBeUndefined();
  });
});

function findLeaf(part: Part, label: string): Leaf | undefined {
  if (part.t === "leaf") return part.label === label ? part : undefined;
  const kids = part.t === "seq" ? part.items : part.t === "par" ? part.lanes : part.t === "box" ? (part.body ? [part.body] : []) : part.t === "iff" ? [part.body] : [];
  for (const kid of kids) {
    const hit = findLeaf(kid, label);
    if (hit) return hit;
  }
  return undefined;
}

describe("names", () => {
  test("a group reads as what it does", () => {
    const graph = graphOf(
      flow(
        { t: "pipeline", ...at(), over: "packages", stages: [[step("agent", "upgrade")], [step("sh", "test")]] },
        { t: "parallel", ...at(), branches: [[step("agent", "reviewer")], [step("agent", "security")]] },
        { t: "if", ...at(), cond: "big", then: [step("sh", "split")], else: [step("sh", "keep")] },
        { t: "if", ...at(), cond: "!ok", then: [{ t: "end", ...at() }] },
      ),
    );
    const parts = graph.items.slice(1, -1);
    expect(parts.map(nameOf)).toEqual(["pipeline over packages", "at once", "if big, else", "if !ok, end"]);
  });
});

describe("where a part sits", () => {
  test("a step in a row runs after the one before it and before the one after it", () => {
    const [a, b, c] = [step("sh", "build"), step("sh", "test"), step("sh", "ship")];
    const graph = graphOf(flow(a, b, c));
    expect(aroundOf(graph, keyOf(b))).toMatchObject({ first: false, last: false });
    expect(names(aroundOf(graph, keyOf(b)).after)).toEqual(["build"]);
    expect(names(aroundOf(graph, keyOf(b)).then)).toEqual(["ship"]);
    expect(aroundOf(graph, keyOf(a))).toMatchObject({ first: true, after: [] });
    expect(aroundOf(graph, keyOf(c))).toMatchObject({ last: true, then: [] });
  });

  test("a branch runs alongside the other branches, and the step after reads each branch's last step", () => {
    const [rev, sec, ship] = [step("agent", "reviewer"), step("agent", "security"), step("sh", "ship")];
    const graph = graphOf(flow({ t: "parallel", ...at(), branches: [[rev], [sec]] }, ship));
    expect(names(aroundOf(graph, findLeaf(graph, "reviewer")!.key).alongside)).toEqual(["security"]);
    expect(names(aroundOf(graph, keyOf(ship)).after)).toEqual(["reviewer", "security"]);
  });

  test("an if and its else never run together", () => {
    const [split, keep] = [step("sh", "split"), step("sh", "keep")];
    const graph = graphOf(flow({ t: "if", ...at(), cond: "big", then: [split], else: [keep] }));
    expect(aroundOf(graph, findLeaf(graph, "split")!.key).alongside).toEqual([]);
  });

  test("a group lists the steps right inside it", () => {
    const loop: FlowNode = { t: "loop", ...at(), loop: "while", label: "!approved", body: [step("agent", "address review"), step("agent", "reviewer")] };
    const graph = graphOf(flow(loop));
    expect(names(insideOf(findPart(graph, keyOf(loop))!))).toEqual(["address review", "reviewer"]);
  });
});

describe("what a step reads", () => {
  test("an earlier step's result links to that step, an input reads as an input, and the step lists who reads it", () => {
    const plan = step("agent", "planner", { result: "plan" });
    const build = step("agent", "builder", { reads: ["plan", "args.ticket", "notes"], result: "work" });
    const text = flow(plan, build);
    const graph = graphOf(text);
    const { reads } = readsOf(build, text, graph, undefined);
    expect(reads).toEqual([{ name: "plan", ref: { key: keyOf(plan), name: "planner" } }, { name: "the input ticket" }, { name: "notes" }]);
    expect(readsOf(plan, text, graph, undefined).readBy).toEqual([{ key: keyOf(build), name: "builder" }]);
  });
});

describe("the rows of the Steps view", () => {
  test("each step in order, a group's steps under it, and a lane named when it holds more than one step", () => {
    const loop: FlowNode = { t: "loop", ...at(), loop: "while", label: "!approved", body: [step("agent", "reviewer")] };
    const par: FlowNode = { t: "parallel", ...at(), branches: [[step("agent", "a"), step("agent", "b")], [step("agent", "c")]] };
    const graph = graphOf(flow(step("sh", "build"), loop, par));
    const rows = planRows(graph, new Set());
    expect(rows.map((r) => [r.lane ?? nameOf(r.part), r.depth])).toEqual([
      ["build", 0],
      ["while !approved", 0],
      ["reviewer", 1],
      ["at once", 0],
      ["branch 1", 1],
      ["a", 2],
      ["b", 2],
      ["c", 1],
    ]);
    expect(rows.find((r) => nameOf(r.part) === "while !approved")?.group).toBe(true);
  });

  test("a folded group hides its steps, and a selected step opens the groups around it", () => {
    const inner = step("agent", "reviewer");
    const loop: FlowNode = { t: "loop", ...at(), loop: "while", label: "!approved", body: [inner] };
    const graph = graphOf(flow(loop));
    expect(planRows(graph, new Set([keyOf(loop)])).map((r) => nameOf(r.part))).toEqual(["while !approved"]);
    expect(groupsAround(graph, findLeaf(graph, "reviewer")!.key)).toEqual([keyOf(loop)]);
    expect(groupsAround(graph, "/missing")).toEqual([]);
  });

  test("a saved nested workflow starts folded", () => {
    const outer = step("workflow", "docs", { workflow: "docs" });
    const graph = graphOf(flow(outer), { docs: flow(step("sh", "changes")) });
    expect([...startFolded(graph)]).toEqual([keyOf(outer)]);
  });
});

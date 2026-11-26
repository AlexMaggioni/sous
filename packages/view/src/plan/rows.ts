// The rows of the Steps view, from the same plan the graph draws: each step in the order the text
// runs it, with each group's steps indented under it. Pure.
import { kidsOf, pathTo, type Part, type Seq } from "../graph/tree.ts";

export interface PlanRow {
  key: string;
  part: Part;
  depth: number;
  /** A group that folds: a loop, a nested workflow, a pipeline, branches or an if. */
  group: boolean;
  /** A branch's name, such as "else", on a row of its own that opens nothing. */
  lane?: string;
}

/** Each lane of a parallel or an if with an else, named when it holds more than one step. */
function laneName(par: Extract<Part, { t: "par" }>, i: number): string | undefined {
  return par.conds?.[i] ?? `branch ${i + 1}`;
}

function visit(part: Part, depth: number, folded: ReadonlySet<string>, out: PlanRow[], root: boolean) {
  switch (part.t) {
    case "seq":
      for (const item of part.items) visit(item, depth, folded, out, root);
      return;
    case "start":
      return;
    case "end":
      // The end of the whole workflow goes without saying. A return inside a branch ends it early.
      if (!root) out.push({ key: part.key, part, depth, group: false });
      return;
    case "leaf":
    case "ret":
      out.push({ key: part.key, part, depth, group: false });
      return;
    case "box":
    case "iff": {
      const body = kidsOf(part);
      out.push({ key: part.key, part, depth, group: body.length > 0 });
      if (!folded.has(part.key)) for (const kid of body) visit(kid, depth + 1, folded, out, false);
      return;
    }
    case "par":
      out.push({ key: part.key, part, depth, group: true });
      if (folded.has(part.key)) return;
      part.lanes.forEach((lane, i) => {
        // A lane of one step needs no name of its own, unless it is an if's branch.
        const named = lane.items.length > 1 || !!part.conds;
        if (named) out.push({ key: `${lane.key} lane`, part: lane, depth: depth + 1, group: false, lane: laneName(part, i) });
        visit(lane, depth + (named ? 2 : 1), folded, out, false);
      });
      return;
  }
}

/** The rows that show, with the groups in `folded` closed. */
export function planRows(graph: Seq, folded: ReadonlySet<string>): PlanRow[] {
  const out: PlanRow[] = [];
  visit(graph, 0, folded, out, true);
  return out;
}

/** The groups that start folded: the ones the plan folds, such as a saved nested workflow. */
export function startFolded(part: Part, out = new Set<string>()): Set<string> {
  if (part.t === "box" && part.folded && part.body) out.add(part.key);
  for (const kid of kidsOf(part)) startFolded(kid, out);
  return out;
}

/** The groups around a part, which open so the part shows. Empty when no part has the key. */
export function groupsAround(graph: Seq, key: string): string[] {
  return (pathTo(graph, key) ?? []).filter((p) => p.t === "box" || p.t === "iff" || p.t === "par").map((p) => p.key);
}

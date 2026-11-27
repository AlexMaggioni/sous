// The parts a graph is drawn from. model.ts makes them from a workflow's text, overlay.ts lays a
// run's steps over them, and layout.ts places them. Plain data: nothing here draws.
import type { RoomTag, Status, StepKind } from "../api/contract.ts";

/** The icon of a node in a saved graph. A run's node shows its status instead. */
export type KindIcon = StepKind | "pipeline";

/** The start mark and each end mark. */
export interface Mark {
  t: "start" | "end";
  key: string;
}

/** One node: a step, or a step of a run. */
export interface Leaf {
  t: "leaf";
  /** Unique in the graph and stable across draws, for focus and React keys. */
  key: string;
  label: string;
  kind: KindIcon;
  /** Set in a run's graph, where it replaces the kind icon. */
  status?: Status;
  /** Muted after the name: the agent or the workflow when it differs from the name. */
  sub?: string;
  /** "↻ 2" in a saved graph, "↻ 1 of 2" in a run that retried. */
  retries?: string;
  /** A pipeline's items, such as "×4". */
  count?: string;
  duration?: string;
  /** The whole name and what the node leaves out, on hover. */
  tip?: string;
  /** Copper border: it waits on the person. */
  needs?: boolean;
  /** Red border: a step inside a folded box failed. */
  bad?: boolean;
  /** A pipeline: a second border behind, offset 4px. */
  stack?: boolean;
  /** The run step it opens, by key. */
  step?: string;
  /** The node of the text it stands for. */
  node?: string;
  /** The nested workflow whose text holds that node. Unset for the root's own text. */
  flow?: string;
  /** In a run, the step keys of each time it ran, oldest first, when it ran more than once, such as in each round of a loop. */
  calls?: string[];
  /** In a run, the id of the open question it waits on. */
  ask?: string;
}

/** Parts in order. */
export interface Seq {
  t: "seq";
  key: string;
  items: Part[];
}

/** Branches that fork from one point and join into one. An if with an else has a label on each. */
export interface Par {
  t: "par";
  key: string;
  lanes: Seq[];
  conds?: string[];
  node?: string;
  flow?: string;
}

/** Steps that run only on a condition: a detour under the line. */
export interface Iff {
  t: "iff";
  key: string;
  label: string;
  body: Seq;
  /** The detour a loop's back arrow comes into, such as the "if (feedback)" of a review loop. */
  onBack?: boolean;
  /** The detour ends the workflow, so it doesn't join the line again. */
  ends?: boolean;
  node?: string;
  flow?: string;
}

/** An early return: a branch down to its own end mark. */
export interface Ret {
  t: "ret";
  key: string;
  /** The condition on the branch, such as "!review.ok". */
  edge: string;
  /** What the end mark says, such as "ends". */
  outcome: string;
  /** The label of the edge that carries on, such as "review.ok". */
  ok?: string;
  node?: string;
  flow?: string;
}

/** A loop with its back arrow, a nested workflow, a pipeline, or a room with a lane per member. Folded, it is one node. */
export interface Box {
  t: "box";
  key: string;
  kind: "loop" | "workflow" | "pipeline" | "room";
  title: string;
  /** Muted after the title, such as "round 2 of 3". */
  sub?: string;
  /** Muted after the name once folded. */
  foldSub?: string;
  count?: string;
  status?: Status;
  duration?: string;
  needs?: boolean;
  bad?: boolean;
  /** The label of the back arrow, such as "check fails ×3". Only a loop has one. */
  again?: string;
  stack?: boolean;
  tip?: string;
  /** Null when there is nothing to open, such as a pipeline that has not run. */
  body: Seq | null;
  /** The person can fold and open it. */
  foldable?: boolean;
  /** How it opens before the person folds it or the fit does. */
  folded?: boolean;
  /** The fit may fold it to make room. */
  auto?: boolean;
  step?: string;
  node?: string;
  flow?: string;
  /** In a run, the room() call a room box shows, for its transcript. */
  room?: RoomTag & { scope: string };
}

export type Part = Mark | Leaf | Seq | Par | Iff | Ret | Box;

/** The kind icon of a box other than a loop. */
export const boxIcon = (box: Box): KindIcon => (box.kind === "pipeline" || box.kind === "room" ? box.kind : "workflow");

/** Every box that folds, depth first, with how many boxes it sits in. */
export function foldingBoxes(part: Part, depth = 0, out: Array<{ box: Box; depth: number }> = []): Array<{ box: Box; depth: number }> {
  if (part.t === "box" && part.foldable && part.body) out.push({ box: part, depth });
  for (const kid of kidsOf(part)) foldingBoxes(kid, depth + (part.t === "box" ? 1 : 0), out);
  return out;
}

/** The parts right inside a part. */
export function kidsOf(part: Part): Part[] {
  switch (part.t) {
    case "seq":
      return part.items;
    case "par":
      return part.lanes;
    case "iff":
      return [part.body];
    case "box":
      return part.body ? [part.body] : [];
    default:
      return [];
  }
}

/** The part with this key, or with this run step key, which older links and the notices use. */
export function findPart(part: Part, key: string): Part | undefined {
  if (part.key === key || ((part.t === "leaf" || part.t === "box") && (part.step === key || (part.t === "leaf" && part.calls?.includes(key))))) return part;
  for (const kid of kidsOf(part)) {
    const hit = findPart(kid, key);
    if (hit) return hit;
  }
  return undefined;
}

/** The parts around the part with this key, outermost first, or null when no part has it. */
export function pathTo(part: Part, key: string, above: Part[] = []): Part[] | null {
  if (part.key === key) return above;
  for (const kid of kidsOf(part)) {
    const hit = pathTo(kid, key, [...above, part]);
    if (hit) return hit;
  }
  return null;
}

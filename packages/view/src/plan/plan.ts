// What the Graph view, the Steps view and the step panel share: the plan of a workflow or of a run
// as one tree of parts, the node of the text behind a part, and the words that say where a part
// sits. Both views draw the same tree, so they show the same steps under the same names. Pure.
import type { Flow, FlowNode, FlowStep, Question } from "../api/contract.ts";
import { savedGraph } from "../graph/model.ts";
import { runGraph, type RunGraph, type RunInput } from "../graph/overlay.ts";
import { kidsOf, pathTo, type Part, type Seq } from "../graph/tree.ts";

export type Plan = RunGraph;

/** What the plan reads of a run, such as a RunPage. */
export type PlanRun = Pick<RunInput, "steps" | "nested" | "questions" | "status" | "args">;

/**
 * The plan of a saved workflow, or of a run laid over its text. Null when there is nothing to show.
 * `answered` holds the questions answered on the page that let the run go on, so their gate reads done.
 */
export function planOf(flow: Flow | undefined, flows: Record<string, Flow> | undefined, run?: PlanRun, now?: number, answered?: Question[]): Plan | null {
  if (run) {
    if (!flow && !run.steps.length) return null;
    return runGraph({ flow, steps: run.steps, flows, nested: run.nested, questions: run.questions, answered, status: run.status, args: run.args, now });
  }
  return flow ? { graph: savedGraph(flow, flows), asRan: false } : null;
}

/** Every node right under this one, in the order the text runs them. */
function childrenOf(node: FlowNode): FlowNode[] {
  switch (node.t) {
    case "step":
      return node.body ?? [];
    case "loop":
      return node.body;
    case "if":
      return [...node.then, ...(node.else ?? [])];
    case "parallel":
      return node.branches.flat();
    case "pipeline":
      return node.stages.flat();
    case "end":
      return [];
  }
}

/** The node with this id, anywhere in the flow. */
function findNode(nodes: readonly FlowNode[], id: string): FlowNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(childrenOf(node), id);
    if (found) return found;
  }
  return undefined;
}

/** Every step of a text, depth first. */
function stepsOf(nodes: readonly FlowNode[], out: FlowStep[] = []): FlowStep[] {
  for (const node of nodes) {
    if (node.t === "step") out.push(node);
    stepsOf(childrenOf(node), out);
  }
  return out;
}

const nodeId = (part: Part) => ("node" in part ? part.node : undefined);
const flowName = (part: Part) => ("flow" in part ? part.flow : undefined);

/** The text a part comes from: the root's, or the nested workflow's it sits in. */
export function textOf(part: Part, flow: Flow | undefined, flows: Record<string, Flow> = {}): Flow | undefined {
  const name = flowName(part);
  return name ? flows[name] : flow;
}

/** The node of the text a part stands for. */
export function nodeOf(part: Part, flow: Flow | undefined, flows: Record<string, Flow> = {}): FlowNode | undefined {
  const id = nodeId(part);
  const text = textOf(part, flow, flows);
  return id && text ? findNode(text.nodes, id) : undefined;
}

/** A part's name, as its row and its panel show it. */
export function nameOf(part: Part): string {
  switch (part.t) {
    case "leaf":
      return part.label;
    case "box":
      return part.kind === "pipeline" ? `pipeline over ${part.title}` : part.title;
    case "par":
      return part.conds ? `${part.conds[0]}, else` : "at once";
    case "iff":
      return part.label;
    case "ret":
      return `if ${part.edge}, end`;
    case "start":
      return "start";
    case "end":
      return "end";
    case "seq":
      return "";
  }
}

/** A part another part's words point to, which the person can select. */
export interface Ref {
  key: string;
  name: string;
}

const refOf = (part: Part): Ref => ({ key: part.key, name: nameOf(part) });

/** The parts a person reads as the next or the last thing of a part, such as each branch's first step. */
function endsOf(part: Part, dir: -1 | 1): Ref[] {
  if (part.t !== "par") return [refOf(part)];
  return part.lanes.flatMap((lane) => {
    const end = dir === 1 ? lane.items[0] : lane.items[lane.items.length - 1];
    return end ? endsOf(end, dir) : [];
  });
}

/** What runs just before (dir -1) or just after (dir 1) the part, or "edge" at the start or the end of the workflow. */
function sideOf(path: Part[], key: string, dir: -1 | 1): Ref[] | "edge" {
  let child = key;
  for (let i = path.length - 1; i >= 0; i--) {
    const p = path[i]!;
    if (p.t === "seq") {
      const next = p.items[p.items.findIndex((x) => x.key === child) + dir];
      if (next?.t === "start" || next?.t === "end") return "edge";
      if (next) return endsOf(next, dir);
    }
    child = p.key;
  }
  return "edge";
}

/** Where a part sits: what runs before it, beside it and after it. */
export interface Around {
  after: Ref[];
  alongside: Ref[];
  then: Ref[];
  first: boolean;
  last: boolean;
}

export function aroundOf(graph: Seq, key: string): Around {
  const path = pathTo(graph, key) ?? [];
  const before = sideOf(path, key, -1);
  const after = sideOf(path, key, 1);
  // The other branches of the closest parallel, unless it is an if and an else, which never run together.
  let alongside: Ref[] = [];
  for (let i = path.length - 1; i > 0; i--) {
    const par = path[i - 1]!;
    const lane = path[i]!;
    if (par.t !== "par") continue;
    if (!par.conds && !par.key.endsWith("/lanes")) alongside = par.lanes.filter((l) => l.key !== lane.key).flatMap((l) => (l.items[0] ? endsOf(l.items[0], 1) : []));
    break;
  }
  return { after: before === "edge" ? [] : before, alongside, then: after === "edge" ? [] : after, first: before === "edge", last: after === "edge" };
}

/** The steps and groups right inside a group, in order. */
export function insideOf(part: Part): Ref[] {
  const items = part.t === "par" ? part.lanes.flatMap((l) => l.items) : kidsOf(part).flatMap((k) => (k.t === "seq" ? k.items : [k]));
  return items.filter((p) => p.t !== "start" && p.t !== "end" && p.t !== "seq").map(refOf);
}

/** The first part of the plan that stands for this node of this text. */
function partOfNode(part: Part, id: string, flow: string | undefined): Part | undefined {
  if (nodeId(part) === id && flowName(part) === flow) return part;
  for (const kid of kidsOf(part)) {
    const hit = partOfNode(kid, id, flow);
    if (hit) return hit;
  }
  return undefined;
}

/** One thing a step reads: an earlier step's result, which links to it, an input, or a name the text gives it. */
export interface Read {
  name: string;
  ref?: Ref;
}

/** What a step reads, and which later steps read its result. */
export function readsOf(node: FlowStep, text: Flow, graph: Seq, flow: string | undefined): { reads: Read[]; readBy: Ref[] } {
  const steps = stepsOf(text.nodes);
  const linked = (step: FlowStep) => {
    const part = partOfNode(graph, step.id, flow);
    return part ? refOf(part) : { key: "", name: step.label };
  };
  const reads = (node.reads ?? []).map((name): Read => {
    if (name.startsWith("args.")) return { name: `the input ${name.slice(5)}` };
    const from = steps.find((s) => s.result === name && s.id !== node.id);
    return from ? { name, ref: linked(from) } : { name };
  });
  const result = node.result;
  const readBy = result ? steps.filter((s) => s.id !== node.id && s.reads?.includes(result)).map(linked) : [];
  return { reads, readBy };
}

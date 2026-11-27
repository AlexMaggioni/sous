// The parts of a graph, from the graph of a workflow's text (contract.ts, Flow). One walk serves a
// saved workflow and a run: a run passes hooks, which overlay.ts writes, to lay its steps over the
// same parts.
import type { Flow, FlowIf, FlowLoop, FlowNode, FlowPipeline, FlowStep } from "../api/contract.ts";
import { shownLabel } from "./match.ts";
import type { Box, Leaf, Part, Seq } from "./tree.ts";

/** What a run adds as the walk goes. Unset for a saved workflow. */
export interface RunHooks {
  /** A step's part: its leaf, which the run fills in once every step has a place, or the box of the nested run it started. */
  step(node: FlowStep, leaf: Leaf, w: Walk): Part;
  /** A loop's body over its latest round, and the round it is in. A breakpoint with a step repeats it too. */
  rounds(node: FlowLoop | FlowStep, limit: number | null, body: () => Seq): { body: Seq; sub?: string };
  /** One lane per item a pipeline ran, each over its item's steps. Null when none ran. */
  items(node: FlowPipeline, lane: (i: number) => Seq): Seq[] | null;
}

export interface Walk {
  hooks?: RunHooks;
  flows: Record<string, Flow>;
  args: Record<string, unknown>;
  /** The key of the part the walk is in. The keys of the parts inside start with it. */
  path: string;
  /** The workflows the walk is inside, to stop at a loop of workflows and past three deep. */
  inside: string[];
}

const MAX_LABEL = 40;
const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);

/** A condition as the text writes it, on one line and short. A catch reads "on error". */
function condText(cond: string): string {
  const one = cond.replace(/\s+/g, " ").trim();
  return one === "error" ? "on error" : clip(one);
}

/** The rounds of a counted for loop as a number: written, or from the run's args. Null when not known. */
function loopLimit(node: FlowLoop, args: Record<string, unknown>): number | null {
  if (node.limit === undefined) return null;
  const n = Number(node.limit);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const m = /^args\.([A-Za-z_$][\w$]*)$/.exec(node.limit.trim());
  const v = m ? Number(args[m[1]]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/** The nested workflow a part of the walk sits in, as the part's `flow`. */
const inFlow = (w: Walk) => (w.inside.length ? { flow: w.inside[w.inside.length - 1] } : {});

/** A step's own node. A run fills in its status, duration and step. */
function leafOf(node: FlowStep, w: Walk): Leaf {
  const label = node.label === node.kind && node.agent ? node.agent : shownLabel(node);
  const sub = node.agent && node.agent !== label ? node.agent : node.workflow && node.workflow !== label ? node.workflow : undefined;
  return {
    t: "leaf",
    key: `${w.path}/${node.id}`,
    label,
    kind: node.kind,
    ...(sub ? { sub } : {}),
    ...(node.retries ? { retries: `↻ ${node.retries}` } : {}),
    ...(node.dynamic ? { tip: node.label } : {}),
    node: node.id,
    ...inFlow(w),
  };
}

/** A saved workflow() step whose workflow's graph is known: a folded box that opens to it. */
function workflowBox(node: FlowStep, w: Walk): Part {
  const leaf = leafOf(node, w);
  const flow = node.workflow ? w.flows[node.workflow] : undefined;
  if (!flow || !node.workflow || w.inside.includes(node.workflow) || w.inside.length >= 3) return leaf;
  const inner = { ...w, path: `${leaf.key}>`, inside: [...w.inside, node.workflow] };
  return {
    t: "box",
    key: leaf.key,
    kind: "workflow",
    title: leaf.label,
    ...(leaf.sub ? { sub: leaf.sub, foldSub: leaf.sub } : {}),
    tip: `Workflow ${node.workflow}`,
    body: seqOf(flow.nodes, inner, `${leaf.key}>`),
    foldable: true,
    folded: true,
    node: node.id,
    ...inFlow(w),
  };
}

/** A room's members as the text names them, "…" for one it makes at run time. */
export function roomMembers(node: FlowStep): string[] {
  return (node.members ?? []).map((m) => (/^\{[^{}]*\}$/.test(m) ? "…" : m));
}

/** A room's body: one lane per member, side by side, as they talk in the same rounds. */
export function roomBody(key: string, members: Leaf[]): Seq {
  const lanes: Seq[] = members.map((leaf) => ({ t: "seq", key: `${leaf.key}/lane`, items: [leaf] }));
  return { t: "seq", key: `${key}/members`, items: lanes.length === 1 ? lanes[0].items : lanes.length ? [{ t: "par", key: `${key}/lanes`, lanes }] : [] };
}

/** A saved room: a box with a lane per member. A room whose list of members the text makes at run time stays one node. */
function roomBox(node: FlowStep, w: Walk): Part {
  const leaf = leafOf(node, w);
  const members = roomMembers(node);
  if (!members.length) return leaf;
  const turns = node.options?.turns;
  const leaves: Leaf[] = members.map((label, i) => ({ t: "leaf", key: `${leaf.key}/@${i}`, label, kind: "agent", node: node.id, ...inFlow(w) }));
  return {
    t: "box",
    key: leaf.key,
    kind: "room",
    title: leaf.label,
    ...(turns && turns !== "together" ? { sub: turns, foldSub: turns } : {}),
    ...(node.prompt ? { tip: `Room ${leaf.label}: ${node.prompt}` } : {}),
    body: roomBody(leaf.key, leaves),
    foldable: true,
    node: node.id,
    ...inFlow(w),
  };
}

function stepParts(node: FlowStep, w: Walk): Part[] {
  if (node.kind === "breakpoint" && node.body?.length) {
    // The step a breakpoint runs comes first, then the breakpoint waits. A send back runs it again.
    const walk = () => seqOf(node.body ?? [], w, `${w.path}/${node.id}<`);
    const body = w.hooks ? w.hooks.rounds(node, null, walk).body : walk();
    return [...body.items, w.hooks ? w.hooks.step(node, leafOf(node, w), w) : leafOf(node, w)];
  }
  if (w.hooks) return [w.hooks.step(node, leafOf(node, w), w)];
  return [node.kind === "workflow" ? workflowBox(node, w) : node.kind === "room" ? roomBox(node, w) : leafOf(node, w)];
}

function loopBox(node: FlowLoop, w: Walk): Part[] {
  const key = `${w.path}/${node.id}`;
  if (!node.body.length) return [];
  const limit = loopLimit(node, w.args);
  const over = node.label ? clip(node.label.replace(/\s+/g, " ").trim()) : "";
  const title = `${node.loop}${over ? ` ${over}` : ""}`;
  // The back arrow says what comes again, and for a counted for loop how many times at most.
  const why = node.loop === "for" ? "next" : "again";
  let again = why;
  if (limit !== null) again = `${why} ×${limit}`;
  else if (node.limit) again = `${why}, up to ${clip(node.limit)}`;
  const inner = { ...w, path: key };
  // The body has a key of its own: the drawing keys each open box's head by the box's key.
  const walk = () => seqOf(node.body, inner, `${key}/body`, true);
  const { body, sub } = w.hooks ? w.hooks.rounds(node, limit, walk) : { body: walk(), sub: undefined };
  return [{ t: "box", key, kind: "loop", title, ...(sub ? { sub } : {}), again, body, node: node.id, ...inFlow(w) }];
}

/** True when a step in the nodes, nested ones too, keeps its result under the name. */
function keeps(nodes: FlowNode[], name: string): boolean {
  return nodes.some((node) => {
    switch (node.t) {
      case "step":
        return node.result === name || keeps(node.body ?? [], name);
      case "loop":
        return keeps(node.body, name);
      case "if":
        return keeps(node.then, name) || keeps(node.else ?? [], name);
      case "parallel":
        return node.branches.some((branch) => keeps(branch, name));
      case "pipeline":
        return node.stages.some((stage) => keeps(stage, name));
      default:
        return false;
    }
  });
}

/** An if. `later` is the rest of a loop's work when the if starts it. */
function ifParts(node: FlowIf, w: Walk, later?: FlowNode[]): Part[] {
  const key = `${w.path}/${node.id}`;
  const then = node.then;
  const els = node.else ?? [];
  const cond = condText(node.cond);
  if (!els.length && then.length === 1 && then[0].t === "end") {
    const ok = /^![\w$.]+$/.test(cond) ? cond.slice(1) : undefined;
    return [{ t: "ret", key, edge: cond, outcome: "ends", ...(ok ? { ok } : {}), node: node.id, ...inFlow(w) }];
  }
  if (then.length && els.length) {
    const lanes = [seqOf(then, w, `${key}.0`), seqOf(els, w, `${key}.1`)];
    return [{ t: "par", key, lanes, conds: [cond === "on error" ? cond : `if ${cond}`, "else"], node: node.id, ...inFlow(w) }];
  }
  const body = then.length ? then : els;
  if (!body.length) return [];
  const label = !then.length ? `unless ${cond}` : cond === "on error" ? cond : `if ${cond}`;
  // A loop's work starts with "if (feedback)", and a later step of it keeps feedback: the detour
  // its back arrow comes into.
  const name = node.cond.trim();
  const onBack = !!later && !els.length && /^[A-Za-z_$][\w$]*$/.test(name) && keeps(later, name);
  const ends = body[body.length - 1].t === "end";
  return [{ t: "iff", key, label, body: seqOf(body, w, `${key}/body`), ...(onBack ? { onBack } : {}), ...(ends ? { ends } : {}), node: node.id, ...inFlow(w) }];
}

function pipelineBox(node: FlowPipeline, w: Walk): Part[] {
  const key = `${w.path}/${node.id}`;
  const steps = node.stages.flat();
  if (!steps.length) return [];
  const one = steps.length === 1 && steps[0].t === "step" ? steps[0] : null;
  const over = clip(node.over.replace(/\s+/g, " ").replace(/^the /, "").trim());
  const tip = `Pipeline over ${node.over}${one ? `, each runs ${one.kind === "workflow" && one.workflow ? `the workflow ${one.workflow}` : shownLabel(one)}` : ""}`;
  const base: Box = { t: "box", key, kind: "pipeline", title: over, stack: true, tip, body: null, node: node.id, ...inFlow(w) };
  if (w.hooks) {
    const lanes = w.hooks.items(node, (i) => seqOf(steps, { ...w, path: `${key}#${i}` }, `${key}#${i}`));
    if (!lanes) return [base];
    return [{ ...base, count: `×${lanes.length}`, body: { t: "seq", key: `${key}/items`, items: [{ t: "par", key: `${key}/lanes`, lanes }] }, foldable: true }];
  }
  if (one && one.kind !== "breakpoint") return [base];
  return [{ ...base, body: seqOf(steps, { ...w, path: key }, `${key}/body`), foldable: true, folded: true }];
}

/** Parts in order. A return ends them: what follows it never runs. */
export function seqOf(nodes: FlowNode[], w: Walk, key: string, inLoop = false): Seq {
  const items: Part[] = [];
  for (const [i, node] of nodes.entries()) {
    if (node.t === "end") {
      items.push({ t: "end", key: `${w.path}/${node.id}` });
      break;
    }
    if (node.t === "step") items.push(...stepParts(node, w));
    else if (node.t === "loop") items.push(...loopBox(node, w));
    else if (node.t === "if") items.push(...ifParts(node, w, inLoop && i === 0 ? nodes.slice(1) : undefined));
    else if (node.t === "parallel") {
      const lanes = node.branches.filter((b) => b.length).map((b, j) => seqOf(b, { ...w, path: `${w.path}/${node.id}.${j}` }, `${w.path}/${node.id}.${j}`));
      if (lanes.length === 1) items.push(...lanes[0].items);
      else if (lanes.length) items.push({ t: "par", key: `${w.path}/${node.id}`, lanes, node: node.id, ...inFlow(w) });
    } else if (node.t === "pipeline") items.push(...pipelineBox(node, w));
  }
  return { t: "seq", key, items };
}

/** The whole graph: the start mark, the parts, and the end mark unless the parts end on one. */
export function withMarks(seq: Seq): Seq {
  const last = seq.items[seq.items.length - 1];
  const end: Part[] = last?.t === "end" ? [] : [{ t: "end", key: `${seq.key}/end` }];
  return { ...seq, items: [{ t: "start", key: `${seq.key}/start` }, ...seq.items, ...end] };
}

/** The graph of a saved workflow, with kind icons. A workflow() step whose graph is in `flows` folds open to it. */
export function savedGraph(flow: Flow, flows: Record<string, Flow> = {}): Seq {
  return withMarks(seqOf(flow.nodes, { flows, args: {}, path: "", inside: [] }, "graph"));
}

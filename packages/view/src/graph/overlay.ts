// A run's graph: its steps laid over the graph of the text it started with. Each node of the text
// takes the run's step of the same label, else of the same kind and run-time name, such as
// "sh: pnpm test" for a sh() with no label, else the next step of its kind in order. A loop shows
// its latest round, a pipeline its items, a nested run its own box. When a step finds no node, the
// graph shows the steps as they ran instead, so it is never wrong.
import type { Flow, FlowLoop, FlowNode, FlowPipeline, FlowStep, NestedRun, Question, Status, Step } from "../api/contract.ts";
import { formatDuration } from "../format.ts";
import { isEnded } from "../status.ts";
import { itemLabel, kindFits, madePart, namesScope, namesStep, runScopes, type Entry, type RunScope, type StepEntry } from "./match.ts";
import { seqOf, withMarks, type RunHooks, type Walk } from "./model.ts";
import type { Box, Leaf, Part, Seq } from "./tree.ts";
import { kidsOf } from "./tree.ts";

export interface RunInput {
  flow?: Flow;
  steps: Step[];
  flows?: Record<string, Flow>;
  nested?: NestedRun[];
  questions?: Question[];
  /**
   * The questions the person answered on the page with an answer that lets the run go on. Their
   * gate reads done at once, as the answer lands, without waiting for the next step to start.
   */
  answered?: Question[];
  /** The run's status: a node that never ran is queued while the run goes on, skipped once it ended. */
  status?: Status;
  args?: Record<string, unknown>;
  now?: number;
}

export interface RunGraph {
  graph: Seq;
  /** Some steps found no node, so the graph shows the steps as they ran. */
  asRan: boolean;
}

interface Ctx {
  flows: Record<string, Flow>;
  args: Record<string, unknown>;
  questions: Question[];
  answered: Question[];
  now: number;
  ended: boolean;
  /** The steps behind each leaf, for the time a box took. */
  times: Map<Leaf, Step[]>;
}

interface Slot {
  node: FlowStep;
  leaf: Leaf;
  entry?: StepEntry;
  /** The steps of the round or the item it sits in. Null: any step of its run. */
  allowed: Set<Entry> | null;
  /** The pipeline item it sits in, such as "zod", which names it before it runs. */
  item?: string;
}

const ran = (s: Status) => s !== "queued" && s !== "skipped";
const firstLine = (s: string) => s.split("\n")[0].trim();

/** The steps a node of a loop, a pipeline or a breakpoint may take: every step inside it, with where it sits. */
function stepNodes(nodes: FlowNode[], out: Array<{ node: FlowStep; pos: number }> = [], pos: number | null = null): Array<{ node: FlowStep; pos: number }> {
  for (const n of nodes) {
    // The branches of a parallel and the stages of a pipeline run at once, so they share a place.
    const at = pos ?? out.length;
    if (n.t === "step") {
      if (n.body) stepNodes(n.body, out, pos);
      out.push({ node: n, pos: pos ?? out.length });
    } else if (n.t === "loop") stepNodes(n.body, out, pos);
    else if (n.t === "if") stepNodes([...n.then, ...(n.else ?? [])], out, pos);
    else if (n.t === "parallel") for (const b of n.branches) stepNodes(b, out, at);
    else if (n.t === "pipeline") for (const s of n.stages) stepNodes(s, out, at);
  }
  return out;
}

const nodeFor = (nodes: Array<{ node: FlowStep; pos: number }>, e: Entry) =>
  nodes.find(({ node }) => (e.t === "step" ? namesStep(node, e.step.label) : node.kind === "workflow" && namesScope(node, e.scope)));

/** The steps of one run, root or nested, laid over its graph. */
class ScopeRun implements RunHooks {
  used = new Set<Entry>();
  slots: Slot[] = [];
  allowed: Set<Entry> | null = null;
  item: string | undefined;
  /** For each nested run claimed, how many slots came before it, so a question before it reads as passed. */
  scopesAt: number[] = [];
  /** The steps each node took in the rounds before the one the graph shows. */
  earlier = new Map<FlowStep, StepEntry[]>();

  constructor(
    readonly scope: RunScope,
    readonly ctx: Ctx,
  ) {}

  private free(): Entry[] {
    return this.scope.entries.filter((e) => !this.used.has(e) && (!this.allowed || this.allowed.has(e)));
  }

  private within<T>(allowed: Set<Entry>, walk: () => T): T {
    const was = this.allowed;
    this.allowed = allowed;
    try {
      return walk();
    } finally {
      this.allowed = was;
    }
  }

  step(node: FlowStep, leaf: Leaf, w: Walk): Part {
    if (node.kind === "workflow") {
      const free = this.free().filter((e): e is Extract<Entry, { t: "scope" }> => e.t === "scope");
      const hit = free.find((e) => namesScope(node, e.scope)) ?? free[0];
      if (hit) {
        this.used.add(hit);
        this.scopesAt.push(this.slots.length);
        return nestedBox(hit.scope, node, leaf, w, this.ctx);
      }
    }
    const slot: Slot = { node, leaf, allowed: this.allowed, ...(this.item ? { item: this.item } : {}) };
    const hit = this.free().find((e): e is StepEntry => e.t === "step" && namesStep(node, e.step.label));
    if (hit) {
      this.used.add(hit);
      slot.entry = hit;
    }
    this.slots.push(slot);
    return leaf;
  }

  rounds(node: FlowLoop | FlowStep, limit: number | null, body: () => Seq): { body: Seq; sub?: string } {
    const nodes = stepNodes(node.t === "loop" ? node.body : (node.body ?? []));
    const rounds: Array<{ entries: Set<Entry>; seen: Set<FlowStep>; last: number; hits: Array<[FlowStep, Entry]> }> = [];
    for (const e of this.free()) {
      const hit = nodeFor(nodes, e);
      if (!hit) continue;
      let cur = rounds[rounds.length - 1];
      // A step at or before the last one of this round starts the next round.
      if (!cur || cur.seen.has(hit.node) || hit.pos < cur.last) {
        if (limit !== null && rounds.length >= limit) break;
        cur = { entries: new Set(), seen: new Set(), last: 0, hits: [] };
        rounds.push(cur);
      }
      cur.entries.add(e);
      cur.hits.push([hit.node, e]);
      cur.seen.add(hit.node);
      cur.last = hit.pos;
    }
    // The earlier rounds show only as the round count, and as the earlier calls of each step.
    for (const r of rounds.slice(0, -1))
      for (const [n, e] of r.hits) {
        this.used.add(e);
        if (e.t === "step") this.earlier.set(n, [...(this.earlier.get(n) ?? []), e]);
      }
    const latest = rounds[rounds.length - 1]?.entries ?? new Set<Entry>();
    const seq = this.within(latest, body);
    if (node.t !== "loop" || !rounds.length) return { body: seq };
    return { body: seq, sub: `round ${rounds.length}${limit !== null ? ` of ${limit}` : ""}` };
  }

  items(node: FlowPipeline, lane: (i: number) => Seq): Seq[] | null {
    const nodes = stepNodes(node.stages.flat());
    const items = new Map<string, Set<Entry>>();
    const counts = new Map<FlowStep, number>();
    for (const e of this.free()) {
      const hit = nodeFor(nodes, e);
      if (!hit) continue;
      const k = counts.get(hit.node) ?? 0;
      counts.set(hit.node, k + 1);
      const made = madePart(hit.node, e.t === "step" ? e.step.label : (e.scope.label ?? ""));
      const id = made ?? `#${k}`;
      if (!items.has(id)) items.set(id, new Set());
      items.get(id)?.add(e);
    }
    if (!items.size) return null;
    return [...items].map(([id, entries], i) => {
      this.item = id.startsWith("#") ? undefined : id;
      try {
        return this.within(entries, () => lane(i));
      } finally {
        this.item = undefined;
      }
    });
  }

  /** The nodes no step named take the next step of their kind, between the steps of the nodes around them. */
  byOrder() {
    const at = (s: Slot | undefined) => s?.entry?.at;
    this.slots.forEach((slot, i) => {
      if (slot.entry) return;
      const before = this.slots.slice(0, i).reverse().find((s) => s.entry);
      const after = this.slots.slice(i + 1).find((s) => s.entry);
      // With no node placed by its name, the text doesn't describe this run.
      if (!before && !after) return;
      const lo = at(before) ?? -Infinity;
      const hi = at(after) ?? Infinity;
      const hit = this.scope.entries.find(
        (e): e is StepEntry =>
          e.t === "step" && !this.used.has(e) && (!slot.allowed || slot.allowed.has(e)) && e.at > lo && e.at < hi && kindFits(slot.node, e.step),
      );
      if (hit) {
        this.used.add(hit);
        slot.entry = hit;
      }
    });
  }

  /** Each node's status, time and step, once every step has its place. */
  finish() {
    const miss: Status = this.ctx.ended ? "skipped" : "queued";
    const open = this.ctx.questions.filter((q) => q.scope === this.scope.id);
    const given = this.ctx.answered.filter((q) => q.scope === this.scope.id);
    const taken = new Set<Question>();
    const later = (i: number) => this.slots.slice(i + 1).some((s) => s.entry && ran(statusOf(s.entry))) || this.scopesAt.some((n) => n > i);
    this.slots.forEach((slot, i) => {
      const { leaf, node, entry } = slot;
      // In a run the agent moves to the tooltip, and a name made at run time shows as it ran.
      const extra = leaf.sub ? `${node.kind === "workflow" ? "workflow" : "agent"} ${leaf.sub}` : "";
      if (entry && node.dynamic) leaf.label = entry.step.label;
      // A step placed by its order, under another name, says the name it ran under.
      const as = entry && !node.dynamic && !namesStep(node, entry.step.label) ? `ran as ${entry.step.label}` : "";
      if (extra || as) leaf.tip = [leaf.label, extra, as].filter(Boolean).join(", ");
      else if (entry && node.dynamic) delete leaf.tip;
      delete leaf.sub;
      delete leaf.retries;
      if (entry) {
        const before = (this.earlier.get(node) ?? []).sort((a, b) => a.at - b.at);
        if (before.length) leaf.calls = [...before.map((e) => e.step.key), entry.step.key];
        const steps = [...before.flatMap((e) => [e.step, ...e.turns]), entry.step, ...entry.turns];
        this.ctx.times.set(leaf, steps);
        leaf.status = statusOf(entry);
        leaf.step = entry.step.key;
        const tries = entry.step.tries ?? 1;
        if (tries > 1) leaf.retries = `↻ ${tries - 1}${node.retries ? ` of ${node.retries}` : ""}`;
        const ms = durationOf([entry.step, ...entry.turns], this.ctx.now);
        if (ms !== null && ran(leaf.status)) leaf.duration = formatDuration(ms);
        const q = open.find((q) => q.step && (q.step === entry.step.name || q.step === entry.step.key));
        if (q) {
          leaf.status = "needs";
          leaf.ask = q.id;
        }
      } else if (node.kind === "ask" || node.kind === "breakpoint") {
        const q = open.find((q) => !q.step && !taken.has(q) && asks(node, q.prompt)) ?? (later(i) ? undefined : open.find((q) => !q.step && !taken.has(q)));
        if (q) {
          taken.add(q);
          leaf.ask = q.id;
          if (node.dynamic) leaf.label = firstLine(q.prompt).replace(/^Breakpoint: /, "").slice(0, 60);
        }
        // Answered on the page, so done, even before the next step starts.
        const was = q ? undefined : given.find((a) => !a.step && !taken.has(a) && asks(node, a.prompt));
        if (was) taken.add(was);
        leaf.status = q ? "needs" : later(i) || was ? "done" : miss;
      } else {
        leaf.status = miss;
        const named = slot.item ? itemLabel(node, slot.item) : null;
        if (named) leaf.label = named;
      }
      if (leaf.status === "needs") leaf.needs = true;
    });
  }
}

/** Whether a question's prompt is this ask or breakpoint, by its title. */
function asks(node: FlowStep, prompt: string): boolean {
  const line = firstLine(prompt).replace(/^Breakpoint: /, "");
  if (node.dynamic) return namesStep({ ...node, kind: "agent" }, line);
  return line === node.label || line.startsWith(node.label);
}

function statusOf(entry: StepEntry): Status {
  return entry.turns.length ? entry.turns[entry.turns.length - 1].status : entry.step.status;
}

/** How long a step and its answer turns took, or have run so far. */
function durationOf(steps: Step[], now: number): number | null {
  let total = 0;
  let any = false;
  for (const s of steps) {
    const start = s.startedAt ? Date.parse(s.startedAt) : NaN;
    const ms = s.durationMs ?? (Number.isFinite(start) ? (s.endedAt ? Date.parse(s.endedAt) : now) - start : NaN);
    if (Number.isFinite(ms)) {
      total += Math.max(0, ms);
      any = true;
    }
  }
  return any ? total : null;
}

/** The parts of one run over the nodes of its text, or null when a step finds no node. */
function overlayScope(nodes: FlowNode[], scope: RunScope, ctx: Ctx, w: Omit<Walk, "hooks">, key: string): Seq | null {
  const run = new ScopeRun(scope, ctx);
  const seq = seqOf(nodes, { ...w, hooks: run }, key);
  run.byOrder();
  if (scope.entries.some((e) => !run.used.has(e))) return null;
  run.finish();
  return seq;
}

/** A nested run: a box with its name, and its steps over its own workflow's graph, or as they ran. */
function nestedBox(scope: RunScope, node: FlowStep | null, leaf: Leaf | null, w: Walk, ctx: Ctx): Box {
  const key = leaf ? leaf.key : `${w.path}/${scope.id}`;
  const name = scope.workflow ?? node?.workflow;
  const flow = name ? ctx.flows[name] : undefined;
  const inner = { flows: ctx.flows, args: {}, path: `${key}>`, inside: name ? [...w.inside, name] : w.inside };
  const deep = !!name && (w.inside.includes(name) || w.inside.length >= 3);
  const body = (flow && !deep ? overlayScope(flow.nodes, scope, ctx, inner, `${key}>`) : null) ?? asRan(scope, ctx, inner);
  const title = scope.label ?? leaf?.label ?? name ?? "workflow";
  const sub = name && name !== title ? name : undefined;
  return {
    t: "box",
    key,
    kind: "workflow",
    title,
    ...(sub ? { sub, foldSub: sub } : {}),
    tip: name ? `Workflow ${name}` : title,
    body,
    foldable: true,
    auto: true,
    ...(node ? { node: node.id } : {}),
  };
}

/** A run's own steps in the order they ran, each nested run in its box. */
function asRan(scope: RunScope, ctx: Ctx, w: Omit<Walk, "hooks">): Seq {
  const items: Part[] = scope.entries.map((e) => {
    if (e.t === "scope") return nestedBox(e.scope, null, null, w, ctx);
    const steps = [e.step, ...e.turns];
    const status = statusOf(e);
    const ms = durationOf(steps, ctx.now);
    const tries = e.step.tries ?? 1;
    const leaf: Leaf = {
      t: "leaf",
      key: `${w.path}/${e.step.key}`,
      label: e.step.label,
      kind: e.step.kind === "agent" ? "agent" : "sh",
      status,
      step: e.step.key,
      ...(ms !== null && ran(status) ? { duration: formatDuration(ms) } : {}),
      ...(tries > 1 ? { retries: `↻ ${tries - 1}` } : {}),
      ...(status === "needs" ? { needs: true } : {}),
    };
    ctx.times.set(leaf, steps);
    return leaf;
  });
  return { t: "seq", key: `${w.path}/ran`, items };
}

/** A status for a box from the statuses inside it: what needs the person first, then a failure, then what runs. */
function rollup(list: Status[], ctx: Ctx): Status {
  const miss: Status = ctx.ended ? "skipped" : "queued";
  if (!list.length) return miss;
  for (const s of ["needs", "failed", "running", "paused", "stopped"] as const) if (list.includes(s)) return s;
  if (list.every((s) => !ran(s))) return list.includes("queued") ? "queued" : "skipped";
  if (list.every((s) => s === "done" || s === "skipped")) return "done";
  return ctx.ended ? "done" : "running";
}

/** Fills each workflow and pipeline box from what is inside it: its status, its time, and whether it waits on the person. */
function fillBoxes(part: Part, ctx: Ctx): Leaf[] {
  if (part.t === "leaf") return [part];
  const leaves = kidsOf(part).flatMap((k) => fillBoxes(k, ctx));
  if (part.t !== "box" || part.kind === "loop") return leaves;
  const statuses = leaves.map((l) => l.status ?? "queued");
  part.status = part.body ? rollup(statuses, ctx) : ctx.ended ? "skipped" : "queued";
  part.needs = statuses.includes("needs") || undefined;
  part.bad = (!part.needs && statuses.includes("failed")) || undefined;
  if (part.kind === "pipeline") part.folded = !part.needs;
  const steps = leaves.flatMap((l) => ctx.times.get(l) ?? []);
  const starts = steps.map((s) => (s.startedAt ? Date.parse(s.startedAt) : NaN)).filter(Number.isFinite);
  if (starts.length && ran(part.status)) {
    const ends = steps.map((s) => {
      const start = s.startedAt ? Date.parse(s.startedAt) : NaN;
      if (s.endedAt) return Date.parse(s.endedAt);
      return s.durationMs !== undefined && Number.isFinite(start) ? start + s.durationMs : ctx.now;
    });
    part.duration = formatDuration(Math.max(...ends) - Math.min(...starts));
  }
  return leaves;
}

/** The graph of a run: over its text when every step finds its node, else as the steps ran. */
export function runGraph(input: RunInput): RunGraph {
  const ctx: Ctx = {
    flows: input.flows ?? {},
    args: input.args ?? {},
    // A question answered on the page is no longer open, even while the server still lists it.
    questions: (input.questions ?? []).filter((q) => !input.answered?.some((a) => a.id === q.id)),
    answered: input.answered ?? [],
    now: input.now ?? Date.now(),
    ended: !!input.status && isEnded(input.status),
    times: new Map(),
  };
  const root = runScopes(input.steps, input.nested);
  // A run with no step yet takes its id from a question it asks.
  if (!root.id) root.id = ctx.questions[0]?.runId ?? "";
  const w = { flows: ctx.flows, args: ctx.args, path: "", inside: [] };
  const over = input.flow ? overlayScope(input.flow.nodes, root, ctx, w, "graph") : null;
  const seq = over ?? { ...asRan(root, ctx, w), key: "graph" };
  fillBoxes(seq, ctx);
  return { graph: withMarks(seq), asRan: !over };
}

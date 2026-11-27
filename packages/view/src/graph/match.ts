// How the engine names a step at run time, so a run's steps find their node in the graph of the
// text. Read from the engine itself: packages/engine/src/sous-globals.ts names each call,
// runs/records.ts prefixes a nested run's steps, and display.ts keeps only agent and code calls as
// steps. ask and breakpoint wait as questions, under the label "checkpoint". A room's turns are
// steps under their members' labels, each tagged with its room's name and call (room/room.ts).
import type { FlowStep, NestedRun, RoomTag, Step } from "../api/contract.ts";

/** A run's step. */
export interface StepEntry {
  t: "step";
  step: Step;
  at: number;
}

/** A nested run, in the place of its first step. */
export interface ScopeEntry {
  t: "scope";
  scope: RunScope;
  at: number;
}

/** One room() call, in the place of its first turn, with every turn of its members. */
export interface RoomEntry {
  t: "room";
  room: RoomTag;
  turns: StepEntry[];
  at: number;
}

export type Entry = StepEntry | ScopeEntry | RoomEntry;

/** The steps and nested runs of one run, root or nested, in the order they started. */
export interface RunScope {
  id: string;
  /** What the script called it, such as "ticket A". */
  label?: string;
  workflow?: string;
  entries: Entry[];
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const EXPR = /\{[^{}]*\}/g;

/** The run-time labels a template such as "ticket {t.id}" makes, with each part made at run time captured. */
function templateTest(label: string): RegExp {
  return new RegExp(`^${label.split(EXPR).map((s) => s.replace(ESCAPE, "\\$&")).join("(.+?)")}$`);
}

/** What a part made at run time shows: the name of a plain value, else an ellipsis. */
export function shownLabel(node: FlowStep): string {
  if (!node.dynamic) return node.label;
  return node.label.replace(EXPR, (m) => {
    const expr = m.slice(1, -1).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(expr)) return expr;
    const path = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/.test(expr) ? expr.split(".").pop() : null;
    return path === "length" ? "N" : (path ?? "…");
  });
}

/** The node takes no label, so the engine names its step by its kind. */
const unlabeled = (node: FlowStep) => node.label === node.kind;
const waits = (node: FlowStep) => node.kind === "ask" || node.kind === "breakpoint";

/** Whether the engine gives this node's step this label: the same label, the same template, or the name of its kind. */
export function namesStep(node: FlowStep, label: string): boolean {
  if (waits(node)) return label === "checkpoint";
  if (node.kind === "workflow") return false;
  if (node.dynamic) return templateTest(node.label).test(label);
  if (label === node.label) return true;
  if (!unlabeled(node)) return false;
  switch (node.kind) {
    case "agent":
      return /^(?:.+ )?agent \d+$/.test(label) || /^asking-agent-\d+$/.test(label);
    case "sh":
    case "run":
    case "wait":
      return label.startsWith(`${node.kind}: `);
    default:
      return false;
  }
}

/** The part of a run-time label its template made, such as "A" of "ticket A", to tell a pipeline's items apart. */
export function madePart(node: FlowStep, label: string): string | null {
  if (!node.dynamic) return null;
  const m = templateTest(node.label).exec(label);
  return m ? m.slice(1).join(" ") : null;
}

/** A template's name for one item of a pipeline, such as "test {name}" for the item "zod": "test zod". */
export function itemLabel(node: FlowStep, item: string): string | null {
  const parts = node.label.match(EXPR);
  return node.dynamic && parts?.length === 1 ? node.label.replace(EXPR, item) : null;
}

/** Whether the engine names this room node's room this: the same name, the same template, or any name for a room the text leaves unnamed. */
export function namesRoom(node: FlowStep, name: string): boolean {
  if (node.kind !== "room") return false;
  if (node.dynamic) return templateTest(node.label).test(name);
  return name === node.label || unlabeled(node);
}

/** A step of the same kind, for a match by order: an agent for an agent, a command for code. */
export function kindFits(node: FlowStep, step: Step): boolean {
  if (node.kind === "agent" || node.kind === "choose") return step.kind === "agent";
  if (node.kind === "sh" || node.kind === "js" || node.kind === "py" || node.kind === "run" || node.kind === "wait") return step.kind === "exec";
  return false;
}

/** Whether a nested run is the one this workflow() node started: by its label, else by the workflow's name. */
export function namesScope(node: FlowStep, scope: RunScope): boolean {
  if (scope.label !== undefined) {
    if (node.dynamic ? templateTest(node.label).test(scope.label) : !unlabeled(node) && scope.label === node.label) return true;
  }
  if (!node.workflow) return false;
  return scope.workflow ? scope.workflow === node.workflow : scope.label === node.workflow;
}

/**
 * The run's scopes, from the root: each with its steps and nested runs in the order they started.
 * Without `nested`, each nested run comes from the names of its steps, which the engine prefixes
 * with the labels of the runs they sit in, such as "factory / ticket A: implementer".
 */
export function runScopes(steps: Step[], nested: NestedRun[] = []): RunScope {
  const ids = new Set(nested.map((n) => n.id));
  const rootStep = steps.find((s) => s.name === s.label);
  const rootId = rootStep?.scope ?? nested.find((n) => !ids.has(n.parent))?.parent ?? steps[0]?.scope ?? "";
  const scopes = new Map<string, RunScope & { parent?: string; first: number }>();
  const scopeOf = (id: string) => {
    let s = scopes.get(id);
    if (!s) scopes.set(id, (s = { id, entries: [], first: Infinity }));
    return s;
  };
  scopeOf(rootId);
  for (const n of nested) Object.assign(scopeOf(n.id), { parent: n.parent, label: n.label ?? n.workflow, workflow: n.workflow });
  // Each nested run without a record: its label and its parent from the prefix of its steps' names.
  const prefixes = new Map<string, string>();
  steps.forEach((step) => {
    if (step.scope === rootId || prefixes.has(step.scope) || !step.name.endsWith(`: ${step.label}`)) return;
    prefixes.set(step.scope, step.name.slice(0, -step.label.length - 2));
  });
  const byPrefix = new Map([...prefixes].map(([id, p]) => [p, id]));
  for (const [id, prefix] of prefixes) {
    const s = scopeOf(id);
    if (s.parent !== undefined) continue;
    const names = prefix.split(" / ");
    s.label = names[names.length - 1];
    s.parent = byPrefix.get(names.slice(0, -1).join(" / ")) ?? rootId;
  }
  // The steps, each in its run. A room's turns go into one entry, at its first turn.
  const rooms = new Map<string, RoomEntry>();
  steps.forEach((step, i) => {
    const s = scopeOf(step.scope);
    if (s.id !== rootId && s.parent === undefined) s.parent = rootId;
    s.first = Math.min(s.first, i);
    const entry: StepEntry = { t: "step", step, at: i };
    if (!step.room) return void s.entries.push(entry);
    const id = JSON.stringify([step.scope, step.room.name, step.room.call]);
    const room = rooms.get(id);
    if (room) return void room.turns.push(entry);
    const made: RoomEntry = { t: "room", room: step.room, turns: [entry], at: i };
    rooms.set(id, made);
    s.entries.push(made);
  });
  // Each nested run in its parent, at its first step, and its parent's first step no later.
  const kids = [...scopes.values()].filter((s) => s.id !== rootId);
  const seen = new Set<string>();
  const firstOf = (s: RunScope & { first: number }): number => {
    if (seen.has(s.id)) return s.first;
    seen.add(s.id);
    const inner = kids.filter((k) => k.parent === s.id).map(firstOf);
    s.first = Math.min(s.first, ...inner);
    return s.first;
  };
  firstOf(scopeOf(rootId));
  kids.forEach((s, i) => {
    const parent = scopes.get(s.parent ?? rootId) ?? scopeOf(rootId);
    parent.entries.push({ t: "scope", scope: s, at: Number.isFinite(s.first) ? s.first : steps.length + i });
  });
  for (const s of scopes.values()) s.entries.sort((a, b) => a.at - b.at);
  return scopeOf(rootId);
}

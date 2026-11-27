// A workflow script, parsed once with acorn: its meta, its body, and the names it refers to.
// The parser refuses a script that is not deterministic or whose meta is not a literal.

import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import type { WorkflowMeta, WorkflowMetaPhase } from "../workflow-result.js";
import { boundNames, childrenOf, inputName, isFunction, keyOf, parseWorkflowText, property, SAVED_WORKFLOW_NAME, staticString, type AnyNode } from "./syntax.js";

/** The options of one step as the script writes them: an object that names an agent or MCP
 *  servers, or a send() with the options of its handle. */
export interface StepRefs {
  /** The agent, when the script names it with a string. */
  agentType?: string;
  /** True when the object has an agentType key, whatever its value. */
  setsAgentType: boolean;
  /** The input that names the agent, when the script writes agentType: args.<input>. */
  agentInput?: string;
  /** The model or harness, when the script names it with a string. */
  model?: string;
  /** True when the object has a model key, whatever its value. */
  setsModel: boolean;
  /** The MCP servers the script lists with strings. */
  mcp: string[];
}

/**
 * The names a script refers to, read from its tree in the order they appear. A name made while
 * the script runs is not here. Comments and the text of strings are not read.
 */
export interface ScriptRefs {
  /** The saved workflows it starts, as workflow("name"). */
  workflows: string[];
  /** Each model: "name" in any object, the meta's too. */
  models: string[];
  /** Each object that names an agent or MCP servers, and each send() whose handle does. */
  steps: StepRefs[];
  /** The script files it runs, as run("file"). */
  scripts: string[];
  /** True when a choose() lets an agent pick any saved workflow. */
  choosesAnyWorkflow: boolean;
  /** The ask() and breakpoint() calls the script writes. One in a loop counts once. */
  asks: number;
  /** The step calls the script writes, in order, a send() as an agent call. One in a loop shows
   *  once, and one on another object is none. */
  calls: ScriptCall[];
  /**
   * The agent() and send() calls whose prompt starts with a value made at run time, in order.
   * sous sends a prompt as written, so such a value that starts with "/" runs a slash command. A
   * prompt starts with fixed words when it is a literal, a template whose text before its first
   * ${} is not empty, or a + whose left end does.
   */
  runTimePrompts: PromptRef[];
  /** The room() calls the script writes, with what the text shows of their options. */
  rooms: RoomRef[];
}

/** A room() call: the line it starts on and its options as the text shows them. */
export interface RoomRef {
  line: number;
  options: Seen;
}

/**
 * A value as the text shows it, for the checks of `sous check`. A literal is a string, a number, a
 * boolean or null. A handle is a session() or fork() call, by where it starts in the text, with
 * its literal label. An object holds its keys, unless a spread or a computed key hides some. A
 * list stops at its first spread. "other" is a value the text shows is no handle and no literal,
 * such as a function. Anything made at run time is "unknown".
 */
export type Seen =
  | { t: "literal"; value: string | number | boolean | null }
  | { t: "handle"; at: number; label?: string }
  | { t: "object"; props: Record<string, Seen>; open: boolean }
  | { t: "list"; items: Seen[]; open: boolean }
  | { t: "other" }
  | { t: "unknown" };

/** An agent() or a send() call, by its literal label and the line it starts on. */
export interface PromptRef {
  label?: string;
  line: number;
}

/** One step call as the script writes it. Only literal values are read. */
export interface ScriptCall {
  kind: "agent" | "sh" | "js" | "py" | "ask" | "breakpoint" | "workflow" | "room";
  /** The literal label option, else a send()'s handle's. A label made at run time is left out. */
  label?: string;
  /** The literal first argument of an ask() or a breakpoint(). */
  title?: string;
  /** The literal agentType of an agent call, or of a send()'s handle. */
  agent?: string;
  /** The literal model of an agent call, or of a send(), else of its handle. */
  model?: string;
  /** The skills and the MCP servers an agent call or a send()'s handle lists with strings, when it lists any. */
  skills?: string[];
  mcp?: string[];
  /** The literal label of the session() or fork() handle a send() runs on. */
  session?: string;
  /** The literal name a workflow call starts. */
  workflow?: string;
  /** The literal labels of a room's members, in order. A member made at run time is left out. */
  members?: string[];
}

/** Where each step call takes its options, by the index of its argument. ask and breakpoint take no label. */
const OPTIONS_AT: Record<Exclude<ScriptCall["kind"], "room">, number | undefined> = {
  agent: 1,
  sh: 1,
  js: 2,
  py: 2,
  workflow: 2,
  ask: undefined,
  breakpoint: undefined,
};

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const { meta, body } = parseScript(script);
  return { meta, body };
}

/** The meta, the body and the names the script refers to, from one parse. */
export function readWorkflowScript(script: string): { meta: WorkflowMeta; body: string; refs: ScriptRefs } {
  const { meta, body, ast } = parseScript(script);
  return { meta, body, refs: scriptRefs(ast) };
}

function parseScript(script: string): { meta: WorkflowMeta; body: string; ast: AnyNode } {
  const ast = parseWorkflowText(script);

  // This direct-syntax check provides fast author feedback without chasing aliases.
  // DETERMINISM_PRELUDE remains the authoritative runtime enforcement for aliases,
  // computed access, and other forms that intentionally stay outside this AST check.
  const violation = findDeterminismViolation(ast);
  if (violation) {
    const start = violation.node.loc?.start;
    const location = start ? ` at line ${start.line}, column ${start.column + 1}` : "";
    throw new WorkflowError(
      `Workflow scripts must be deterministic: ${violation.api} is unavailable${location}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "`export const meta = { name, description, phases }` must be the first statement in the script",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init)
    throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
    ast,
  };
}

/** Push a node's children so that the first in the text pops first. */
function pushAstChildren(node: AnyNode, pending: AnyNode[]): void {
  pending.push(...childrenOf(node).reverse());
}

function findDeterminismViolation(ast: AnyNode): { api: string; node: AnyNode } | undefined {
  const pending = [ast];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const api = nondeterministicApi(node);
    if (api) return { api, node };

    pushAstChildren(node, pending);
  }
  return undefined;
}

function nondeterministicApi(node: AnyNode): string | undefined {
  if (
    (node.type === "CallExpression" || node.type === "NewExpression") &&
    node.arguments.length === 0 &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "Date"
  ) {
    return node.type === "NewExpression" ? "new Date()" : "Date()";
  }
  if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression" || node.callee.computed) {
    return undefined;
  }
  const object = node.callee.object as AnyNode;
  const property = node.callee.property as AnyNode;
  if (object.type === "Identifier" && object.name === "Date" && property.type === "Identifier" && property.name === "now") {
    return "Date.now()";
  }
  if (
    object.type === "Identifier" &&
    object.name === "Math" &&
    property.type === "Identifier" &&
    property.name === "random"
  ) {
    return "Math.random()";
  }
  return undefined;
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("meta.model must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const [index, phase] of value.phases.entries()) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error(
          `meta.phases[${index}] must be an object shaped { title: string, detail?: string, model?: string }; phase entries cannot be strings`,
        );
      }
      if ((phase as WorkflowMetaPhase).detail !== undefined && typeof (phase as WorkflowMetaPhase).detail !== "string") {
        throw new Error(`meta.phases[${index}].detail must be a string`);
      }
      if ((phase as WorkflowMetaPhase).model !== undefined && typeof (phase as WorkflowMetaPhase).model !== "string") {
        throw new Error(`meta.phases[${index}].model must be a string`);
      }
    }
  }
  // meta.backends declared ACP backends that no step ran.
  if ((value as { backends?: unknown }).backends !== undefined) {
    throw new Error("meta.backends is gone. No step ran on it. Remove it from meta.");
  }
}

/** True when the first characters of a prompt come from a value made at run time. A missing
 *  prompt is not one. A ? : starts at run time when either branch does. */
function startsAtRunTime(node: AnyNode | undefined): boolean {
  switch (node?.type) {
    case undefined:
    case "Literal":
      return false;
    case "TemplateLiteral":
      return node.expressions.length > 0 && (node.quasis[0].value.cooked ?? node.quasis[0].value.raw) === "";
    case "BinaryExpression":
      return node.operator === "+" ? startsAtRunTime(node.left) : true;
    case "ConditionalExpression":
      return startsAtRunTime(node.consequent) || startsAtRunTime(node.alternate);
    default:
      return true;
  }
}

/** The skills and the MCP servers a call lists with strings, when it lists any. */
function listsOf(call: ScriptCall, option: (key: string) => AnyNode | undefined): void {
  for (const key of ["skills", "mcp"] as const) {
    const list = option(key);
    const names = list?.type === "ArrayExpression" ? (list.elements as AnyNode[]).map(staticString).filter((name): name is string => Boolean(name)) : [];
    if (names.length) call[key] = [...new Set(names)];
  }
}

/** What each name the script declares is set to, when the script sets it once, anywhere: in its
 *  declaration, or as a function it declares. Null for a name it declares with no value, declares
 *  twice, or assigns again, since the script sets that one at run time. */
type Names = Map<string, AnyNode | null>;

function declaredNames(ast: AnyNode): Names {
  const values = new Map<string, AnyNode | null>();
  const writes = new Map<string, number>();
  const write = (name: string, value: AnyNode | null) => {
    writes.set(name, (writes.get(name) ?? 0) + 1);
    values.set(name, value);
  };
  const pending = [ast];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") write(node.id.name, node.init ?? null);
    if (node.type === "FunctionDeclaration" && node.id) write(node.id.name, node);
    if (node.type === "AssignmentExpression") boundNames(node.left).forEach((name) => write(name, null));
    if (node.type === "UpdateExpression" && node.argument.type === "Identifier") write(node.argument.name, null);
    if ((node.type === "ForInStatement" || node.type === "ForOfStatement") && node.left.type !== "VariableDeclaration") boundNames(node.left).forEach((name) => write(name, null));
    pushAstChildren(node, pending);
  }
  const names: Names = new Map();
  for (const [name, count] of writes) names.set(name, count === 1 ? (values.get(name) ?? null) : null);
  return names;
}

/** The node a name stands for, else the node itself. */
function resolved(node: AnyNode | undefined, names: Names): AnyNode | undefined {
  return node?.type === "Identifier" ? (names.get(node.name) ?? undefined) : node;
}

/** True for <object>.<method>(...). */
function isMethod(node: AnyNode, method: string): boolean {
  const callee = node.callee as AnyNode | undefined;
  return node.type === "CallExpression" && callee?.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" && callee.property.name === method;
}

/** What a send() or a fork() runs on, as the graph's reader (flow.ts) finds it. The session() or
 *  fork() call that makes the handle, when the script writes it in place or keeps it in a name set
 *  once. "none" when the script shows the target is no handle: an object, an array, a new
 *  expression, a literal, a function, or the result of a call to a function the script does not
 *  declare, other than session() and fork(). Undefined when the script makes it at run time, such
 *  as a parameter, a name assigned more than once, or the result of a function it declares. */
function handleCall(target: AnyNode, names: Names, depth = 0): AnyNode | "none" | undefined {
  const unwrapped = target.type === "AwaitExpression" ? (target.argument as AnyNode) : target;
  let node = unwrapped.type === "Identifier" ? names.get(unwrapped.name) : unwrapped;
  if (node === undefined || node === null) return undefined;
  if (node.type === "AwaitExpression") node = node.argument as AnyNode;
  if (node.type === "FunctionDeclaration" || isFunction(node)) return "none";
  switch (node.type) {
    case "CallExpression": {
      const callee = node.callee as AnyNode;
      if (callee.type === "Identifier" && names.has(callee.name)) return undefined;
      if (callee.type === "Identifier" && callee.name === "session") return node;
      if (!isMethod(node, "fork")) return "none";
      if (depth > 20) return undefined;
      return handleCall(callee.object, names, depth + 1) === "none" ? "none" : node;
    }
    case "ObjectExpression":
    case "ArrayExpression":
    case "NewExpression":
    case "Literal":
    case "TemplateLiteral":
    case "ClassExpression":
      return "none";
    default:
      return undefined;
  }
}

/** The options objects of the handle a send() or a fork() is called on: a session({...}), then
 *  each fork({...}), so a later one wins. Undefined when the script makes the handle at run time. */
function handleObjects(target: AnyNode, names: Names, depth = 0): AnyNode[] | undefined {
  const call = handleCall(target, names);
  if (!call || call === "none" || depth > 20) return undefined;
  const own = resolved(call.arguments[0] as AnyNode | undefined, names);
  if (call.callee.type === "Identifier" && call.callee.name === "session") return own?.type === "ObjectExpression" ? [own] : undefined;
  if (!isMethod(call, "fork")) return undefined;
  const parent = handleObjects(call.callee.object, names, depth + 1);
  if (!call.arguments.length) return parent;
  return own?.type === "ObjectExpression" ? [...(parent ?? []), own] : undefined;
}

/** A send() as an agent call: its own label and model, else its handle's, and its handle's agent,
 *  skills and MCP servers. Also the options check reads, when the handle names an agent or MCP servers. */
function sendCall(node: AnyNode, names: Names): { call: ScriptCall; refs?: StepRefs } {
  const options = node.arguments[1] as AnyNode | undefined;
  const handle = handleObjects(node.callee.object, names) ?? [];
  const objects = [...handle, ...(options?.type === "ObjectExpression" ? [options] : [])];
  // The last object that writes the key, the send's own first.
  const option = (key: string) => objects.reduce<AnyNode | undefined>((found, object) => property(object, key) ?? found, undefined);
  const call: ScriptCall = { kind: "agent" };
  const label = staticString(option("label"));
  const session = staticString(handle.reduce<AnyNode | undefined>((found, object) => property(object, "label") ?? found, undefined));
  const agent = staticString(option("agentType"));
  const model = staticString(option("model"));
  if (label !== undefined) call.label = label;
  if (agent !== undefined) call.agent = agent;
  if (model !== undefined) call.model = model;
  listsOf(call, option);
  if (session !== undefined) call.session = session;
  if (!option("agentType") && !option("mcp")) return { call };
  const servers = option("mcp");
  const input = inputName(option("agentType"));
  const refs: StepRefs = {
    ...(agent ? { agentType: agent } : {}),
    setsAgentType: option("agentType") !== undefined,
    ...(input ? { agentInput: input } : {}),
    ...(model ? { model } : {}),
    setsModel: option("model") !== undefined,
    mcp: [...new Set((servers?.type === "ArrayExpression" ? (servers.elements as AnyNode[]).map(staticString) : []).filter((name): name is string => Boolean(name)))],
  };
  return { call, refs };
}

/** The step a call writes, or nothing when the callee is not a step. */
function scriptCall(node: AnyNode): ScriptCall | undefined {
  const kind = node.callee.name as keyof typeof OPTIONS_AT;
  if (!Object.hasOwn(OPTIONS_AT, kind)) return undefined;
  const call: ScriptCall = { kind };
  const at = OPTIONS_AT[kind];
  const options = at === undefined ? undefined : (node.arguments[at] as AnyNode | undefined);
  const option = (key: string) => (options?.type === "ObjectExpression" ? property(options, key) : undefined);
  const label = staticString(option("label"));
  if (label !== undefined) call.label = label;
  if (kind === "ask" || kind === "breakpoint") {
    const title = staticString(node.arguments[0]);
    if (title !== undefined) call.title = title;
  }
  if (kind === "agent") {
    const agent = staticString(option("agentType"));
    const model = staticString(option("model"));
    if (agent !== undefined) call.agent = agent;
    if (model !== undefined) call.model = model;
    listsOf(call, option);
  }
  if (kind === "workflow") {
    const name = staticString(node.arguments[0]);
    if (name !== undefined && SAVED_WORKFLOW_NAME.test(name)) call.workflow = name;
  }
  return call;
}

/** What the text shows of a value. A name set once reads as its value. */
function seen(node: AnyNode | undefined | null, names: Names, depth = 0): Seen {
  if (!node || depth > 20) return { t: "unknown" };
  const call = handleCall(node, names);
  if (call && call !== "none") {
    const label = staticString(handleObjects(node, names)?.reduce<AnyNode | undefined>((found, object) => property(object, "label") ?? found, undefined));
    return { t: "handle", at: call.start, ...(label === undefined ? {} : { label }) };
  }
  const value = resolved(node, names);
  if (!value) return { t: "unknown" };
  const text = staticString(value);
  if (text !== undefined) return { t: "literal", value: text };
  if (value.type === "Literal" && !(value.value instanceof RegExp)) return { t: "literal", value: value.value };
  if (value.type === "UnaryExpression" && value.operator === "-" && typeof value.argument.value === "number") return { t: "literal", value: -value.argument.value };
  if (value.type === "ObjectExpression") {
    const props: Record<string, Seen> = {};
    let open = false;
    for (const item of value.properties as AnyNode[]) {
      const key = item.type === "Property" ? keyOf(item) : undefined;
      if (key === undefined) open = true;
      else props[key] = seen(item.value, names, depth + 1);
    }
    return { t: "object", props, open };
  }
  if (value.type === "ArrayExpression") {
    const items: Seen[] = [];
    for (const item of value.elements as Array<AnyNode | null>) {
      if (item?.type === "SpreadElement") return { t: "list", items, open: true };
      items.push(seen(item, names, depth + 1));
    }
    return { t: "list", items, open: false };
  }
  // A call may return a handle, a list or an object, so only a function or a class is known to be none of them.
  return value.type === "FunctionDeclaration" || value.type === "ClassExpression" || isFunction(value) ? { t: "other" } : { t: "unknown" };
}

/** A room() as a step call: its literal name as its label, and its members' literal labels. */
function roomCall(options: Seen): ScriptCall {
  const call: ScriptCall = { kind: "room" };
  const props = options.t === "object" ? options.props : {};
  const name = props["name"];
  if (name?.t === "literal" && typeof name.value === "string" && name.value.trim()) call.label = name.value.trim();
  const members = props["members"];
  const labels = (members?.t === "list" ? members.items : []).flatMap((item) => {
    const handle = item.t === "object" ? item.props["session"] : item;
    return handle?.t === "handle" && handle.label !== undefined ? [handle.label] : [];
  });
  if (labels.length) call.members = labels;
  return call;
}

function scriptRefs(ast: AnyNode): ScriptRefs {
  const workflows = new Set<string>();
  const models = new Set<string>();
  const scripts = new Set<string>();
  const steps: StepRefs[] = [];
  let choosesAnyWorkflow = false;
  let asks = 0;
  const calls: ScriptCall[] = [];
  const runTimePrompts: PromptRef[] = [];
  const rooms: RoomRef[] = [];
  const names = declaredNames(ast);
  const pending = [ast];
  while (pending.length > 0) {
    const node = pending.pop()!;
    // A send() on something the script shows is no session handle is no step.
    if (isMethod(node, "send") && handleCall(node.callee.object, names) !== "none") {
      const { call, refs } = sendCall(node, names);
      calls.push(call);
      if (refs) steps.push(refs);
      if (startsAtRunTime(node.arguments[0])) runTimePrompts.push({ ...(call.label === undefined ? {} : { label: call.label }), line: node.loc?.start.line ?? 0 });
    }
    if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
      const first = staticString(node.arguments[0]);
      const callee = node.callee.name;
      const call = scriptCall(node);
      if (call) calls.push(call);
      if (call?.kind === "agent" && startsAtRunTime(node.arguments[0])) {
        runTimePrompts.push({ ...(call.label === undefined ? {} : { label: call.label }), line: node.loc?.start.line ?? 0 });
      }
      if (callee === "workflow" && first && SAVED_WORKFLOW_NAME.test(first)) workflows.add(first);
      if (callee === "run" && first) scripts.add(first);
      if (callee === "ask" || callee === "breakpoint") asks++;
      if (callee === "room" && !names.has("room")) {
        const options = seen(node.arguments[0], names);
        rooms.push({ line: node.loc?.start.line ?? 0, options });
        calls.push(roomCall(options));
      }
      if (callee === "choose") {
        for (const argument of node.arguments as AnyNode[]) {
          const any = argument.type === "ObjectExpression" ? property(argument, "any") : undefined;
          if (any?.type === "Literal" && any.value === true) choosesAnyWorkflow = true;
        }
      }
    }
    if (node.type === "Property" && keyOf(node) === "model") {
      const model = staticString(node.value);
      if (model) models.add(model);
    }
    if (node.type === "ObjectExpression") {
      const agentType = property(node, "agentType");
      const mcp = property(node, "mcp");
      if (agentType || mcp) {
        const model = property(node, "model");
        const agentName = staticString(agentType);
        const input = inputName(agentType);
        const modelName = staticString(model);
        const servers = mcp?.type === "ArrayExpression" ? (mcp.elements as AnyNode[]).map(staticString) : [];
        steps.push({
          ...(agentName ? { agentType: agentName } : {}),
          setsAgentType: agentType !== undefined,
          ...(input ? { agentInput: input } : {}),
          ...(modelName ? { model: modelName } : {}),
          setsModel: model !== undefined,
          mcp: [...new Set(servers.filter((name): name is string => Boolean(name)))],
        });
      }
    }
    pushAstChildren(node, pending);
  }
  return { workflows: [...workflows], models: [...models], steps, scripts: [...scripts], choosesAnyWorkflow, asks, calls, runTimePrompts, rooms };
}

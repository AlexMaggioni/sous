// The graph of a workflow's text: its steps in the order they run, with the loops, branches,
// parallel parts and pipelines around them. The page draws it for a saved workflow, and lays a
// run's steps over it by label. It reads only the text it is given, and never throws.

import { stepOptions } from "./step-options.js";
import { boundNames, childrenOf, givenCalls, isFunction, parseWorkflowText, property, returned, SAVED_WORKFLOW_NAME, staticString, type AnyNode } from "./syntax.js";

// The types below are the "Flow" section of packages/view/src/api/contract.ts, field for field.
// The server passes this tree where the contract's type is expected.

export interface Flow {
  nodes: FlowNode[];
  /** What the reader could not place, such as a label made at run time. */
  notes: string[];
}

export type FlowNode = FlowStep | FlowLoop | FlowIf | FlowEnd | FlowParallel | FlowPipeline;

export type StepKind = "agent" | "sh" | "js" | "py" | "run" | "wait" | "ask" | "checkpoint" | "breakpoint" | "workflow" | "choose";

interface FlowBase {
  /** Unique in the flow, stable while the text does not change. */
  id: string;
  /** The 1-based line of the text it starts on. */
  line: number;
}

export interface FlowStep extends FlowBase {
  t: "step";
  kind: StepKind;
  /** The literal label, else the title of an ask, a breakpoint or a checkpoint, else the kind. */
  label: string;
  /** The literal agentType of an agent step. */
  agent?: string;
  model?: string;
  /** The literal `retries` option. */
  retries?: number;
  /** The saved workflow a workflow() step starts. */
  workflow?: string;
  /** The step a breakpoint runs before it waits for the person. */
  body?: FlowNode[];
  /** The label was made at run time, so a run's steps can't be matched to it by name. */
  dynamic?: true;
  /** The phase it runs in: its own `phase` option, else the last phase() call before it in the text. */
  phase?: string;
  /** An agent's or a choose's prompt, as the text writes it, with each expression as {source}. */
  prompt?: string;
  /**
   * A code step's text as the text writes it, with each expression as {source}: the command of
   * sh and waitUntil, the source of js and py, the file of run.
   */
  code?: string;
  /** The name the text keeps its result under, such as "review" in `const review = await agent(...)`. */
  result?: string;
  /**
   * What it reads, in the order the text names them: the result names of earlier steps, the
   * inputs as "args.<name>", and the parameters of the callback it sits in, such as "feedback".
   */
  reads?: string[];
  /** The options the text gives it literally. One the text makes at run time is left out. */
  options?: StepOptions;
}

/** The options of a step that shape what it does, as the text writes them. */
export interface StepOptions {
  timeout?: string;
  effort?: string;
  /** The harness's permission mode. */
  mode?: string;
  isolation?: "worktree";
  skills?: string[];
  mcp?: string[];
  keepSession?: true;
  /** The label of the earlier step whose session it goes on in, from `continue`. */
  continues?: string;
  /** `ask: true`: the agent may stop with a question for the person. */
  asks?: true;
  answeredBy?: "people" | "anyone";
  /** The field names of its schema, when the text writes them. */
  schema?: string[];
  allowFail?: true;
  /** The choices of an ask or a select checkpoint. */
  choices?: string[];
  /** A checkpoint's kind. */
  answer?: "confirm" | "input" | "select";
  /** How many times a breakpoint's step can be sent back. */
  max?: number;
  /** How often waitUntil checks. */
  every?: string;
  /** The inputs a workflow() step passes, each as the text writes it. */
  inputs?: Record<string, string>;
  /** Where a workflow() step's run works. */
  place?: string;
  /** What a choose may pick from. */
  steps?: string[];
  workflows?: string[];
  any?: true;
}

export interface FlowLoop extends FlowBase {
  t: "loop";
  loop: "gate" | "retry" | "for" | "while";
  /** What a for or a while loop goes over, or its condition, as the text writes it. */
  label?: string;
  /** The attempts of a gate or a retry as the text gives them, such as "3" or "args.rounds". */
  limit?: string;
  /** A gate's check or a retry's until, as the text writes it, such as "(r) => r.ok". */
  until?: string;
  body: FlowNode[];
}

export interface FlowIf extends FlowBase {
  t: "if";
  /** The condition as the text writes it. A catch block's is "error". */
  cond: string;
  then: FlowNode[];
  else?: FlowNode[];
}

/** A return before the end of the text: the workflow ends here. */
export interface FlowEnd extends FlowBase {
  t: "end";
}

export interface FlowParallel extends FlowBase {
  t: "parallel";
  branches: FlowNode[][];
}

export interface FlowPipeline extends FlowBase {
  t: "pipeline";
  /** The items it runs over, as the text writes them. */
  over: string;
  /** Each stage's steps, in order. Each item goes through every stage. */
  stages: FlowNode[][];
}

interface StepSpec {
  kind: StepKind;
  /** The argument that holds the step's options. */
  options?: number;
  /** ask, checkpoint and breakpoint take no label. Their first argument, the title, names them. */
  titled?: true;
  /** What the first argument is: an agent's prompt, or a code step's command, source or file. */
  first?: "prompt" | "code";
}

/** Each step function and the kind of step it makes. */
const STEPS = new Map<string, StepSpec>([
  ["agent", { kind: "agent", options: 1, first: "prompt" }],
  ["sh", { kind: "sh", options: 1, first: "code" }],
  ["js", { kind: "js", options: 2, first: "code" }],
  ["py", { kind: "py", options: 2, first: "code" }],
  ["run", { kind: "run", options: 1, first: "code" }],
  ["waitUntil", { kind: "wait", options: 1, first: "code" }],
  ["choose", { kind: "choose", options: 1, first: "prompt" }],
  ["workflow", { kind: "workflow", options: 2 }],
  ["ask", { kind: "ask", options: 1, titled: true }],
  ["checkpoint", { kind: "checkpoint", options: 1, titled: true }],
  // A breakpoint with no step takes its options second.
  ["breakpoint", { kind: "breakpoint", options: 2, titled: true }],
]);

/** The Promise functions that start every promise of a list at once. */
const PROMISE_GROUPS = new Set(["all", "allSettled", "race", "any"]);

/** The array methods that call their function for every item at once, when it runs a step. */
const PER_ITEM = new Set(["map", "forEach", "flatMap"]);

/** How many functions deep the reader inlines a call. */
const MAX_DEPTH = 3;

/** A function the text keeps in a name, and the names it sees where it is written. */
interface Known {
  fn: AnyNode;
  scope: Scope;
}

interface Scope {
  names: Map<string, Known>;
  /** What its const names are set to, such as a schema the text keeps in a name. */
  values: Map<string, AnyNode>;
  /** The names a function's parameters, a loop's variable or a catch's error give here. */
  bound?: Set<string>;
  parent?: Scope;
}

/** Where the reader stands in the text. */
interface At {
  /** The offsets of the inlined calls around this point, so a function inlined twice gets new ids. */
  path: string;
  /** The functions inlined around this point, outermost first. */
  inlined: AnyNode[];
  scope: Scope;
  /** True outside every function, where a return ends the workflow. */
  top: boolean;
  /** True inside the options of a choose(), whose steps run only when the agent picks them. */
  choosing?: true;
}

/** The flow of a workflow's text. A text that does not parse gives no node and a note that says why. */
export function workflowFlow(script: string): Flow {
  let program: AnyNode;
  try {
    program = parseWorkflowText(script);
  } catch (error) {
    return { nodes: [], notes: [`The text does not parse: ${reasonOf(error)}`] };
  }
  try {
    return new FlowReader(String(script)).program(program);
  } catch (error) {
    // Such as a text nested deeper than the stack allows. The page then shows the steps as they ran.
    return { nodes: [], notes: [`The text could not be read: ${reasonOf(error)}`] };
  }
}

class FlowReader {
  private readonly notes = new Set<string>();
  /** The agent of each step read so far, by its literal label. */
  private readonly agents = new Map<string, string>();
  /** The name the text keeps a step call's result under, by the call. */
  private readonly results = new Map<AnyNode, string>();
  /** The result names of the steps read so far. */
  private readonly kept = new Set<string>();
  /**
   * The title of the last phase() call read. The reader goes through the text in order and reads
   * a function where it is called, so a phase() in a branch holds after the branch too, and one in
   * a function holds from where the function is called.
   */
  private phase?: string;

  constructor(private readonly text: string) {}

  program(program: AnyNode): Flow {
    const body = program.body as AnyNode[];
    const scope = hoist(body, undefined);
    const at: At = { path: "", inlined: [], scope, top: true };
    // The workflow ends after its last statement anyway, so a return there is no end node.
    let last = body.length - 1;
    while (last >= 0 && (body[last].type === "FunctionDeclaration" || body[last].type === "EmptyStatement")) last--;
    const nodes = body.flatMap((statement, index) =>
      index === last && statement.type === "ReturnStatement" ? this.expression(statement.argument, at) : this.statement(statement, at),
    );
    return { nodes: uniqueIds(nodes), notes: [...this.notes] };
  }

  private statements(statements: AnyNode[], at: At): FlowNode[] {
    const inner = { ...at, scope: hoist(statements, at.scope) };
    return statements.flatMap((statement) => this.statement(statement, inner));
  }

  private statement(node: AnyNode, at: At): FlowNode[] {
    switch (node.type) {
      case "ExpressionStatement":
        return this.expression(node.expression, at);
      case "VariableDeclaration":
        // A function kept in a name runs where it is called, so it is read there.
        return (node.declarations as AnyNode[]).flatMap((declarator) => {
          if (declarator.id?.type === "Identifier" && isFunction(declarator.init)) return [];
          this.keep(declarator.id, declarator.init);
          return this.expression(declarator.init, at);
        });
      case "ReturnStatement":
        return [...this.expression(node.argument, at), ...(at.top ? [{ t: "end" as const, id: this.id("end", node, at), line: lineOf(node) }] : [])];
      case "ThrowStatement":
        return this.expression(node.argument, at);
      case "BlockStatement":
        return this.statements(node.body, at);
      case "IfStatement": {
        const before = this.expression(node.test, at);
        const then = this.statement(node.consequent, at);
        const otherwise = node.alternate ? this.statement(node.alternate, at) : [];
        return [...before, ...this.ifNode(node, this.src(node.test), then, otherwise, at)];
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        return this.loop(node, at);
      case "TryStatement":
        return this.tryStatement(node, at);
      case "SwitchStatement":
        return this.switchStatement(node, at);
      case "LabeledStatement":
        return this.statement(node.body, at);
      // The meta and any other import or export run no step.
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
      case "ExportAllDeclaration":
      case "FunctionDeclaration":
      case "EmptyStatement":
      case "BreakStatement":
      case "ContinueStatement":
      case "DebuggerStatement":
        return [];
      default:
        return this.expression(node, at);
    }
  }

  private expression(node: AnyNode | null | undefined, at: At): FlowNode[] {
    if (!node) return [];
    if (node.type === "AssignmentExpression" && node.operator === "=") this.keep(node.left, node.right);
    switch (node.type) {
      case "CallExpression":
        return this.call(node, at);
      case "ConditionalExpression": {
        const before = this.expression(node.test, at);
        const then = this.expression(node.consequent, at);
        const otherwise = this.expression(node.alternate, at);
        return [...before, ...this.ifNode(node, this.src(node.test), then, otherwise, at)];
      }
      case "LogicalExpression":
        return this.logical(node, at);
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        // Written here but called elsewhere, by code the reader does not know.
        this.lost(node, at);
        return [];
      default:
        // Anything else runs its parts in the order the text writes them.
        return childrenOf(node).flatMap((child) => (/(Statement|Declaration)$/.test(child.type) ? this.statement(child, at) : this.expression(child, at)));
    }
  }

  private call(node: AnyNode, at: At): FlowNode[] {
    const callee = node.callee as AnyNode;
    if (callee.type === "Identifier") {
      const known = lookup(at.scope, callee.name);
      if (known) return [...this.list(node.arguments, at), ...this.inline(known, callee.name, node, at)];
      const spec = STEPS.get(callee.name);
      if (spec) return this.step(node, spec, at);
      if (callee.name === "parallel") return this.parallel(node, at, true);
      if (callee.name === "pipeline") return this.pipeline(node, at);
      if (callee.name === "gate" || callee.name === "retry") return this.repeat(node, callee.name, at);
      if (callee.name === "phase" && node.arguments[0]) this.phase = this.rendered(node.arguments[0]);
    } else if (isFunction(callee)) {
      return [...this.list(node.arguments, at), ...this.body(callee, at)];
    } else if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
      const method = callee.property.name as string;
      const promise = callee.object.type === "Identifier" && callee.object.name === "Promise";
      if (promise && PROMISE_GROUPS.has(method)) return this.parallel(node, at, false);
      if (PER_ITEM.has(method)) return this.perItem(node, at, false);
      if (method === "then" || method === "catch" || method === "finally") return this.chained(node, method, at);
    }
    return [...this.expression(callee, at), ...this.list(node.arguments, at)];
  }

  private step(node: AnyNode, spec: StepSpec, at: At): FlowNode[] {
    const args = node.arguments as AnyNode[];
    const { kind } = spec;
    // A breakpoint's second argument may be the step it runs before it waits.
    const body = kind === "breakpoint" ? this.runs(args[1], at) : undefined;
    const argsAt: At = kind === "choose" ? { ...at, choosing: true } : at;
    const before = args.flatMap((arg, index) => (index === 1 && body ? [] : this.expression(arg, argsAt)));
    const step: FlowStep = { t: "step", id: this.id("s", node, at), line: lineOf(node), kind, label: kind };
    const options = kind === "breakpoint" && args[1]?.type === "ObjectExpression" ? args[1] : spec.options === undefined ? undefined : args[spec.options];
    const object = options?.type === "ObjectExpression" ? options : undefined;
    const labelNode = spec.titled ? args[0] : object && property(object, "label");
    if (labelNode) this.label(step, labelNode);
    const spread = object?.properties.find((item: AnyNode) => item.type === "SpreadElement")?.argument as AnyNode | undefined;
    const unread = options && !object ? options : spread;
    if (!labelNode && unread) this.note(`The ${kind} step on line ${step.line} takes options from ${this.src(unread)}, so its label is not known.`);
    // A step that goes on in an earlier step's session runs that step's agent.
    const continues = staticString(object && property(object, "continue"));
    const agent = staticString(object && property(object, "agentType")) ?? (continues === undefined ? undefined : this.agents.get(continues));
    if (agent !== undefined) {
      step.agent = agent;
      if (!step.dynamic) this.agents.set(step.label, agent);
    }
    const model = staticString(object && property(object, "model"));
    if (model !== undefined) step.model = model;
    const retries = object && property(object, "retries");
    if (retries?.type === "Literal" && typeof retries.value === "number") step.retries = retries.value;
    if (kind === "workflow") {
      const name = staticString(args[0]);
      if (name !== undefined && SAVED_WORKFLOW_NAME.test(name)) step.workflow = name;
      if (name === undefined && args[0]) this.note(`The workflow step on line ${step.line} starts a workflow named at run time.`);
    }
    if (body?.length) step.body = body;
    this.describe(step, node, spec, object, at);
    return [...before, step];
  }

  /** What the step panel says of a step: its phase, its prompt or code, the name of its result,
   *  what it reads and its options. */
  private describe(step: FlowStep, node: AnyNode, spec: StepSpec, object: AnyNode | undefined, at: At): void {
    const args = node.arguments as AnyNode[];
    const own = object && property(object, "phase");
    const phase = own ? this.rendered(own) : this.phase;
    if (phase !== undefined) step.phase = phase;
    if (spec.first && args[0]) step[spec.first] = this.rendered(args[0]);
    const result = this.results.get(node);
    if (result !== undefined) step.result = result;
    const reads = readsOf(args, (name) => this.kept.has(name) || isBound(at.scope, name));
    if (reads.length) step.reads = reads;
    if (result !== undefined) this.kept.add(result);
    const options = stepOptions(step.kind, object, args, { src: (part) => this.src(part), valueOf: (part) => valueOf(at.scope, part) });
    if (options) step.options = options;
  }

  /** Notes the name a step call's result is kept under: `const review = await agent(...)`, or
   *  each name of `const [a, b] = await parallel([...])` for the branch at its index. */
  private keep(target: AnyNode | null | undefined, value: AnyNode | null | undefined): void {
    if (target?.type === "Identifier") {
      for (const call of givenCalls(value)) this.results.set(call, target.name);
    } else if (target?.type === "ArrayPattern") {
      const branches = branchValues(value);
      (target.elements as Array<AnyNode | null>).forEach((element, index) => this.keep(element, branches[index]));
    }
  }

  /** A literal label as it is, a template as its text with each expression as {source}. */
  private label(step: FlowStep, node: AnyNode): void {
    const written = this.written(node);
    step.label = written ?? `{${this.src(node)}}`;
    if (staticString(node) !== undefined) return;
    step.dynamic = true;
    if (written === undefined) this.note(`The label of the ${step.kind} step on line ${step.line} is made at run time.`);
  }

  /** A string as the text writes it: a literal as it is, and a template or a string joined with +
   *  as its text with each expression as {source}. Undefined for anything else. */
  private written(node: AnyNode): string | undefined {
    const literal = staticString(node);
    if (literal !== undefined) return literal;
    if (node.type !== "TemplateLiteral") return this.joined(node);
    const parts = (node.quasis as AnyNode[]).map((quasi, index) => {
      const expression = node.expressions[index] as AnyNode | undefined;
      return (quasi.value.cooked ?? quasi.value.raw) + (expression ? `{${this.src(expression)}}` : "");
    });
    return parts.join("");
  }

  /** A string as the text writes it, else the node as {source}, such as {name} for a variable. */
  private rendered(node: AnyNode): string {
    return this.written(node) ?? `{${this.src(node)}}`;
  }

  /** A label joined with +, such as "check " + part, as its text with each expression as {source}.
   *  Undefined when no part of it is a string. */
  private joined(node: AnyNode): string | undefined {
    if (node.type !== "BinaryExpression" || node.operator !== "+") return undefined;
    const parts: AnyNode[] = [];
    const walk = (part: AnyNode): void => {
      if (part.type === "BinaryExpression" && part.operator === "+") {
        walk(part.left as AnyNode);
        walk(part.right as AnyNode);
      } else parts.push(part);
    };
    walk(node);
    if (!parts.some((part) => part.type === "TemplateLiteral" || staticString(part) !== undefined)) return undefined;
    return parts.map((part) => this.rendered(part)).join("");
  }

  /** parallel([() => ...]) runs functions, Promise.all([...]) waits on promises. Each element is a branch. */
  private parallel(node: AnyNode, at: At, thunks: boolean): FlowNode[] {
    const list = node.arguments[0] as AnyNode | undefined;
    if (isPerItem(list)) return this.perItem(list!, at, thunks);
    if (list?.type !== "ArrayExpression") return this.list(node.arguments, at);
    const branches: FlowNode[][] = [];
    for (const element of list.elements as Array<AnyNode | null>) {
      if (!element) continue;
      const item = element.type === "SpreadElement" ? (element.argument as AnyNode) : element;
      const branch = isPerItem(item) ? this.perItem(item, at, thunks) : thunks ? this.calls(item, at) : this.expression(item, at);
      if (branch.length) branches.push(branch);
    }
    return branches.length ? [{ t: "parallel", id: this.id("par", node, at), line: lineOf(node), branches }] : [];
  }

  /** items.map(fn) and the like run fn for every item at once, as a pipeline of one stage does.
   *  In parallel(), fn gives a function for each item, which parallel() runs. */
  private perItem(node: AnyNode, at: At, thunks: boolean): FlowNode[] {
    const items = node.callee.object as AnyNode;
    const [fn, ...rest] = node.arguments as AnyNode[];
    const before = this.expression(items, at);
    const stage = this.runs(fn, at, thunks) ?? this.expression(fn, at);
    const after = this.list(rest, at);
    if (!stage.length) return [...before, ...after];
    const pipeline: FlowPipeline = { t: "pipeline", id: this.id("pipe", node, at), line: lineOf(node), over: this.src(items), stages: [stage] };
    return [...before, pipeline, ...after];
  }

  private pipeline(node: AnyNode, at: At): FlowNode[] {
    const [items, ...stageArgs] = node.arguments as AnyNode[];
    const before = this.expression(items, at);
    const stages = stageArgs.map((stage) => this.calls(stage, at)).filter((stage) => stage.length > 0);
    if (!items || !stages.length) return before;
    return [...before, { t: "pipeline", id: this.id("pipe", node, at), line: lineOf(node), over: this.src(items), stages }];
  }

  /** gate(work, check, { attempts }) and retry(work, { attempts, until }) repeat their work. */
  private repeat(node: AnyNode, loop: "gate" | "retry", at: At): FlowNode[] {
    const args = node.arguments as AnyNode[];
    const options = args[loop === "gate" ? 2 : 1];
    const object = options?.type === "ObjectExpression" ? options : undefined;
    const until = loop === "gate" ? args[1] : object && property(object, "until");
    const body = [...this.calls(args[0], at), ...this.calls(until, at)];
    if (!hasStep(body)) return [];
    const attempts = object && property(object, "attempts");
    const written = until && this.text.slice(until.start, until.end).trim();
    return [
      { t: "loop", id: this.id("loop", node, at), line: lineOf(node), loop, ...(attempts ? { limit: this.src(attempts) } : {}), ...(written ? { until: written } : {}), body },
    ];
  }

  /** promise.then(fn) and .finally(fn) run fn after it, .catch(fn) when it fails. */
  private chained(node: AnyNode, method: string, at: At): FlowNode[] {
    const [first, second] = node.arguments as AnyNode[];
    const before = this.expression(node.callee.object, at);
    if (method === "catch") return [...before, ...this.caught(node, this.calls(first, at), at)];
    const after = this.calls(first, at);
    return [...before, ...after, ...(method === "then" ? this.caught(node, this.calls(second, at), at) : [])];
  }

  /** a && step runs the step when a holds, a || step when it does not, a ?? step when it is null. */
  private logical(node: AnyNode, at: At): FlowNode[] {
    const before = this.expression(node.left, at);
    const right = this.expression(node.right, at);
    const left = this.src(node.left);
    if (node.operator === "&&") return [...before, ...this.ifNode(node, left, right, [], at)];
    if (node.operator === "||") return [...before, ...this.ifNode(node, left, [], right, at)];
    return [...before, ...this.ifNode(node, `${left} == null`, right, [], at)];
  }

  private loop(node: AnyNode, at: At): FlowNode[] {
    let before: FlowNode[] = [];
    let body: FlowNode[];
    let over: AnyNode | null = node.test;
    if (node.type === "ForStatement") {
      before = node.init ? this.statement(node.init, at) : [];
      const inner = { ...at, scope: bind(at.scope, boundNames(node.init)) };
      body = [...this.expression(node.test, inner), ...this.statement(node.body, inner), ...this.expression(node.update, inner)];
    } else if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
      before = this.expression(node.right, at);
      body = this.statement(node.body, { ...at, scope: bind(at.scope, boundNames(node.left)) });
      over = node.right;
    } else if (node.type === "WhileStatement") {
      body = [...this.expression(node.test, at), ...this.statement(node.body, at)];
    } else {
      body = [...this.statement(node.body, at), ...this.expression(node.test, at)];
    }
    if (!hasStep(body)) return before;
    const loop = node.type === "WhileStatement" || node.type === "DoWhileStatement" ? "while" : "for";
    return [...before, { t: "loop", id: this.id("loop", node, at), line: lineOf(node), loop, ...(over ? { label: this.src(over) } : {}), body }];
  }

  /** The try block's steps in order, then the catch block's as an if on "error". */
  private tryStatement(node: AnyNode, at: At): FlowNode[] {
    const nodes = this.statement(node.block, at);
    if (node.handler) {
      const inner = { ...at, scope: bind(at.scope, boundNames(node.handler.param)) };
      nodes.push(...this.caught(node.handler, this.statement(node.handler.body, inner), at));
    }
    if (node.finalizer) nodes.push(...this.statement(node.finalizer, at));
    return nodes;
  }

  /** Each case is an if on the subject, in the order the text writes them. */
  private switchStatement(node: AnyNode, at: At): FlowNode[] {
    const before = this.expression(node.discriminant, at);
    const subject = this.src(node.discriminant);
    const cases = (node.cases as AnyNode[]).map((each) => ({ each, flow: this.statements(each.consequent, at) }));
    const chain = cases.reduceRight<FlowNode[]>((rest, { each, flow }) => {
      if (!flow.length) return rest;
      return this.ifNode(each, each.test ? `${subject} === ${this.src(each.test)}` : "default", flow, rest, at);
    }, []);
    return [...before, ...chain];
  }

  private ifNode(node: AnyNode, cond: string, then: FlowNode[], otherwise: FlowNode[], at: At): FlowNode[] {
    if (!then.length && !otherwise.length) return [];
    return [{ t: "if", id: this.id("if", node, at), line: lineOf(node), cond, then, ...(otherwise.length ? { else: otherwise } : {}) }];
  }

  private caught(node: AnyNode, then: FlowNode[], at: At): FlowNode[] {
    return then.length ? [{ t: "if", id: this.id("err", node, at), line: lineOf(node), cond: "error", then }] : [];
  }

  /** The flow of an argument that a flow function calls: a function, or the name of one. */
  private runs(arg: AnyNode | undefined, at: At, unwrap = false): FlowNode[] | undefined {
    if (isFunction(arg)) return this.body(arg!, at, unwrap);
    const known = arg?.type === "Identifier" ? lookup(at.scope, arg.name) : undefined;
    return known ? this.inline(known, arg!.name, arg!, at, unwrap) : undefined;
  }

  /** The flow of an argument a flow function calls, or of the argument itself when it is no function. */
  private calls(arg: AnyNode | undefined, at: At): FlowNode[] {
    return this.runs(arg, at) ?? this.expression(arg, at);
  }

  /** The flow of a function the text names, read where it is called. */
  private inline(known: Known, name: string, call: AnyNode, at: At, unwrap = false): FlowNode[] {
    const stop = at.inlined.includes(known.fn)
      ? `${name}() calls itself on line ${lineOf(call)}, so the graph stops there.`
      : at.inlined.length >= MAX_DEPTH
        ? `The call to ${name}() on line ${lineOf(call)} is more than ${MAX_DEPTH} functions deep, so the graph leaves it out.`
        : undefined;
    if (stop) {
      if (firstStep(known.fn, known.scope, new Set())) this.note(stop);
      return [];
    }
    const inner: At = { ...at, path: `${at.path}${call.start}.`, inlined: [...at.inlined, known.fn], scope: known.scope };
    return this.body(known.fn, inner, unwrap);
  }

  /** The flow of a function's body. With unwrap, a function that only gives another function reads that one. */
  private body(fn: AnyNode, at: At, unwrap = false): FlowNode[] {
    const scope = bind(at.scope, (fn.params as AnyNode[]).flatMap(boundNames));
    const inner: At = { path: at.path, inlined: at.inlined, scope, top: false };
    if (fn.body.type === "BlockStatement") return this.statements(fn.body.body, inner);
    if (unwrap && isFunction(fn.body)) return this.body(fn.body, inner);
    return this.expression(fn.body, inner);
  }

  private lost(fn: AnyNode, at: At): void {
    const step = firstStep(fn, at.scope, new Set());
    if (!step) return;
    const line = lineOf(step);
    this.note(
      at.choosing
        ? `The step on line ${line} runs only when choose() picks it, so the graph leaves it out.`
        : `The step on line ${line} is inside a function sous can't follow, so the graph leaves it out.`,
    );
  }

  private list(nodes: AnyNode[], at: At): FlowNode[] {
    return nodes.flatMap((node) => this.expression(node, at));
  }

  private id(prefix: string, node: AnyNode, at: At): string {
    return `${at.path}${prefix}${node.start}`;
  }

  /** The text of a node on one line. */
  private src(node: AnyNode): string {
    return this.text.slice(node.start, node.end).replace(/\s+/g, " ").trim();
  }

  private note(text: string): void {
    this.notes.add(text);
  }
}

/** The functions a list of statements keeps in a name: its function declarations and its
 *  variables set to a function. Also the values of its other const names. */
function hoist(statements: AnyNode[], parent: Scope | undefined): Scope {
  const scope: Scope = { names: new Map(), values: new Map(), parent };
  for (const statement of statements) {
    if (statement.type === "FunctionDeclaration" && statement.id) scope.names.set(statement.id.name, { fn: statement, scope });
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations as AnyNode[]) {
      if (declarator.id?.type !== "Identifier" || !declarator.init) continue;
      if (isFunction(declarator.init)) scope.names.set(declarator.id.name, { fn: declarator.init, scope });
      else if (statement.kind === "const") scope.values.set(declarator.id.name, declarator.init);
    }
  }
  return scope;
}

/** A scope inside another that holds the names a function's parameters or a loop's variable give. */
function bind(scope: Scope, names: string[]): Scope {
  return names.length ? { names: new Map(), values: new Map(), bound: new Set(names), parent: scope } : scope;
}

function lookup(scope: Scope | undefined, name: string): Known | undefined {
  for (let at = scope; at; at = at.parent) {
    const known = at.names.get(name);
    if (known) return known;
  }
  return undefined;
}

/** True when a parameter, a loop's variable or a catch's error gives the name where it is read. */
function isBound(scope: Scope | undefined, name: string): boolean {
  for (let at = scope; at; at = at.parent) if (at.bound?.has(name)) return true;
  return false;
}

/** The value a const name is set to, where the text sets it, else the node itself. */
function valueOf(scope: Scope, node: AnyNode): AnyNode {
  if (node.type !== "Identifier") return node;
  for (let at: Scope | undefined = scope; at; at = at.parent) {
    if (at.bound?.has(node.name)) return node;
    const value = at.values.get(node.name);
    if (value) return value;
  }
  return node;
}

/** What a step's arguments read, in the order the text names them: each name `counts` takes, and
 *  each input as args.<name>. A function written in them runs later, so it is not read here. */
function readsOf(nodes: AnyNode[], counts: (name: string) => boolean): string[] {
  const reads = new Set<string>();
  const visit = (node: AnyNode): void => {
    if (isFunction(node)) return;
    if (node.type === "Identifier") {
      if (counts(node.name)) reads.add(node.name);
    } else if (node.type === "MemberExpression") {
      const input = node.object.type === "Identifier" && node.object.name === "args" ? (node.computed ? staticString(node.property) : node.property.name) : undefined;
      if (input !== undefined) reads.add(`args.${input}`);
      else [node.object, ...(node.computed ? [node.property] : [])].forEach(visit);
    } else if (node.type === "Property") {
      [...(node.computed ? [node.key] : []), node.value].forEach(visit);
    } else childrenOf(node).forEach(visit);
  };
  nodes.forEach(visit);
  return [...reads];
}

/** What each branch of parallel([...]) or Promise.all([...]) gives, by its index. The indexes stop
 *  at a spread, since the ones after it are not known. */
function branchValues(node: AnyNode | null | undefined): Array<AnyNode | undefined> {
  const call = node?.type === "AwaitExpression" ? node.argument : node;
  const callee = call?.type === "CallExpression" ? (call.callee as AnyNode) : undefined;
  const thunks = callee?.type === "Identifier" && callee.name === "parallel";
  const promises = callee?.type === "MemberExpression" && !callee.computed && callee.object.name === "Promise" && callee.property.name === "all";
  const list = call?.arguments[0] as AnyNode | undefined;
  if ((!thunks && !promises) || list?.type !== "ArrayExpression") return [];
  const values: Array<AnyNode | undefined> = [];
  for (const element of list.elements as Array<AnyNode | null>) {
    if (element?.type === "SpreadElement") break;
    values.push(element && thunks ? returned(element) : (element ?? undefined));
  }
  return values;
}

/** The first step call inside a node, or the first call of a named function that holds one. */
function firstStep(node: AnyNode, scope: Scope, seen: Set<AnyNode>): AnyNode | undefined {
  if (node.type === "CallExpression" && node.callee.type === "Identifier") {
    const known = lookup(scope, node.callee.name);
    if (!known && STEPS.has(node.callee.name)) return node;
    if (known && !seen.has(known.fn)) {
      seen.add(known.fn);
      if (firstStep(known.fn, known.scope, seen)) return node;
    }
  }
  for (const child of childrenOf(node)) {
    const found = firstStep(child, scope, seen);
    if (found) return found;
  }
  return undefined;
}

function isPerItem(node: AnyNode | null | undefined): boolean {
  const callee = node?.type === "CallExpression" ? (node.callee as AnyNode) : undefined;
  return callee?.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" && PER_ITEM.has(callee.property.name);
}

function hasStep(nodes: FlowNode[]): boolean {
  return nodes.some((node) => node.t === "step" || innerFlows(node).some(hasStep));
}

/** The node lists a node holds: a step's body, a loop's body, an if's branches, a parallel's
 *  branches and a pipeline's stages. */
export function innerFlows(node: FlowNode): FlowNode[][] {
  switch (node.t) {
    case "step":
      return node.body ? [node.body] : [];
    case "loop":
      return [node.body];
    case "if":
      return node.else ? [node.then, node.else] : [node.then];
    case "parallel":
      return node.branches;
    case "pipeline":
      return node.stages;
    default:
      return [];
  }
}

/** Ids are unique in the flow. A second node with the same id, which only odd texts make, gets a number. */
function uniqueIds(nodes: FlowNode[]): FlowNode[] {
  const seen = new Map<string, number>();
  const visit = (list: FlowNode[]) => {
    for (const node of list) {
      const count = (seen.get(node.id) ?? 0) + 1;
      seen.set(node.id, count);
      if (count > 1) node.id = `${node.id}-${count}`;
      innerFlows(node).forEach(visit);
    }
  };
  visit(nodes);
  return nodes;
}

function lineOf(node: AnyNode): number {
  return node.loc?.start.line ?? 1;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

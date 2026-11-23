// A workflow script, parsed once with acorn: its meta, its body, and the names it refers to.
// The parser refuses a script that is not deterministic or whose meta is not a literal.

import type { Node } from "acorn";
import { parse } from "acorn";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import type { WorkflowMeta, WorkflowMetaPhase } from "../workflow-result.js";

type AnyNode = Node & { [key: string]: any; start: number; end: number };

/** The options of one step as the script writes them: an object that names an agent or MCP servers. */
export interface StepRefs {
  /** The agent, when the script names it with a string. */
  agentType?: string;
  /** True when the object has an agentType key, whatever its value. */
  setsAgentType: boolean;
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
  /** Each object that names an agent or MCP servers. */
  steps: StepRefs[];
  /** The script files it runs, as run("file"). */
  scripts: string[];
  /** True when a choose() lets an agent pick any saved workflow. */
  choosesAnyWorkflow: boolean;
}

/** A name workflow() looks up as a saved workflow. Other text is an inline script. */
const SAVED_WORKFLOW_NAME = /^[A-Za-z0-9_.-]+$/;

function parseWorkflowAst(script: string): AnyNode {
  return parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
    ranges: false,
  }) as AnyNode;
}

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
  const ast = parseWorkflowAst(script);

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

function pushAstChildren(node: AnyNode, pending: AnyNode[]): void {
  const children: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && typeof (item as AnyNode).type === "string") children.push(item as AnyNode);
      }
    } else if (value && typeof value === "object" && typeof (value as AnyNode).type === "string") {
      children.push(value as AnyNode);
    }
  }
  for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
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

/** The string a node always holds: a string literal or a template with no ${}. */
function staticString(node: AnyNode | null | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  return undefined;
}

/** The key of a property written as a name or a string, not a computed one. */
function keyOf(property: AnyNode): string | undefined {
  if (property.type !== "Property" || property.computed) return undefined;
  if (property.key?.type === "Identifier") return property.key.name;
  return typeof property.key?.value === "string" ? property.key.value : undefined;
}

function ownProperty(object: AnyNode, key: string): AnyNode | undefined {
  return (object.properties as AnyNode[]).find((property) => keyOf(property) === key);
}

function scriptRefs(ast: AnyNode): ScriptRefs {
  const workflows = new Set<string>();
  const models = new Set<string>();
  const scripts = new Set<string>();
  const steps: StepRefs[] = [];
  let choosesAnyWorkflow = false;
  const pending = [ast];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
      const first = staticString(node.arguments[0]);
      const callee = node.callee.name;
      if (callee === "workflow" && first && SAVED_WORKFLOW_NAME.test(first)) workflows.add(first);
      if (callee === "run" && first) scripts.add(first);
      if (callee === "choose") {
        for (const argument of node.arguments as AnyNode[]) {
          const any = argument.type === "ObjectExpression" ? ownProperty(argument, "any") : undefined;
          if (any?.value?.type === "Literal" && any.value.value === true) choosesAnyWorkflow = true;
        }
      }
    }
    if (node.type === "Property" && keyOf(node) === "model") {
      const model = staticString(node.value);
      if (model) models.add(model);
    }
    if (node.type === "ObjectExpression") {
      const agentType = ownProperty(node, "agentType");
      const mcp = ownProperty(node, "mcp");
      if (agentType || mcp) {
        const model = ownProperty(node, "model");
        const agentName = staticString(agentType?.value);
        const modelName = staticString(model?.value);
        const servers = mcp?.value?.type === "ArrayExpression" ? (mcp.value.elements as AnyNode[]).map(staticString) : [];
        steps.push({
          ...(agentName ? { agentType: agentName } : {}),
          setsAgentType: agentType !== undefined,
          ...(modelName ? { model: modelName } : {}),
          setsModel: model !== undefined,
          mcp: [...new Set(servers.filter((name): name is string => Boolean(name)))],
        });
      }
    }
    pushAstChildren(node, pending);
  }
  return { workflows: [...workflows], models: [...models], steps, scripts: [...scripts], choosesAnyWorkflow };
}

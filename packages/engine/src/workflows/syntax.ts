// Reads of the nodes acorn gives for a workflow's text: the parse, their children, the strings and
// properties they write, the names they give and the values they give back. The script's reader in
// script.ts, the graph's reader in flow.ts and the option reads in step-options.ts share them.

import { parse, type Node } from "acorn";

export type AnyNode = Node & { [key: string]: any; start: number; end: number };

/** A name workflow() looks up as a saved workflow. Other text is an inline script. */
export const SAVED_WORKFLOW_NAME = /^[A-Za-z0-9_.-]+$/;

/** A workflow's text as acorn reads it: a module, with await and return at the top level. Throws
 *  when the text does not parse. */
export function parseWorkflowText(script: string): AnyNode {
  return parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
  }) as AnyNode;
}

/** A node's child nodes, in the order the text writes them. */
export function childrenOf(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc") continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item && typeof item === "object" && typeof item.type === "string") children.push(item as AnyNode);
    }
  }
  return children.sort((a, b) => a.start - b.start);
}

export function isFunction(node: AnyNode | null | undefined): boolean {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

/** The string a node always holds: a string literal or a template with no ${}. */
export function staticString(node: AnyNode | null | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return (node.quasis as AnyNode[]).map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  return undefined;
}

/** The value of an object's own property, written as a name or a string. */
export function property(object: AnyNode, key: string): AnyNode | undefined {
  for (const item of object.properties as AnyNode[]) {
    if (item.type === "Property" && keyOf(item) === key) return item.value as AnyNode;
  }
  return undefined;
}

/** The name of a property the text writes, such as a in { a: 1 } or { "a": 1 }. A number names
 *  the property as JavaScript does, so { 1: x } names "1". */
export function keyOf(item: AnyNode): string | undefined {
  if (item.computed) return undefined;
  if (item.key?.type === "Identifier") return item.key.name;
  return item.key?.type === "Literal" ? String(item.key.value) : undefined;
}

/** The names a parameter or a declaration gives, such as item, or a and b in { a, b }. */
export function boundNames(node: AnyNode | null | undefined): string[] {
  switch (node?.type) {
    case "Identifier":
      return [node.name];
    case "ObjectPattern":
      return (node.properties as AnyNode[]).flatMap((item) => boundNames(item.type === "RestElement" ? item.argument : item.value));
    case "ArrayPattern":
      return (node.elements as Array<AnyNode | null>).flatMap(boundNames);
    case "AssignmentPattern":
      return boundNames(node.left);
    case "RestElement":
      return boundNames(node.argument);
    case "VariableDeclaration":
      return (node.declarations as AnyNode[]).flatMap((declarator) => boundNames(declarator.id));
    default:
      return [];
  }
}

/** The calls whose result an expression gives as it is: a call, awaited or not, or either side of
 *  a ?: . */
export function givenCalls(node: AnyNode | null | undefined): AnyNode[] {
  if (node?.type === "AwaitExpression") return givenCalls(node.argument);
  if (node?.type === "ConditionalExpression") return [...givenCalls(node.consequent), ...givenCalls(node.alternate)];
  return node?.type === "CallExpression" ? [node] : [];
}

/** What a function gives back: its expression body, or the return that ends its block. */
export function returned(fn: AnyNode): AnyNode | undefined {
  if (!isFunction(fn)) return undefined;
  if (fn.body.type !== "BlockStatement") return fn.body;
  const last = (fn.body.body as AnyNode[]).at(-1);
  return last?.type === "ReturnStatement" ? (last.argument ?? undefined) : undefined;
}

// The names a workflow's text sees where the graph's reader (flow.ts) stands: the functions it
// keeps in a name, the values its names are set to once, and the names a function's parameters
// or a loop's variable give.

import { boundNames, childrenOf, isFunction, type AnyNode } from "./syntax.js";

/** A function the text keeps in a name, and the names it sees where it is written. */
export interface Known {
  fn: AnyNode;
  scope: Scope;
}

export interface Scope {
  names: Map<string, Known>;
  /** What its const names are set to, such as a schema the text keeps in a name. */
  values: Map<string, AnyNode>;
  /** The names a function's parameters, a loop's variable or a catch's error give here. */
  bound?: Set<string>;
  parent?: Scope;
}

/** The functions a list of statements keeps in a name: its function declarations and its
 *  variables set to a function. Also the values of its other names: each const, and each let or
 *  var that the statements never assign again. */
export function hoist(statements: AnyNode[], parent: Scope | undefined): Scope {
  const scope: Scope = { names: new Map(), values: new Map(), parent };
  let assigned: Set<string> | undefined;
  for (const statement of statements) {
    if (statement.type === "FunctionDeclaration" && statement.id) scope.names.set(statement.id.name, { fn: statement, scope });
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations as AnyNode[]) {
      if (declarator.id?.type !== "Identifier" || !declarator.init) continue;
      const name = declarator.id.name as string;
      if (isFunction(declarator.init)) scope.names.set(name, { fn: declarator.init, scope });
      else if (statement.kind === "const" || !(assigned ??= assignedNames(statements)).has(name)) scope.values.set(name, declarator.init);
    }
  }
  return scope;
}

/** The names that statements assign or count up or down, in any depth, functions too. */
function assignedNames(statements: AnyNode[]): Set<string> {
  const names = new Set<string>();
  const stack = [...statements];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type === "AssignmentExpression") boundNames(node.left).forEach((name) => names.add(name));
    if (node.type === "UpdateExpression" && node.argument.type === "Identifier") names.add(node.argument.name);
    if ((node.type === "ForInStatement" || node.type === "ForOfStatement") && node.left.type !== "VariableDeclaration") boundNames(node.left).forEach((name) => names.add(name));
    stack.push(...childrenOf(node));
  }
  return names;
}

/** A scope inside another that holds the names a function's parameters or a loop's variable give. */
export function bind(scope: Scope, names: string[]): Scope {
  return names.length ? { names: new Map(), values: new Map(), bound: new Set(names), parent: scope } : scope;
}

export function lookup(scope: Scope | undefined, name: string): Known | undefined {
  for (let at = scope; at; at = at.parent) {
    const known = at.names.get(name);
    if (known) return known;
  }
  return undefined;
}

/** True when a parameter, a loop's variable or a catch's error gives the name where it is read. */
export function isBound(scope: Scope | undefined, name: string): boolean {
  for (let at = scope; at; at = at.parent) if (at.bound?.has(name)) return true;
  return false;
}

/** The value a name is set to once, where the text sets it, else the node itself. */
export function valueOf(scope: Scope, node: AnyNode): AnyNode {
  if (node.type !== "Identifier") return node;
  for (let at: Scope | undefined = scope; at; at = at.parent) {
    if (at.bound?.has(node.name)) return node;
    const value = at.values.get(node.name);
    if (value) return value;
  }
  return node;
}

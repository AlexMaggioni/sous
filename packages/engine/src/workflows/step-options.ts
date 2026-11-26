// The options a step's text gives it, for the page's step panel. Only a value the text writes in
// place counts: a string, a number, true, a list of strings, or the names of an object. A value
// made at run time is left out. The graph's reader in flow.ts adds them to each step.

import type { StepKind, StepOptions } from "./flow.js";
import { keyOf, property, staticString, type AnyNode } from "./syntax.js";

/** How the reader shows a node, and what a name stands for where it is written. */
export interface OptionsReader {
  /** The text of a node on one line. */
  src(node: AnyNode): string;
  /** The value a const name is set to in the text, else the node itself. */
  valueOf(node: AnyNode): AnyNode;
}

type Read = (value: AnyNode, reader: OptionsReader) => unknown;

const AGENT: StepKind[] = ["agent"];
const CODE: StepKind[] = ["sh", "js", "py", "run", "wait"];

/** Each option the panel shows: its key in the text, its field, the steps that take it, and how its value reads. */
const OPTIONS: Array<{ key: string; field: keyof StepOptions; kinds: StepKind[]; read: Read }> = [
  { key: "timeout", field: "timeout", kinds: [...AGENT, ...CODE], read: duration },
  { key: "effort", field: "effort", kinds: AGENT, read: staticString },
  { key: "mode", field: "mode", kinds: AGENT, read: staticString },
  { key: "isolation", field: "isolation", kinds: AGENT, read: oneOf("worktree") },
  { key: "skills", field: "skills", kinds: AGENT, read: strings },
  { key: "mcp", field: "mcp", kinds: AGENT, read: strings },
  { key: "keepSession", field: "keepSession", kinds: AGENT, read: yes },
  { key: "continue", field: "continues", kinds: AGENT, read: staticString },
  { key: "ask", field: "asks", kinds: AGENT, read: yes },
  { key: "answeredBy", field: "answeredBy", kinds: ["agent", "ask"], read: oneOf("people", "anyone") },
  { key: "schema", field: "schema", kinds: AGENT, read: schemaNames },
  { key: "allowFail", field: "allowFail", kinds: CODE, read: yes },
  { key: "choices", field: "choices", kinds: ["ask", "checkpoint"], read: strings },
  { key: "kind", field: "answer", kinds: ["checkpoint"], read: oneOf("confirm", "input", "select") },
  { key: "max", field: "max", kinds: ["breakpoint"], read: (value) => (isNumber(value) ? value.value : undefined) },
  { key: "every", field: "every", kinds: ["wait"], read: duration },
  { key: "place", field: "place", kinds: ["workflow"], read: staticString },
  { key: "steps", field: "steps", kinds: ["choose"], read: namesOf },
  { key: "workflows", field: "workflows", kinds: ["choose"], read: workflowNames },
  { key: "any", field: "any", kinds: ["choose"], read: yes },
];

/** The options a step's text gives it, from its options object and, for workflow(), the inputs it
 *  passes. Undefined when the text gives none of them. */
export function stepOptions(kind: StepKind, object: AnyNode | undefined, args: AnyNode[], reader: OptionsReader): StepOptions | undefined {
  const options: Record<string, unknown> = {};
  for (const { key, field, kinds, read } of OPTIONS) {
    const value = object && kinds.includes(kind) ? property(object, key) : undefined;
    const literal = value && read(reader.valueOf(value), reader);
    if (literal !== undefined) options[field] = literal;
  }
  const inputs = kind === "workflow" && args[1] ? inputsOf(reader.valueOf(args[1]), reader) : undefined;
  if (inputs) options.inputs = inputs;
  return Object.keys(options).length ? (options as StepOptions) : undefined;
}

/** The names of an object the text writes. Undefined when one is made at run time, as a spread is. */
function namesOf(value: AnyNode | undefined): string[] | undefined {
  if (value?.type !== "ObjectExpression") return undefined;
  const names: string[] = [];
  for (const item of value.properties as AnyNode[]) {
    const name = item.type === "Property" ? keyOf(item) : undefined;
    if (name === undefined) return undefined;
    names.push(name);
  }
  return names;
}

/** A time such as "10m", or a number of seconds as the text writes it. */
function duration(value: AnyNode, reader: OptionsReader): string | undefined {
  return staticString(value) ?? (isNumber(value) ? reader.src(value) : undefined);
}

function isNumber(value: AnyNode): boolean {
  return value.type === "Literal" && typeof value.value === "number";
}

function yes(value: AnyNode): true | undefined {
  return value.type === "Literal" && value.value === true ? true : undefined;
}

/** A string that is one of these. */
function oneOf(...allowed: string[]): Read {
  return (value) => {
    const text = staticString(value);
    return text !== undefined && allowed.includes(text) ? text : undefined;
  };
}

/** A list of strings. Undefined when any item is not one. */
function strings(value: AnyNode): string[] | undefined {
  if (value.type !== "ArrayExpression") return undefined;
  const items = (value.elements as Array<AnyNode | null>).map(staticString);
  return items.every((item) => item !== undefined) ? (items as string[]) : undefined;
}

/** The field names of a schema: a JSON Schema object with a properties object, or TypeBox's
 *  Type.Object({...}). */
function schemaNames(value: AnyNode): string[] | undefined {
  if (value.type === "ObjectExpression") return namesOf(property(value, "properties"));
  const callee = value.type === "CallExpression" ? (value.callee as AnyNode) : undefined;
  const typeBox = callee?.type === "MemberExpression" && !callee.computed && callee.object.name === "Type" && callee.property.name === "Object";
  return typeBox ? namesOf(value.arguments[0]) : undefined;
}

/** The saved workflows a choose may pick: each a name, or an object with a name. */
function workflowNames(value: AnyNode): string[] | undefined {
  if (value.type !== "ArrayExpression") return undefined;
  const names = (value.elements as Array<AnyNode | null>).map((item) => staticString(item?.type === "ObjectExpression" ? property(item, "name") : item));
  return names.every((name) => name !== undefined) ? (names as string[]) : undefined;
}

/** The inputs a workflow() step passes, each value as the text writes it. */
function inputsOf(value: AnyNode, reader: OptionsReader): Record<string, string> | undefined {
  const names = namesOf(value);
  if (!names?.length) return undefined;
  return Object.fromEntries(names.map((name, index) => [name, reader.src(value.properties[index].value)]));
}

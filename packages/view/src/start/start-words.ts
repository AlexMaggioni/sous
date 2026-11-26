import type { Input } from "../api/contract.ts";

// The words of a start: each input's value as the form holds it, the checks sous run would make,
// and the argv the page sends. Inputs go after "--" as --name=value, so a name that is also one of
// sous's own flags, or a value that starts with "--", reaches the workflow as it is.

/** The form's values by input name: text for every field, true or false for a checkbox. */
export type Values = Record<string, string | boolean>;

/** A default as the field shows it. JSON reads best indented. */
function shown(input: Input): string | boolean {
  const value = input.default;
  if (input.type === "boolean") return value === true;
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return input.type === "json" ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** Each field at its default, empty when it has none. */
export function initialValues(inputs: readonly Input[]): Values {
  return Object.fromEntries(inputs.map((input) => [input.name, shown(input)]));
}

const textOf = (value: string | boolean | undefined) => (typeof value === "string" ? value.trim() : "");

/** What is wrong with each value, by input name, as sous run would refuse it. Empty when all is well. */
export function checkValues(inputs: readonly Input[], values: Values): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const input of inputs) {
    if (input.type === "boolean") continue;
    const text = textOf(values[input.name]);
    if (!text) {
      if (input.required) errors[input.name] = input.choices?.length ? `Pick one for ${input.name}. sous run refuses to start without it.` : `Fill in ${input.name}. sous run refuses to start without it.`;
      continue;
    }
    if (input.type === "number" && !Number.isFinite(Number(text))) errors[input.name] = `${input.name} takes a number, such as 3.`;
    if (input.type === "json") {
      try {
        JSON.parse(text);
      } catch (e) {
        errors[input.name] = `${input.name} takes JSON, such as {"a": 1} or ["x"]. ${e instanceof Error ? e.message : ""}`.trim();
      }
    }
    if (input.choices?.length && !input.choices.includes(text)) errors[input.name] = `Pick one for ${input.name}: ${input.choices.join(", ")}.`;
  }
  return errors;
}

/** JSON on one line, as it parsed. Text that does not parse stays as typed, for the check to name. */
function oneLine(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

/**
 * The inputs to send, as [name, value] in the inputs' order. An empty field and a value equal to
 * its default stay out, so the workflow's own default applies. A checkbox goes when it differs from
 * its default, or when the input is required and has none.
 */
function chosenInputs(inputs: readonly Input[], values: Values): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const input of inputs) {
    const value = values[input.name];
    if (input.type === "boolean") {
      const on = value === true;
      if (on !== (input.default === true) || (input.required && input.default === undefined)) out.push([input.name, String(on)]);
      continue;
    }
    const text = textOf(value);
    if (!text || text === textOf(shown(input))) continue;
    out.push([input.name, input.type === "json" ? oneLine(text) : text]);
  }
  return out;
}

/** The words of sous run for this start, as POST /api/call takes them. */
export function startArgv(name: string, project: string | undefined, inputs: readonly Input[], values: Values): string[] {
  const chosen = chosenInputs(inputs, values);
  return ["run", name, ...(project ? ["--project", project] : []), ...(chosen.length ? ["--", ...chosen.map(([key, value]) => `--${key}=${value}`)] : [])];
}

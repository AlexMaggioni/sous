// The prompts sous sends besides a step's own, and reading a schema step's answer.
// A step's own prompt goes as written, so a slash command or a skill runs as it does in a session
// opened by hand.

import type { TSchema } from "typebox";
import { Check, Convert, Errors } from "typebox/value";
import type { Image, McpServer } from "@sous-run/harnesses";
import type { McpServerConfig } from "./mcp-config.js";
import type { PromptImage } from "./agent-run.js";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";

/** The report turn, which asks a slash step with a schema for its value, in the same session. */
export const REPORT_PROMPT = "Report on the task you were given.";

/** The repair turn for a schema step whose answer did not fit. It uses the report turn's words. */
export const REPROMPT_TEXT = REPORT_PROMPT;

/** True for a prompt that starts with "/", which the program reads as a command or a skill. */
export const isSlash = (prompt: string) => prompt.startsWith("/");

/**
 * A turn's text with the resume's note. On a plain prompt the note follows after a blank line. On
 * a slash prompt it goes apart, as the step's note, so it never lands inside the command.
 */
export function withNote(prompt: string, note: string | undefined): { prompt: string; note?: string } {
  if (note === undefined) return { prompt };
  return isSlash(prompt) ? { prompt, note } : { prompt: `${prompt}\n\n${note}` };
}

/** A fenced json block, else the first balanced {...} or [...]. */
export function findJsonBlock(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/** The value converted toward the schema, when it then fits. */
export function validateValue(value: unknown, schema: TSchema): unknown {
  try {
    const converted = Convert(schema, value);
    if (Check(schema, converted)) return converted;
  } catch {
    // typebox throws on some schemas. That counts as no fit.
  }
  return undefined;
}

/** True for a value that can be a JSON schema: a plain object that is no array. */
export function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The value checked against a schema, with validateValue's check. A fit gives the converted value.
 * A misfit gives the reason: each place that does not fit, by its path, as "n must be number".
 */
export function fitSchema(value: unknown, schema: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  const fitted = validateValue(value, schema as TSchema);
  if (fitted !== undefined) return { ok: true, value: fitted };
  let reasons: string[] = [];
  try {
    reasons = Errors(schema as TSchema, value).map((error) => `${error.instancePath ? error.instancePath.slice(1).replaceAll("/", ".") : "the value"} ${error.message}`);
  } catch {
    // typebox throws on some schemas. The reason stays general.
  }
  return { ok: false, reason: reasons.length ? [...new Set(reasons)].join("; ") : "the value does not fit" };
}

/** A text answer's value: its JSON when that fits, else the text itself when that fits. */
function fitText(text: string, schema: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; reason: string; notJson?: true } {
  let parsed: { value: unknown } | undefined;
  try {
    parsed = { value: JSON.parse(text) };
  } catch {
    // not JSON: the text itself may still fit a string schema
  }
  if (parsed) {
    const fit = fitSchema(parsed.value, schema);
    if (fit.ok) return fit;
    const asText = fitSchema(text, schema);
    return asText.ok ? asText : fit;
  }
  const asText = fitSchema(text, schema);
  return asText.ok ? asText : { ok: false, reason: "the answer is not JSON", notJson: true };
}

/**
 * A person's answer to a question with a schema, checked. Text is read as JSON. An ask's value
 * must fit. At a breakpoint, approve, stop and send back pass as they are, and an approve that
 * carries a value, or an answer in JSON, must fit: it gives { decision: "approve", value }.
 */
export function fitAnswer(
  answer: unknown,
  schema: Record<string, unknown>,
  breakpoint: boolean,
): { ok: true; value: unknown } | { ok: false; reason: string; notJson?: true } {
  if (!breakpoint) return typeof answer === "string" ? fitText(answer, schema) : fitSchema(answer, schema);
  const approved = (value: unknown, note?: unknown) => {
    const fit = typeof value === "string" ? fitText(value, schema) : fitSchema(value, schema);
    return fit.ok ? { ok: true as const, value: { decision: "approve", value: fit.value, ...(typeof note === "string" && note ? { note } : {}) } } : fit;
  };
  if (typeof answer === "boolean") return { ok: true, value: answer };
  if (typeof answer === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer);
    } catch {
      return { ok: true, value: answer };
    }
    return typeof parsed === "string" ? { ok: true, value: answer } : approved(parsed);
  }
  if (isSchemaObject(answer) && "decision" in answer) {
    if (String(answer.decision).toLowerCase() === "approve" && "value" in answer) return approved(answer.value, answer.note);
    return { ok: true, value: answer };
  }
  return approved(answer);
}

/** The JSON in the text, when it fits the schema. */
export function extractValidated(text: string, schema: TSchema): unknown {
  const json = findJsonBlock(text);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return validateValue(parsed, schema);
}

/** A step's images as the harness takes them. A bad one stops the step before it starts. */
export function checkImages(images: readonly PromptImage[] | undefined, label?: string): Image[] {
  const out: Image[] = [];
  (images ?? []).forEach((image, i) => {
    const bad = (message: string) => new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false, agentLabel: label });
    if (typeof image?.data !== "string" || image.data.trim() === "") throw bad(`images[${i}].data must be a non-empty string`);
    if (typeof image.mimeType !== "string" || image.mimeType.trim() === "") throw bad(`images[${i}].mimeType must be a non-empty string`);
    if (image.uri !== undefined && (typeof image.uri !== "string" || image.uri.trim() === "")) throw bad(`images[${i}].uri must be a non-empty string when present`);
    out.push({ mimeType: image.mimeType, data: image.data });
  });
  return out;
}

const record = (pairs: { name: string; value: string }[] | undefined) => Object.fromEntries((pairs ?? []).map((pair) => [pair.name, pair.value]));

/** A workflow's MCP server as the harness takes it, or the reason it can't run. */
export function toMcpServer(server: McpServerConfig): McpServer | { problem: string } {
  const type = (server as { type?: string }).type;
  if (type === undefined || type === "stdio") {
    const stdio = server as { name: string; command: string; args?: string[]; env?: { name: string; value: string }[] };
    return { name: stdio.name, type: "stdio", command: stdio.command, args: [...(stdio.args ?? [])], env: record(stdio.env) };
  }
  if (type === "http" || type === "sse") {
    const remote = server as { name: string; url: string; headers?: { name: string; value: string }[] };
    return { name: remote.name, type: "http", url: remote.url, headers: record(remote.headers) };
  }
  return { problem: `MCP server "${server.name}" is of type ${type}, which a step cannot start. Give it a command or a url.` };
}

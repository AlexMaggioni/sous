// The words around a step's prompt, and reading a schema step's answer.
// The prompt texts stay byte for byte as earlier versions sent them, so a resumed run asks
// the same way.

import type { TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import type { Image, McpServer } from "@orchestrator/harnesses";
import type { McpServerConfig } from "./mcp-config.js";
import type { PromptImage } from "./agent-run.js";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";

const CONTRACT = [
  "Final output contract:",
  "- Your FINAL message MUST be a single JSON object that conforms to the required output schema.",
  "- Output ONLY that JSON object — no prose, no explanation, and no markdown code fences.",
  "- If you need to inspect files or run commands first, do so, then emit the JSON object as your final message.",
].join("\n");

/** The repair turn for a schema step whose answer did not fit. */
export const REPROMPT_TEXT = [
  "Your previous reply did not return valid JSON matching the required output schema.",
  "Reply now with ONLY a single JSON object that conforms to the schema —",
  "no prose, no explanation, and no markdown code fences.",
].join(" ");

/** The prompt that continues a turn a usage limit or a lost login cut off. */
export const CONTINUATION_INSTRUCTION =
  "Your previous turn was interrupted before it finished — the provider paused it for a usage " +
  "limit or expired credentials, not because the task was complete. The full task and all prior " +
  "context are already in this session's history; do not restart or repeat work you already did. " +
  "Continue from where you stopped and produce the COMPLETE final answer to the original task now.";

/** The step's label, its prompt, and for a schema step the answer contract. */
export function buildPrompt(prompt: string, label: string | undefined, schema: unknown): string {
  const parts: string[] = [];
  if (label) parts.push(`Task label: ${label}`);
  parts.push(prompt);
  if (schema) parts.push(CONTRACT);
  return parts.join("\n\n");
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

// Shared parts of the fake claude and codex programs: the answer a request gets, the value
// built from a JSON schema, the rules file and the request log. Node only, no dependencies.
//
// FAKE_LOG    a file. Each request appends one JSON line to it.
// FAKE_RULES  a JSON file with a list of rules. The first rule whose `match` regex matches the
//             prompt decides the answer. A rule may also name a `program` (claude or codex).
//               answer     the text, or the value when the request has a schema
//               delayMs    wait this long before answering
//               hold       wait until a file of this name exists next to FAKE_LOG, or until
//                          the request is interrupted
//               fail       fail with this message
//               limit      fail with a usage limit: { "resetsAt": epoch seconds }
//               times      apply the rule to the first N matching requests only. The count
//                          comes from earlier lines in FAKE_LOG, so it holds across processes.
// FAKE_DEBUG  a file. Each program appends what it reads and writes, for debugging.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOGIN_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

/** The login variables that are set, by name only. */
export function loginPresent(env = process.env) {
  return LOGIN_VARS.filter((name) => env[name] !== undefined && env[name] !== "");
}

export function debug(program, ...parts) {
  const file = process.env.FAKE_DEBUG;
  if (!file) return;
  const text = parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
  appendFileSync(file, `${program} ${process.pid} ${text}\n`);
}

function readLines() {
  const file = process.env.FAKE_LOG;
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {};
      }
    });
}

export function appendLog(entry) {
  const file = process.env.FAKE_LOG;
  if (!file) return;
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function loadRules() {
  const file = process.env.FAKE_RULES;
  if (!file || !existsSync(file)) return [];
  const rules = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(rules) ? rules : [];
}

/**
 * The answer for one request. Returns { rule, kind, text, value, delayMs, hold, message,
 * resetsAt }. kind is "answer", "fail" or "limit".
 */
export function decide(program, prompt, schema) {
  const rules = loadRules();
  const earlier = readLines();
  let picked;
  for (const [index, rule] of rules.entries()) {
    if (rule.program && rule.program !== program) continue;
    if (rule.match && !new RegExp(rule.match).test(prompt)) continue;
    if (rule.times !== undefined) {
      const used = earlier.filter((line) => line.rule === index).length;
      if (used >= rule.times) continue;
    }
    picked = { index, rule };
    break;
  }
  const rule = picked?.rule ?? {};
  const out = { rule: picked?.index ?? null, delayMs: rule.delayMs ?? 0, hold: rule.hold };
  if (rule.limit) return { ...out, kind: "limit", resetsAt: rule.limit.resetsAt };
  if (rule.fail) return { ...out, kind: "fail", message: rule.fail };
  let value;
  if (schema) {
    value = rule.answer === undefined ? fabricate(schema) : typeof rule.answer === "string" ? parseOr(rule.answer) : rule.answer;
  }
  const text = schema ? JSON.stringify(value) : typeof rule.answer === "string" ? rule.answer : rule.answer === undefined ? `Fake ${program} answer.` : JSON.stringify(rule.answer);
  return { ...out, kind: "answer", text, value };
}

function parseOr(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the rule's delay and hold. Resolves early when `stopped()` turns true. */
export async function waitFor(decision, stopped) {
  const until = Date.now() + (decision.delayMs ?? 0);
  while (Date.now() < until && !stopped()) await sleep(Math.min(50, until - Date.now()));
  if (!decision.hold) return;
  const gate = join(dirname(process.env.FAKE_LOG ?? "."), decision.hold);
  while (!existsSync(gate) && !stopped()) await sleep(50);
}

/**
 * A value that fits a JSON schema, built the same way every time. Const first, then the first
 * enum value, the default, the first variant; objects get every property, arrays get one to
 * three items, strings follow their format and length limits.
 */
export function fabricate(schema, hint = "value", depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 16) return null;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if ("default" in schema) return schema.default;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[key]) && schema[key].length) {
      const variant = schema[key].find((item) => item && item.type !== "null") ?? schema[key][0];
      return fabricate(variant, hint, depth + 1);
    }
  }
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((item) => item !== "null") ?? type[0];
  if (!type && schema.properties) type = "object";
  if (!type && schema.items) type = "array";
  switch (type) {
    case "object": {
      const out = {};
      for (const [name, sub] of Object.entries(schema.properties ?? {})) out[name] = fabricate(sub, name, depth + 1);
      for (const name of schema.required ?? []) if (!(name in out)) out[name] = `fake-${name}`;
      return out;
    }
    case "array": {
      const count = Math.min(Math.max(schema.minItems ?? 1, 1), schema.maxItems ?? 3, 3);
      return Array.from({ length: count }, (_, i) => fabricate(schema.items ?? {}, `${hint}-${i + 1}`, depth + 1));
    }
    case "string": {
      if (schema.format === "uri" || schema.format === "url") return "https://example.invalid/fake";
      if (schema.format === "date-time") return "2024-01-01T00:00:00Z";
      if (schema.format === "date") return "2024-01-01";
      let text = `fake-${hint}`;
      if (schema.minLength && text.length < schema.minLength) text = text.padEnd(schema.minLength, "x");
      if (schema.maxLength !== undefined && text.length > schema.maxLength) text = text.slice(0, schema.maxLength);
      return text;
    }
    case "integer":
    case "number":
      if (schema.minimum !== undefined) return schema.minimum;
      if (schema.exclusiveMinimum !== undefined) return schema.exclusiveMinimum + 1;
      if (schema.maximum !== undefined && schema.maximum < 1) return schema.maximum;
      return 1;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return null;
  }
}

/** MCP servers by name and transport, from a map of name to config. */
export function mcpSummary(servers) {
  return Object.entries(servers ?? {})
    .map(([name, config]) => ({ name, transport: config?.type ?? (config?.url ? "http" : "stdio") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Newline-delimited JSON from a stream, one parsed message per call. */
export function readJsonLines(stream, onMessage) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(message);
    }
  });
}

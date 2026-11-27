// Shared parts of the fake claude and codex programs: the answer a request gets, the value
// built from a JSON schema, the rules file and the request log. Node only, no dependencies.
//
// FAKE_LOG    a file. Each request appends one JSON line to it, with the program's `pid`, so a
//             test can tell which turns shared a process. A user message with more than one text
//             (Claude: text blocks, Codex: text input items) logs them in `texts`. `resume` says
//             whether the program opened the session with a resume.
// FAKE_RULES  a JSON file with a list of rules. The first rule whose `match` regex matches the
//             prompt decides the answer. The prompt is every text of the message, joined with a
//             newline. A rule may also name a `program` (claude or codex).
//               answer     the text, or the value when the request has a schema
//               delayMs    wait this long before answering
//               hold       wait until a file of this name exists next to FAKE_LOG, or until
//                          the request is interrupted
//               fail       fail with this message
//               limit      fail with a usage limit: { "resetsAt": epoch seconds }. With
//                          "first": true, Claude hits it before any answer. With "silent":
//                          true, Codex sends no rate-limit update before the error.
//               auth       fail as a program that is not logged in
//               exit       the program exits mid-turn with this code, as a crash does
//               stop       Claude ends its answer with this stop reason, such as refusal
//               errorInfo  Codex fails a fail rule's turn with this codexErrorInfo
//               usage      the tokens a failed or stopped turn spent:
//                          { "input", "output", "cacheRead", "cacheWrite" }
//               approval   Codex asks the client first, and logs its answer. A string is a command
//                          to run. An object has a kind: "fileChange" ({ path }), "permissions"
//                          ({ network, fileSystem }), "mcp" ({ server, tool }) for a tool call to
//                          approve, "form" ({ server, message }) for a question from an MCP
//                          server, or "question" ({ message }) for the model's own question.
//               listTools  answer with the names of the tools the session has
//               tool       run this shell command as one tool call before the answer. The
//                          delayMs and hold then last through the tool call, so a message sent
//                          meanwhile lands mid-turn. The program reads it after the tool call.
//               mark       Claude writes a file of this name next to FAKE_LOG once the turn
//                          has sent its result, so a test can tell the turn ran to its end
//               noSteer    Codex fails turn/steer during the turn as a Codex before 0.169.0
//                          does, with -32600 for a method it cannot parse
//               notSteerable  Codex refuses turn/steer during the turn with
//                          activeTurnNotSteerable and this turn kind, such as "compact"
//               times      apply the rule to the first N matching requests only. The count
//                          comes from earlier lines in FAKE_LOG, so it holds across processes.
//               slash      true: the rule matches only a message whose last text starts with
//                          "/", since Claude Code reads a slash command only from a message's
//                          last text block. false: only a message whose last text does not. A
//                          leading space counts, so " /x" is not a slash prompt.
//               session    the rule matches only this session's requests. A string is the
//                          session id. { "match": regex } tests the id with a regex.
//               system     a regex. The rule matches only when the session's system text matches
//                          it. Claude: the appended system prompt. Codex: developerInstructions.
//                          A session with no such text has the empty string.
//               recall     true: the answer is the canary words found in this session's earlier
//                          user messages, in the order they first came, joined with one space.
//                          A canary word is an all-caps word of four letters or more, with an
//                          optional dash and number: PLUM, KIWI, PELICAN-4417. With none the
//                          answer is "Nothing to recall." A fork's earlier messages start with
//                          its parent's. With a schema the words go in the value's "result"
//                          field, or in its first string field when it has none.
//               status     a list of statuses the rule answers in turn, one per matching request,
//                          counted as times counts. The last one repeats once the list runs out.
//                          An entry is a status ("done", "working" or "question") or an object
//                          { status, result, message }. The answer is the status object. A field
//                          the entry gives, null included, stays as given. Left out, "done" has
//                          message null and the result the schema makes, and "working" and
//                          "question" have result null and a made-up message. With a schema the
//                          object goes over the value the schema makes.
//                          Without a status rule, a request whose schema is sous's status schema
//                          gets "done", as a model that did the job answers. Its result is the
//                          rule's answer (the text, or the value for the step's own schema), or
//                          the value the schema makes. An answer that is a status object already
//                          goes as it is.
//               goal       Claude: N. The rule matches only a prompt that starts with "/goal".
//                          The turn plays N model turns. Between two of them the session gets a
//                          user message that starts "Stop hook feedback:", as the goal's Stop
//                          hook sends. One result comes after the last. Each model turn logs a
//                          line { goal: { turn, of } }. With a schema the turn stops after its
//                          first model turn and answers the status "working", as the real
//                          program does when the schema cuts the goal short.
//                          Codex: N turns that thread/goal/set plays by itself, each with its own
//                          turn/started and turn/completed. The rule sees "/goal <objective>".
//                          Without a goal rule the goal plays one turn. test/fakes/codex says more.
//               ask        Claude: the model calls AskUserQuestion before it answers. The fake
//                          sends a can_use_tool control request for it and logs the reply as a
//                          line { ask: { behavior, message, interrupt } }, or { ask: { error } }
//                          when the client answers with an error. A deny with interrupt true ends
//                          the turn with no success result. Any other reply goes on to the
//                          answer. true asks a made-up question, a string asks that question.
//                          When --disallowedTools names AskUserQuestion the model never sees the
//                          tool, so the fake logs { ask: { skipped: "disallowed" } } and answers.
// FAKE_DEBUG  a file. Each program appends what it reads and writes, for debugging.
//
// Steering. A message sent into a running turn (Claude: a user message with priority next,
// Codex: turn/steer) adds a line to FAKE_LOG with `steer: { id, text }` and a `state`. Claude
// logs "queued" when it gets the message and "read" when the turn reads it, after its tool call.
// Codex logs "read", or why it refused: "no_active_turn", "wrong_turn", "not_steerable" or
// "unknown_method".
//
// Sessions. Each program keeps a session's user messages, one JSON line { role, text } each, in
// a folder next to FAKE_LOG, and passes them to decide() for recall.
//
// Held programs. Both fakes run more than one turn in one process, as the real ones do. Claude:
// a user message that comes after a result runs as the next turn, with init again. A message
// with priority next during a turn stays a tell. Codex: a second turn/start on an open thread
// runs as the next turn. Its tokenUsage total runs on across the thread's turns, and last is
// each response's own.
//
// Fork and by hand:
//   Fork. Claude: --fork-session with --resume <parent> copies the parent's messages to the new
//   session, named by --session-id or made up, and the turn goes on in the new one alone. Codex:
//   thread/fork with { threadId, cwd } copies them to a new thread in that cwd.
//   By hand. `claude --resume <id>` with no --input-format and no --print, or `codex resume <id>`,
//   is a person in a terminal. The fake appends the line in FAKE_PERSON to the session's
//   messages, logs { byHand: line }, and exits 0 without reading stdin. With FAKE_PERSON unset or
//   empty the person typed nothing. An unknown id fails as a real resume does.

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
  appendFileSync(file, `${JSON.stringify({ ...entry, pid: process.pid })}\n`);
}

function loadRules() {
  const file = process.env.FAKE_RULES;
  if (!file || !existsSync(file)) return [];
  const rules = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(rules) ? rules : [];
}

/** The words that stand in for memory: all caps, four letters or more, maybe a dash and a number. */
const CANARY = /\b[A-Z]{4,}(?:-[0-9]+)?\b/g;

/** The canary words in some texts, each once, in the order they first come. */
export function canaryWords(texts) {
  const words = [];
  for (const text of texts) for (const word of String(text).match(CANARY) ?? []) if (!words.includes(word)) words.push(word);
  return words;
}

/** The user messages a session kept in its file, oldest first. */
export function sessionMessages(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {};
      }
    })
    .filter((entry) => entry.role === "user" && typeof entry.text === "string")
    .map((entry) => entry.text);
}

/** A status object from a status entry: a status, or { status, result, message }. A "done" with
 *  no result leaves it out, so the value the schema makes gives it. */
export function statusObject(entry) {
  const fields = typeof entry === "string" ? { status: entry } : (entry ?? {});
  const status = fields.status ?? "done";
  const done = status === "done";
  const result = "result" in fields ? { result: fields.result } : done ? {} : { result: null };
  return { status, ...result, message: "message" in fields ? fields.message : done ? null : `Fake status ${status}.` };
}

/** True when a request's schema is sous's status schema: status, result and message, with "done". */
export function isStatusSchema(schema) {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return false;
  const names = Object.keys(properties).sort().join(",");
  return names === "message,result,status" && JSON.stringify(properties.status).includes('"done"');
}

/** True when a value is a status object already: a status, and no field but result and message. */
function isStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.status !== "string") return false;
  return Object.keys(value).every((name) => name === "status" || name === "result" || name === "message");
}

/** The value a schema makes, with fields laid over it when it makes an object. */
export function valueWith(schema, fields) {
  const made = schema ? fabricate(schema) : undefined;
  return made && typeof made === "object" && !Array.isArray(made) ? { ...made, ...fields } : { ...fields };
}

/** True when a rule's session field names this session. */
function sameSession(wanted, session) {
  if (typeof session !== "string") return false;
  if (typeof wanted === "string") return wanted === session;
  return typeof wanted?.match === "string" && new RegExp(wanted.match).test(session);
}

/**
 * The answer for one request. Returns { rule, kind, text, value, delayMs, hold, message,
 * resetsAt, first, silent, usage, approval, listTools, tool, notSteerable, noSteer, mark, stop,
 * errorInfo, code, goal, ask }. kind is "answer", "fail", "limit", "auth" or "exit".
 *
 * context holds what a rule may match beyond the prompt: { session, system, earlier, last }, the
 * session id, its system text, the user messages it got before this one and the message's last
 * text, which a slash rule reads (the whole prompt when it is left out). A program that
 * leaves it out gets no match from a rule with session or system, and recalls nothing.
 */
export function decide(program, prompt, schema, context = {}) {
  const rules = loadRules();
  const earlier = readLines();
  let picked;
  for (const [index, rule] of rules.entries()) {
    if (rule.program && rule.program !== program) continue;
    if (rule.match && !new RegExp(rule.match).test(prompt)) continue;
    const last = context.last ?? prompt;
    if (rule.slash !== undefined && last.startsWith("/") !== Boolean(rule.slash)) continue;
    if (rule.goal !== undefined && !/^\/goal(\s|$)/.test(last)) continue;
    if (rule.session !== undefined && !sameSession(rule.session, context.session)) continue;
    if (rule.system !== undefined && !new RegExp(rule.system).test(context.system ?? "")) continue;
    const used = earlier.filter((line) => line.rule === index).length;
    if (rule.times !== undefined && used >= rule.times) continue;
    picked = { index, rule, used };
    break;
  }
  const rule = picked?.rule ?? {};
  const out = { rule: picked?.index ?? null, delayMs: rule.delayMs ?? 0, hold: rule.hold, usage: rule.usage, approval: rule.approval, listTools: rule.listTools === true, tool: rule.tool, notSteerable: rule.notSteerable, noSteer: rule.noSteer === true, mark: rule.mark, stop: rule.stop, errorInfo: rule.errorInfo, goal: rule.goal, ask: rule.ask };
  if (rule.exit !== undefined) return { ...out, kind: "exit", code: rule.exit };
  if (rule.limit) return { ...out, kind: "limit", resetsAt: rule.limit.resetsAt, first: rule.limit.first === true, silent: rule.limit.silent === true };
  if (rule.auth) return { ...out, kind: "auth" };
  if (rule.fail) return { ...out, kind: "fail", message: rule.fail };
  let fields;
  if (Array.isArray(rule.status) && rule.status.length) fields = statusObject(rule.status[Math.min(picked.used, rule.status.length - 1)]);
  if (rule.recall) {
    const words = canaryWords(context.earlier ?? []);
    const said = words.length ? words.join(" ") : "Nothing to recall.";
    if (!schema && !fields) return { ...out, kind: "answer", text: said };
    const value = valueWith(schema, fields ?? {});
    const key = "result" in value || !schema ? "result" : (Object.keys(value).find((name) => typeof value[name] === "string") ?? "result");
    value[key] = said;
    return { ...out, kind: "answer", text: JSON.stringify(value), value };
  }
  if (fields) {
    const value = valueWith(schema, fields);
    return { ...out, kind: "answer", text: JSON.stringify(value), value };
  }
  let value;
  if (schema) {
    value = rule.answer === undefined ? fabricate(schema) : typeof rule.answer === "string" ? parseOr(rule.answer) : rule.answer;
    if (rule.answer !== undefined && isStatusSchema(schema) && !isStatus(value)) value = { status: "done", result: value, message: null };
  }
  const text = schema ? JSON.stringify(value) : typeof rule.answer === "string" ? rule.answer : rule.answer === undefined ? `Fake ${program} answer.` : JSON.stringify(rule.answer);
  return { ...out, kind: "answer", text, value };
}

/** The first limit rule for a program, for a program that reads its limits on request. */
export function limitRule(program) {
  return loadRules().find((rule) => rule.limit && (!rule.program || rule.program === program))?.limit;
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

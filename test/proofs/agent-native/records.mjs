// What a repetition left behind, read back for the checks: the runs and their answers from the
// sous home, the open questions, the home's events.jsonl when this sous writes one, the sous
// calls from the wrapper's log, and the shell commands from the session's stream.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { unparsed: l };
      }
    });
}

/** Each run state file under the home, by run id: runs/projects/<key>/runs/<run>.json. */
function stateFiles(home) {
  const out = new Map();
  const base = join(home, "runs", "projects");
  if (!existsSync(base)) return out;
  for (const key of readdirSync(base)) {
    const dir = join(base, key, "runs");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const m = name.match(/^(.+)\.json$/);
      if (m) out.set(m[1], { state: join(dir, name), events: join(dir, `${m[1]}.events.jsonl`) });
    }
  }
  return out;
}

/** Every run in the home, with its status and the answers its questions got. */
export function readRuns(home) {
  const dir = join(home, "records");
  if (!existsSync(dir)) return [];
  const states = stateFiles(home);
  const runs = [];
  for (const name of readdirSync(dir)) {
    if (!/\.json$/.test(name)) continue;
    const record = readJson(join(dir, name));
    if (!record?.runId) continue;
    const files = states.get(record.runId);
    const state = files ? (readJson(files.state) ?? {}) : {};
    const events = files ? readLines(files.events) : [];
    // When the run took each journal entry, from its event log.
    const takenAt = new Map();
    for (const line of events) {
      const ev = line.event;
      if (ev?.type === "journal" && ev.entry) takenAt.set(`${ev.scope ?? record.runId}#${ev.entry.index}`, line.timestamp);
    }
    const answers = (state.journal ?? [])
      .filter((j) => j.kind === "checkpoint" || j.call?.kind === "checkpoint")
      .map((j) => ({
        runId: record.runId,
        question: `${j.scope ?? record.runId}--${j.index}`,
        value: j.result,
        at: takenAt.get(`${j.scope ?? record.runId}#${j.index}`),
      }));
    runs.push({
      runId: record.runId,
      workflow: record.workflow,
      origin: record.origin,
      createdAt: record.createdAt,
      rerunOf: record.rerunOf,
      startedByRun: record.startedByRun,
      status: state.status,
      pauseReason: state.pauseReason,
      reason: state.reason,
      result: state.result,
      answers,
    });
  }
  return runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** The questions still open, from the inbox folder. */
export function readOpenQuestions(home) {
  const dir = join(home, "inbox");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/\.json$/.test(name) || /\.answer\.json$/.test(name)) continue;
    const q = readJson(join(dir, name));
    if (q?.id) out.push(q);
  }
  return out;
}

/** The home's events.jsonl, written by the agent-native sous. Undefined when this sous has none. */
export function readHomeEvents(home) {
  const file = join(home, "events.jsonl");
  return existsSync(file) ? readLines(file) : undefined;
}

/** The workflow files of the project, by name, with their text. */
export function readWorkflowFiles(project) {
  const dir = join(project, ".sous", "workflows");
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) out[name] = readFileSync(join(dir, name), "utf8");
  return out;
}

// ── sous calls ──

/** Split a command line into words, with quotes. Good enough for sous calls. */
export function words(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The parts of one sous call: its subcommand, its positionals and its flags. */
export function parseCall(args) {
  const list = Array.isArray(args) ? args : words(args);
  const start = list[0] === "sous" || /\/sous$/.test(list[0] ?? "") ? 1 : 0;
  const rest = list.slice(start);
  const positionals = [];
  const flags = new Set();
  for (const word of rest) {
    if (word.startsWith("--")) flags.add(word.split("=")[0]);
    else positionals.push(word);
  }
  const sub = positionals.shift() ?? "";
  // `sous workflows approve x` and `sous schedule list` have a second word.
  if (["workflows", "schedule", "daemon", "account", "skill", "hook"].includes(sub) && positionals.length && /^[a-z]+$/.test(positionals[0])) {
    return { sub: `${sub} ${positionals.shift()}`, positionals, flags };
  }
  return { sub, positionals, flags };
}

/** The wrapper's log as one entry per call, in start order, each with the turn it began in. */
export function readCalls(file, turns) {
  const lines = readLines(file);
  const byId = new Map();
  for (const line of lines) {
    if (line.phase === "start") byId.set(line.id, { ...line, ...parseCall(line.args) });
    else if (line.phase === "end" && byId.has(line.id)) Object.assign(byId.get(line.id), { exit: line.exit, signal: line.signal, ms: line.ms, stdout: line.stdout, stderr: line.stderr, ended: true });
  }
  const calls = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
  for (const call of calls) {
    call.turn = turns.findIndex((t) => call.at >= t.startedAt && call.at <= t.endedAt);
    call.json = parseJsonOut(call.stdout);
  }
  return calls;
}

function parseJsonOut(text) {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
}

/** A wait: `sous wait`, or a start or resume that follows the run with --wait. */
export const isWait = (call) => call.sub === "wait" || (["run", "resume", "rerun"].includes(call.sub) && call.flags.has("--wait"));

/** A decision on a question. */
export const isAnswer = (call) => ["answer", "approve", "send-back"].includes(call.sub);

/** A call that changes a run or a workflow, as opposed to one that only reads. */
export const isChange = (call) => isAnswer(call) || ["run", "resume", "rerun", "pause", "stop", "discard", "prune", "gc", "workflows approve", "tell"].includes(call.sub);

/**
 * Whether a call was refused. A wait's exit codes 1 to 4 tell how the run went, so they are not
 * refusals. A JSON reply with an `error` is one, and so is any other non-zero exit.
 */
export function isRefusal(call) {
  if (!call.ended || call.signal) return false;
  if (call.json && typeof call.json === "object" && call.json.error) return true;
  if (call.exit === 0) return false;
  if (isWait(call) && [1, 2, 3, 4, 5].includes(call.exit)) return false;
  return true;
}

/**
 * The calls a refusal names. The agent-native sous gives one in `error.call`. Today's sous names
 * calls in its text, such as "sous resume x --latest takes the new version".
 */
export function refusalCalls(call) {
  const error = call.json?.error;
  // A refusal that offers a choice gives one call and names the other in its message.
  if (error && typeof error.call === "string" && error.call.trim()) return { calls: [error.call.trim(), ...callsIn(error.message)], from: "error.call" };
  if (error && Array.isArray(error.calls)) return { calls: error.calls.filter((c) => typeof c === "string"), from: "error.call" };
  return { calls: callsIn(`${call.stderr ?? ""}\n${typeof error?.message === "string" ? error.message : ""}`), from: "text" };
}

/** The sous calls a text names. */
function callsIn(text) {
  if (typeof text !== "string") return [];
  const found = [];
  const list = words(text.replace(/[`"]/g, " "));
  for (let i = 0; i < list.length; i++) {
    if (list[i] !== "sous") continue;
    const parts = ["sous"];
    for (let j = i + 1; j < list.length; j++) {
      const w = list[j].replace(/[.,;:)]+$/, "");
      const idLike = /\d/.test(w) && /^[\w.-]+$/.test(w);
      const ok = (j === i + 1 && /^[a-z][\w-]*$/.test(w)) || w.startsWith("--") || w.startsWith("<") || idLike;
      if (!ok) break;
      parts.push(w);
      if (list[j] !== w) break; // the word ended a sentence
    }
    if (parts.length > 1 && !["lists", "runs", "is"].includes(parts[1])) found.push(parts.join(" "));
  }
  return found;
}

/** Whether `actual` is the call `wanted` names. Placeholders such as <red|blue> match any word. */
export function sameCall(wanted, actual) {
  const w = parseCall(wanted);
  if (w.sub !== actual.sub) return false;
  if (w.positionals.length !== actual.positionals.length) return false;
  for (let i = 0; i < w.positionals.length; i++) {
    const p = w.positionals[i];
    if (p.startsWith("<") || p === "...") continue;
    if (p !== actual.positionals[i]) return false;
  }
  for (const flag of w.flags) if (flag !== "--json" && !actual.flags.has(flag)) return false;
  return true;
}

// ── shell commands ──

const SLEEP = /(^|[\s;&|(`])sleep\s+\d/;
const LOOP = /\b(while|until|for)\b[\s\S]*\bdo\b|\bwatch\s/;
const READS = /\bsous\s+(show|list|status|inbox|log)\b/;

/** How the session waited: sleeps, shell loops over sous reads, and the same read twice in a row. */
export function waiting(commands, calls) {
  const sleeps = commands.filter((c) => SLEEP.test(c.command)).length;
  const loops = commands.filter((c) => LOOP.test(c.command) && READS.test(c.command)).length;
  let repeats = 0;
  for (let i = 1; i < calls.length; i++) {
    const a = calls[i - 1];
    const b = calls[i];
    if (["show", "list", "status", "inbox", "log"].includes(b.sub) && a.sub === b.sub && a.args.join(" ") === b.args.join(" ")) repeats++;
  }
  return { sleeps, loops, repeatedReads: repeats, polled: loops > 0 || repeats > 0 };
}

/** The sous calls the session tried, from its commands, including the ones it was denied. */
export function sousInCommands(commands) {
  let n = 0;
  for (const c of commands) n += (c.command.match(/(^|[\s;&|(`])(\S*\/)?sous\s+[a-z]/g) ?? []).length;
  return n;
}

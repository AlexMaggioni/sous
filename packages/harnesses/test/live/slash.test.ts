// Live tests 1, 4, 6 and 8 of the workflow shape: slash prompts on Claude Code. A slash prompt with
// a note still runs its command, a /goal turn and a report turn after it, whether the goal
// evaluator's tokens reach the usage sous reports, and whether skills load as they do by hand.
//
// It is off by default. It needs Claude Code and your own login, so run it from packages/harnesses
// without test/with-temp-home.mjs:
//
//   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID SOUS_LIVE_SLASH=1 ../../node_modules/.bin/tsx --test test/live/slash.test.ts
//
// Every turn runs on haiku at low effort. Each project is a new temporary folder. The test reads the
// program's folder (CLAUDE_CONFIG_DIR, or ~/.claude) to find what is installed and writes nothing
// there. Claude Code keeps its session files there, as a session opened by hand does.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { query, type SDKMessage, type SDKResultMessage, type SDKSystemMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createHarness } from "../../src/index.js";
import type { HistoryEntry, Step, StepResult } from "../../src/index.js";

const ON = process.env.SOUS_LIVE_SLASH === "1";
const MODEL = "haiku";
const EFFORT = "low";
const WORD = "PELICAN-4417";
const GOAL = "/goal The file done.txt in the current folder holds exactly the text OK";
const REPORT = "Report your status: done or working, and the result in one line.";
const STATUS_SCHEMA = {
  type: "object",
  properties: { status: { type: "string", enum: ["done", "working"] }, result: { type: "string" } },
  required: ["status", "result"],
  additionalProperties: false,
};

const harness = createHarness("claude");
const programFolder = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/** A new project folder with the canary skill, which only a slash prompt runs. */
function project(name: string): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), `sous-live-slash-${name}-`)));
  mkdirSync(join(cwd, ".claude", "skills", "canary"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude", "skills", "canary", "SKILL.md"),
    `---\nname: canary\ndescription: Answers a fixed word.\ndisable-model-invocation: true\n---\n\nAnswer with only the word ${WORD} and nothing else.\n`,
  );
  return cwd;
}

/** Runs one step on haiku at low effort, and says what it cost and how long it ran. */
async function step(t: TestContext, what: string, fields: Omit<Step, "model" | "effort">, onHistory?: (entry: HistoryEntry) => void): Promise<StepResult> {
  const start = Date.now();
  const result = await harness.run({ ...fields, model: MODEL, effort: EFFORT }, { history: (entry) => onHistory?.(entry) });
  t.diagnostic(`${what}: ${JSON.stringify(result.text.slice(0, 200))}, ${result.usage.total} tokens, $${result.usage.costUsd ?? "?"}, ${Date.now() - start} ms`);
  return result;
}

/** Starts the goal and stops the step once Claude Code says the goal is set, before the agent meets it. */
async function goalLeftSet(t: TestContext, cwd: string): Promise<string> {
  const stop = new AbortController();
  let sessionId = "";
  await assert.rejects(
    harness.run(
      { prompt: GOAL, cwd, model: MODEL, effort: EFFORT, signal: stop.signal },
      {
        session: (id) => (sessionId = id),
        history: (entry) => {
          if (entry.role === "assistant" && entry.text.startsWith("Goal set")) stop.abort();
        },
      },
    ),
    (error: { failure?: { kind: string } }) => error.failure?.kind === "stopped",
  );
  t.diagnostic(`goal stopped before it was met, done.txt exists: ${existsSync(join(cwd, "done.txt"))}`);
  return sessionId;
}

function assertStatus(value: unknown) {
  assert.ok(value && typeof value === "object", `no status object: ${JSON.stringify(value)}`);
  const object = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(object).sort(), ["result", "status"]);
  assert.ok(object.status === "done" || object.status === "working", `status ${JSON.stringify(object.status)}`);
  assert.equal(typeof object.result, "string");
}

/** The session file Claude Code wrote, searched depth first under its projects folder. */
function sessionFile(sessionId: string, folder = join(programFolder(), "projects")): string | undefined {
  if (!existsSync(folder)) return undefined;
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) {
      const found = sessionFile(sessionId, path);
      if (found) return found;
    } else if (name === `${sessionId}.jsonl`) return path;
  }
  return undefined;
}

/** One query() as sous makes it: an open prompt stream, closed after the first result. */
async function raw(cwd: string, prompt: string): Promise<SDKMessage[]> {
  const found = harness.find();
  assert.ok("path" in found, "Claude Code is not installed");
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null };
    await released;
  }
  const q = query({
    prompt: messages(),
    options: {
      pathToClaudeCodeExecutable: found.path,
      cwd,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      model: MODEL,
      effort: EFFORT,
      canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
    },
  });
  const seen: SDKMessage[] = [];
  try {
    for await (const message of q) {
      seen.push(message);
      if (message.type === "result") break;
    }
  } finally {
    release();
    q.close();
  }
  return seen;
}

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const sum = (tokens: Tokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

/** The tokens one turn spent, read three ways from the SDK's raw messages. */
function readings(messages: SDKMessage[]) {
  const result = messages.find((message): message is SDKResultMessage => message.type === "result");
  assert.ok(result, "the turn sent no result");
  // What claude/run.ts reports: the result's usage.
  const reported: Tokens = {
    input: result.usage.input_tokens ?? 0,
    output: result.usage.output_tokens ?? 0,
    cacheRead: result.usage.cache_read_input_tokens ?? 0,
    cacheWrite: result.usage.cache_creation_input_tokens ?? 0,
  };
  // Every assistant message of the main loop, once per message id.
  const perMessage = new Map<string, Tokens>();
  for (const message of messages) {
    if (message.type !== "assistant" || message.message.model === "<synthetic>") continue;
    const u = message.message.usage;
    perMessage.set(message.message.id, { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 });
  }
  const mainLoop = [...perMessage.values()].reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  // Every model call of the query, by model.
  const all: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const usage of Object.values(result.modelUsage)) {
    all.input += usage.inputTokens;
    all.output += usage.outputTokens;
    all.cacheRead += usage.cacheReadInputTokens;
    all.cacheWrite += usage.cacheCreationInputTokens;
  }
  const gap: Tokens = { input: all.input - reported.input, output: all.output - reported.output, cacheRead: all.cacheRead - reported.cacheRead, cacheWrite: all.cacheWrite - reported.cacheWrite };
  return { result, reported, mainLoop, all, gap, models: Object.keys(result.modelUsage), costUsd: result.total_cost_usd };
}

/** The name a skill folder gives: its SKILL.md's name, else the folder's own name. */
function skillName(folder: string): string | undefined {
  const file = join(folder, "SKILL.md");
  if (!existsSync(file)) return undefined;
  const named = /^name:\s*(.+?)\s*$/m.exec(readFileSync(file, "utf8"));
  return named?.[1] ?? folder.split("/").pop();
}

/** The first user skill installed, by folder order. */
function userSkill(): string | undefined {
  const folder = harness.places().skills;
  if (!existsSync(folder)) return undefined;
  for (const name of readdirSync(folder).sort()) {
    if (name.startsWith(".")) continue;
    const found = skillName(join(folder, name));
    if (found) return found;
  }
  return undefined;
}

/** The first skill or command of a plugin installed for the user and turned on in their settings, as `plugin:name`. */
function pluginSkill(): string | undefined {
  const folder = programFolder();
  const read = (path: string) => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  const installed = read(join(folder, "plugins", "installed_plugins.json"))?.plugins as Record<string, { scope: string; installPath: string }[]> | undefined;
  const enabled = (read(join(folder, "settings.json"))?.enabledPlugins ?? {}) as Record<string, boolean>;
  for (const [key, copies] of Object.entries(installed ?? {})) {
    if (enabled[key] !== true) continue;
    const copy = copies.find((entry) => entry.scope === "user" && existsSync(entry.installPath));
    if (!copy) continue;
    const plugin = (read(join(copy.installPath, ".claude-plugin", "plugin.json"))?.name as string | undefined) ?? key.split("@")[0]!;
    const skills = join(copy.installPath, "skills");
    for (const name of existsSync(skills) ? readdirSync(skills).sort() : []) {
      if (existsSync(join(skills, name, "SKILL.md"))) return `${plugin}:${name}`;
    }
    const commands = join(copy.installPath, "commands");
    for (const name of existsSync(commands) ? readdirSync(commands).sort() : []) {
      if (name.endsWith(".md")) return `${plugin}:${name.slice(0, -3)}`;
    }
  }
  return undefined;
}

describe("slash prompts on Claude Code", { skip: !ON && "set SOUS_LIVE_SLASH=1 to run" }, () => {
  test("1. /canary with no note runs the project skill", { timeout: 180_000 }, async (t) => {
    const result = await step(t, "/canary", { prompt: "/canary", cwd: project("canary") });
    assert.match(result.text, new RegExp(WORD));
  });

  test("1. /canary with a note still runs the project skill", { timeout: 180_000 }, async (t) => {
    const result = await step(t, "/canary with a note", { prompt: "/canary", note: "The person adds: keep it short.", cwd: project("canary-note") });
    assert.match(result.text, new RegExp(WORD), "Claude Code did not run /canary when the note came with it");
  });

  test("4. /goal runs with no schema, then a report turn with resume returns the status object", { timeout: 300_000 }, async (t) => {
    const cwd = project("goal");
    const goal = await step(t, "/goal", { prompt: GOAL, cwd });
    assert.equal(readFileSync(join(cwd, "done.txt"), "utf8").trim(), "OK");
    const report = await step(t, "report", { prompt: REPORT, cwd, resume: goal.sessionId, schema: STATUS_SCHEMA });
    assert.equal(report.sessionId, goal.sessionId);
    assertStatus(report.value);
    t.diagnostic(`report value: ${JSON.stringify(report.value)}`);
    // A met goal clears itself. /goal with no condition reports it and calls no model.
    const after = await step(t, "/goal after it was met", { prompt: "/goal", cwd, resume: goal.sessionId });
    assert.match(after.text, /No goal set/);
  });

  test("4. a later turn on a session whose goal is still set", { timeout: 300_000 }, async (t) => {
    const cwd = project("goal-left");
    const sessionId = await goalLeftSet(t, cwd);
    const before = await step(t, "/goal after the stop", { prompt: "/goal", cwd, resume: sessionId });
    assert.match(before.text, /Goal active/);

    const report = await step(t, "report on the set goal", { prompt: REPORT, cwd, resume: sessionId, schema: STATUS_SCHEMA }, (entry) => {
      if (entry.kind !== "text") t.diagnostic(`  ${entry.role} ${entry.kind} ${entry.text.slice(0, 120).replaceAll("\n", " ")}`);
    });
    assertStatus(report.value);
    const file = sessionFile(sessionId);
    const feedback = file ? readFileSync(file, "utf8").split("\n").filter((line) => line.includes("Stop hook feedback")).length : -1;
    t.diagnostic(`report value: ${JSON.stringify(report.value)}`);
    t.diagnostic(`done.txt after the report turn: ${existsSync(join(cwd, "done.txt"))}, Stop hook feedback lines in the session file: ${feedback}`);

    const after = await step(t, "/goal after the report", { prompt: "/goal", cwd, resume: sessionId });
    t.diagnostic(`goal after the report turn: ${after.text}`);
  });

  test("4. /goal clear clears a goal that is still set", { timeout: 300_000 }, async (t) => {
    const cwd = project("goal-clear");
    const sessionId = await goalLeftSet(t, cwd);
    await step(t, "/goal clear", { prompt: "/goal clear", cwd, resume: sessionId });
    const after = await step(t, "/goal after clear", { prompt: "/goal", cwd, resume: sessionId });
    assert.match(after.text, /No goal set/);
  });

  test("6. whether the goal evaluator's tokens are in the usage sous reports", { timeout: 300_000 }, async (t) => {
    const show = (what: string, messages: SDKMessage[]) => {
      const read = readings(messages);
      t.diagnostic(`${what}: models ${read.models.join(", ")}, $${read.costUsd}`);
      t.diagnostic(`  result.usage, which sous reports: ${JSON.stringify(read.reported)} = ${sum(read.reported)}`);
      t.diagnostic(`  main loop assistant messages:     ${JSON.stringify(read.mainLoop)} = ${sum(read.mainLoop)}`);
      t.diagnostic(`  modelUsage, every model call:     ${JSON.stringify(read.all)} = ${sum(read.all)}`);
      t.diagnostic(`  modelUsage minus result.usage:    ${JSON.stringify(read.gap)} = ${sum(read.gap)}`);
      return read;
    };
    const start = Date.now();
    const plain = show("plain turn", await raw(project("usage-plain"), "Reply only OK."));
    const goal = show("goal turn", await raw(project("usage-goal"), GOAL));
    t.diagnostic(`two turns in ${Date.now() - start} ms`);
    assert.equal(plain.result.subtype, "success");
    assert.equal(goal.result.subtype, "success");
    // modelUsage covers every call of the query, so it never counts fewer tokens than the main loop.
    assert.ok(sum(goal.all) >= sum(goal.reported));
  });

  test("8. the project skill, a user skill and a plugin skill load as they do by hand", { timeout: 180_000 }, async (t) => {
    // /goal with no condition answers by itself, so the init message comes at no model cost.
    // Test 1 shows that the project skill runs. Nothing here runs a skill.
    const messages = await raw(project("skills"), "/goal");
    const init = messages.find((message): message is SDKSystemMessage => message.type === "system" && message.subtype === "init");
    assert.ok(init, "no init message");
    const listed = new Set([...init.skills, ...init.slash_commands]);
    t.diagnostic(`Claude Code ${init.claude_code_version}, ${init.skills.length} skills, ${init.slash_commands.length} slash commands, plugins ${init.plugins.map((plugin) => plugin.name).join(", ")}`);
    assert.ok(init.skills.includes("canary"), "the project skill canary is not in the init message's skills");

    const user = userSkill();
    if (user) {
      t.diagnostic(`user skill: ${user}`);
      assert.ok(listed.has(user), `the user skill ${user} is not in the init message's skills or slash commands`);
    } else t.diagnostic(`no user skill installed under ${harness.places().skills}, so that part is skipped`);

    const plugin = pluginSkill();
    if (plugin) {
      t.diagnostic(`plugin skill: ${plugin}`);
      assert.ok(listed.has(plugin), `the plugin skill ${plugin} is not in the init message's skills or slash commands`);
    } else t.diagnostic(`no plugin installed for the user and turned on in ${programFolder()}/settings.json, so that part is skipped`);
  });
});

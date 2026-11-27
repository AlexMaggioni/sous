// The fake claude's rules for the scenario tests: recall, fork, slash, status, system, session,
// goal, a person who steps in by hand, and the native question tool. Each test drives the fake
// through the Claude adapter where the adapter can, and through the SDK or a plain spawn where it
// cannot yet (fork, ask, by hand). test/fakes/lib.mjs documents each rule.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { query, type CanUseTool, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createHarness } from "../src/index.js";
import type { HistoryEntry, Step } from "../src/index.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
const CLAUDE = join(FAKES, "claude");

if (!process.env.HOME || process.env.HOME === userInfo().homedir || !existsSync(process.env.HOME)) process.env.HOME = mkdtempSync(join(tmpdir(), "fake-rules-home-"));
const ROOT = mkdtempSync(join(process.env.HOME, "fake-rules-"));
delete process.env.FAKE_VERSION;

/** One line of the fake's request log. */
interface LogLine {
  sessionId: string;
  prompt?: string;
  rule?: number | null;
  goal?: { turn: number; of: number };
  ask?: { behavior?: string; message?: string; interrupt?: boolean; error?: string; skipped?: string };
  byHand?: string;
}

const STATUS_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "working", "question"] },
    result: { type: ["string", "null"] },
    message: { type: ["string", "null"] },
  },
  required: ["status", "result", "message"],
  additionalProperties: false,
};

/** A folder with the fake's log, rules and sessions, and the adapter on it. */
function newCase() {
  const dir = mkdtempSync(join(ROOT, "case-"));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  mkdirSync(join(dir, "account"));
  const log = join(dir, "fake.log");
  const rules = join(dir, "rules.json");
  writeFileSync(rules, "[]");
  process.env.FAKE_LOG = log;
  process.env.FAKE_RULES = rules;
  const harness = createHarness("claude", { path: CLAUDE, env: {} });
  return {
    dir,
    cwd,
    rules: (list: object[]) => writeFileSync(rules, JSON.stringify(list)),
    lines: (): LogLine[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine) : []),
    transcript: (id: string) => readFileSync(join(dir, "claude-sessions", id), "utf8"),
    run: (fields: Partial<Step> & { prompt: string }, history?: (entry: HistoryEntry) => void) =>
      harness.run({ cwd, account: { folder: join(dir, "account") }, ...fields }, history ? { history } : {}),
  };
}

/** One query() of the SDK on the fake, with an open prompt stream that closes at the first result. */
async function sdkTurn(cwd: string, prompt: string, options: Partial<Options> = {}): Promise<SDKMessage[]> {
  let ended!: () => void;
  const done = new Promise<void>((resolve) => (ended = resolve));
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null };
    await done;
  }
  const messages: SDKMessage[] = [];
  const q = query({ prompt: input(), options: { pathToClaudeCodeExecutable: CLAUDE, cwd, ...options } });
  try {
    for await (const message of q) {
      messages.push(message);
      if (message.type === "result") ended();
    }
  } finally {
    ended();
    q.close();
  }
  return messages;
}

/** The fake started as a person starts it in a terminal. stdin stays open, as a terminal's does. */
function byHand(id: string, person: string | undefined): Promise<{ code: number | null; stderr: string }> {
  const env = { ...process.env };
  if (person === undefined) delete env.FAKE_PERSON;
  else env.FAKE_PERSON = person;
  const child = spawn(CLAUDE, ["--resume", id], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the fake waited on stdin"));
    }, 5000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

const text = (message: SDKMessage): string => {
  if (message.type !== "user" && message.type !== "assistant") return "";
  const content = message.message.content;
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string }>).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
};

describe("the fake claude's rules", () => {
  test("recall answers with the canary words of the same session only", async () => {
    const c = newCase();
    c.rules([{ match: "^Recall", recall: true }]);
    const plum = await c.run({ prompt: "Remember the word PLUM." });
    const pelican = await c.run({ prompt: "Remember PELICAN-4417 for later." });
    const first = await c.run({ prompt: "Recall your words.", resume: plum.sessionId });
    const second = await c.run({ prompt: "Recall your words.", resume: pelican.sessionId });
    assert.equal(first.text, "PLUM");
    assert.equal(second.text, "PELICAN-4417");
    const fresh = await c.run({ prompt: "Recall your words." });
    assert.doesNotMatch(fresh.text, /PLUM|PELICAN/);
  });

  test("a resume reports the session's whole cost so far, as Claude Code does, and a new session starts at its own", async () => {
    const c = newCase();
    const first = await c.run({ prompt: "Remember the word PLUM." });
    const turn = first.usage.costUsd;
    assert.ok(turn !== undefined && turn > 0, "a turn reports a cost");
    const second = await c.run({ prompt: "Go on.", resume: first.sessionId });
    const third = await c.run({ prompt: "Go on.", resume: first.sessionId });
    const other = await c.run({ prompt: "Remember the word KIWI." });
    const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
    near(second.usage.costUsd, turn * 2);
    near(third.usage.costUsd, turn * 3);
    near(other.usage.costUsd, turn);
  });

  test("a fork starts with its parent's transcript, and the parent never learns the fork's words", async () => {
    const c = newCase();
    c.rules([{ match: "^Recall", recall: true }]);
    const parent = await c.run({ prompt: "Remember the word PLUM." });
    const before = c.transcript(parent.sessionId);
    const forkId = randomUUID();
    const forked = await sdkTurn(c.cwd, "Remember KIWI too.", { resume: parent.sessionId, forkSession: true, sessionId: forkId });
    assert.ok(forked.some((message) => message.type === "result" && message.session_id === forkId));
    assert.equal(c.transcript(parent.sessionId), before);
    const fork = await c.run({ prompt: "Recall your words.", resume: forkId });
    assert.equal(fork.text, "PLUM KIWI");
    const again = await c.run({ prompt: "Recall your words.", resume: parent.sessionId });
    assert.equal(again.text, "PLUM");
  });

  test("slash matches a prompt that starts with / only", async () => {
    const c = newCase();
    c.rules([{ slash: true, answer: "ran a command" }]);
    assert.equal((await c.run({ prompt: "/x" })).text, "ran a command");
    assert.equal((await c.run({ prompt: " /x" })).text, "Fake claude answer.");
    assert.equal((await c.run({ prompt: "x /y" })).text, "Fake claude answer.");
  });

  test("status answers the status schema with the given statuses in turn", async () => {
    const c = newCase();
    c.rules([{ status: ["working", "working", { status: "done", result: "ok", message: "All tests pass." }] }]);
    const first = await c.run({ prompt: "Do the task.", schema: STATUS_SCHEMA });
    const second = await c.run({ prompt: "Continue the task.", schema: STATUS_SCHEMA, resume: first.sessionId });
    const third = await c.run({ prompt: "Continue the task.", schema: STATUS_SCHEMA, resume: first.sessionId });
    const values = [first, second, third].map((answer) => answer.value as { status: string; result: unknown; message: unknown });
    assert.deepEqual(
      values.map((value) => value.status),
      ["working", "working", "done"],
    );
    assert.equal(values[0]?.result, null);
    assert.equal(typeof values[0]?.message, "string");
    assert.deepEqual(values[2], { status: "done", result: "ok", message: "All tests pass." });
  });

  test("system and session matchers pick the rule for one session", async () => {
    const c = newCase();
    const plain = await c.run({ prompt: "Start." });
    c.rules([
      { system: "Task label: reviewer", answer: "reviewer rule" },
      { session: plain.sessionId, answer: "session rule" },
      { session: { match: "^no-such-" }, answer: "never" },
      { answer: "default rule" },
    ]);
    assert.equal((await c.run({ prompt: "Continue the task.", instructions: "Task label: reviewer" })).text, "reviewer rule");
    assert.equal((await c.run({ prompt: "Continue the task.", instructions: "Task label: implementer" })).text, "default rule");
    assert.equal((await c.run({ prompt: "Continue the task.", resume: plain.sessionId })).text, "session rule");
    assert.equal((await c.run({ prompt: "Continue the task." })).text, "default rule");
  });

  test("a session matcher takes a regex on the id", async () => {
    const c = newCase();
    const plain = await c.run({ prompt: "Start." });
    c.rules([{ session: { match: `^${plain.sessionId.slice(0, 8)}` }, answer: "regex rule" }]);
    assert.equal((await c.run({ prompt: "Continue the task.", resume: plain.sessionId })).text, "regex rule");
    assert.equal((await c.run({ prompt: "Continue the task." })).text, "Fake claude answer.");
  });

  test("goal plays its model turns with Stop hook feedback between them, and sends one result", async () => {
    const c = newCase();
    c.rules([{ goal: 3, answer: "The goal is met." }]);
    const messages = await sdkTurn(c.cwd, "/goal the tests pass");
    const results = messages.filter((message) => message.type === "result");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.type === "result" && results[0].subtype === "success" ? results[0].result : undefined, "The goal is met.");
    assert.equal(messages.filter((message) => message.type === "assistant").length, 3);
    const feedback = messages.filter((message) => message.type === "user" && !("isReplay" in message && message.isReplay) && text(message).startsWith("Stop hook feedback:"));
    assert.equal(feedback.length, 2);
    const turns = c.lines().filter((line) => line.goal);
    assert.deepEqual(
      turns.map((line) => line.goal),
      [1, 2, 3].map((turn) => ({ turn, of: 3 })),
    );
    // The transcript keeps the feedback lines, as the real one does.
    const id = turns[0]?.sessionId ?? "";
    assert.equal(c.transcript(id).split("\n").filter((line) => line.includes("Stop hook feedback:")).length, 2);
  });

  test("goal shows its turns in the step's history, and a prompt that is not /goal plays one turn", async () => {
    const c = newCase();
    c.rules([{ goal: 3, answer: "The goal is met." }]);
    const history: HistoryEntry[] = [];
    const answer = await c.run({ prompt: "/goal the tests pass" }, (entry) => history.push(entry));
    assert.equal(answer.text, "The goal is met.");
    assert.equal(history.filter((entry) => entry.role === "assistant" && entry.kind === "text").length, 3);
    const plain = await c.run({ prompt: "the tests pass /goal" });
    assert.equal(plain.text, "Fake claude answer.");
    assert.equal(c.lines().filter((line) => line.goal).length, 3);
  });

  test("goal with a schema ends after one model turn and answers working", async () => {
    const c = newCase();
    c.rules([{ goal: 3, answer: "The goal is met." }]);
    const answer = await c.run({ prompt: "/goal the tests pass", schema: STATUS_SCHEMA });
    assert.equal((answer.value as { status: string }).status, "working");
    assert.deepEqual(
      c.lines().filter((line) => line.goal).map((line) => line.goal),
      [{ turn: 1, of: 3 }],
    );
  });

  test("by hand appends the person's line, exits 0 without reading stdin, and recall sees it", async () => {
    const c = newCase();
    c.rules([{ match: "^Recall", recall: true }]);
    const step = await c.run({ prompt: "Remember the word PLUM." });
    const ran = await byHand(step.sessionId, "Also keep KIWI in mind.");
    assert.equal(ran.code, 0, ran.stderr);
    const last = c.transcript(step.sessionId).trim().split("\n").at(-1) ?? "";
    assert.deepEqual(JSON.parse(last), { role: "user", text: "Also keep KIWI in mind." });
    const recalled = await c.run({ prompt: "Recall your words.", resume: step.sessionId });
    assert.equal(recalled.text, "PLUM KIWI");
  });

  test("by hand on an unknown session fails as a real resume does", async () => {
    newCase();
    const ran = await byHand(randomUUID(), "Hello.");
    assert.notEqual(ran.code, 0);
    assert.match(ran.stderr, /No conversation found/);
  });

  test("ask sends a can_use_tool request for AskUserQuestion and logs a deny with interrupt", async () => {
    const c = newCase();
    c.rules([{ ask: true, answer: "I went on." }]);
    const asked: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const canUseTool: CanUseTool = async (tool, input) => {
      asked.push({ tool, input });
      return { behavior: "deny", message: "Put the question in your answer.", interrupt: true };
    };
    const messages = await sdkTurn(c.cwd, "Do the task.", { canUseTool });
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.tool, "AskUserQuestion");
    assert.ok(Array.isArray(asked[0]?.input.questions));
    const replies = c.lines().filter((line) => line.ask);
    assert.deepEqual(
      replies.map((line) => line.ask),
      [{ behavior: "deny", message: "Put the question in your answer.", interrupt: true }],
    );
    const results = messages.filter((message) => message.type === "result");
    assert.equal(results.length, 1);
    assert.ok(results.every((message) => message.type === "result" && (message.subtype !== "success" || message.is_error)));
  });

  test("ask goes on to its answer after a deny without interrupt", async () => {
    const c = newCase();
    c.rules([{ ask: true, answer: "I went on." }]);
    const canUseTool: CanUseTool = async () => ({ behavior: "deny", message: "Ask in your answer instead." });
    const messages = await sdkTurn(c.cwd, "Do the task.", { canUseTool });
    const result = messages.find((message) => message.type === "result");
    assert.ok(result?.type === "result" && result.subtype === "success" && !result.is_error);
    assert.equal(result.result, "I went on.");
    assert.deepEqual(
      c.lines().filter((line) => line.ask).map((line) => line.ask),
      [{ behavior: "deny", message: "Ask in your answer instead.", interrupt: false }],
    );
  });

  test("ask does not ask when the tool is disallowed, as the model never sees it", async () => {
    const c = newCase();
    c.rules([{ ask: true, answer: "I went on." }]);
    const answer = await c.run({ prompt: "Do the task." });
    assert.equal(answer.text, "I went on.");
    assert.deepEqual(
      c.lines().filter((line) => line.ask).map((line) => line.ask),
      [{ skipped: "disallowed" }],
    );
  });
});

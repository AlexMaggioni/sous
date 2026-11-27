// The fake codex's rules for the scenario tests: recall, status, system, session, fork, a person
// who steps in by hand with `codex resume <id>`, and a goal set with thread/goal/set. Each test
// drives the fake through the Codex adapter where the adapter can, and over JSON-RPC on stdio or a
// plain spawn where it cannot yet (fork, goal, by hand). test/fakes/lib.mjs documents each rule.

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHarness } from "../src/index.js";
import type { Step } from "../src/index.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
const CODEX = join(FAKES, "codex");

if (!process.env.HOME || process.env.HOME === userInfo().homedir || !existsSync(process.env.HOME)) process.env.HOME = mkdtempSync(join(tmpdir(), "fake-codex-rules-home-"));
const ROOT = mkdtempSync(join(process.env.HOME, "fake-codex-rules-"));
delete process.env.FAKE_VERSION;

/** One line of the fake's request log. */
interface LogLine {
  sessionId: string;
  cwd?: string;
  prompt?: string;
  rule?: number | null;
  goal?: { turn: number; of: number };
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

/** A folder with the fake's log, rules and threads, and the adapter on it. */
function newCase() {
  const dir = mkdtempSync(join(ROOT, "case-"));
  const cwd = join(dir, "project");
  const account = join(dir, "account");
  mkdirSync(cwd);
  mkdirSync(account);
  const log = join(dir, "fake.log");
  const rules = join(dir, "rules.json");
  writeFileSync(rules, "[]");
  process.env.FAKE_LOG = log;
  process.env.FAKE_RULES = rules;
  const harness = createHarness("codex", { path: CODEX, env: {} });
  return {
    dir,
    cwd,
    account,
    rules: (list: object[]) => writeFileSync(rules, JSON.stringify(list)),
    lines: (): LogLine[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine) : []),
    transcript: (id: string) => readFileSync(join(dir, "codex-threads", id), "utf8"),
    run: (fields: Partial<Step> & { prompt: string }) => harness.run({ cwd, account: { folder: account }, ...fields }),
  };
}

interface Notification {
  method: string;
  params: Record<string, unknown>;
}

/** A JSON-RPC client on `codex app-server`, for the methods the adapter does not send yet. */
class Client {
  readonly notes: Notification[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private buffer = "";

  constructor(account: string) {
    this.child = spawn(CODEX, ["app-server"], { env: { ...process.env, CODEX_HOME: account }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let at;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at).trim();
        this.buffer = this.buffer.slice(at + 1);
        if (line) this.onMessage(JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } });
      }
    });
  }

  private onMessage(message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } }) {
    if (message.method) {
      this.notes.push({ method: message.method, params: message.params ?? {} });
      return;
    }
    const waiter = this.waiting.get(message.id ?? -1);
    if (!waiter) return;
    this.waiting.delete(message.id ?? -1);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }

  static async open(account: string): Promise<Client> {
    const client = new Client(account);
    await client.request("initialize", { clientInfo: { name: "test", title: "test", version: "0" }, capabilities: { experimentalApi: true } });
    return client;
  }

  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Waits until the notifications so far pass the check. */
  async until(check: (notes: Notification[]) => boolean, what: string, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check(this.notes)) {
      if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
      await new Promise((done) => setTimeout(done, 20));
    }
  }

  close() {
    this.child.stdin.end();
  }
}

/** One turn started by the client, waited on to its turn/completed. */
async function clientTurn(client: Client, threadId: string, text: string): Promise<void> {
  const before = client.notes.filter((note) => note.method === "turn/completed" && note.params.threadId === threadId).length;
  await client.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
  await client.until((notes) => notes.filter((note) => note.method === "turn/completed" && note.params.threadId === threadId).length > before, "turn/completed");
}

/** The fake started as a person starts `codex resume` in a terminal. stdin stays open, as a terminal's does. */
function byHand(args: string[], person: string | undefined): Promise<{ code: number | null; stderr: string }> {
  const env = { ...process.env };
  if (person === undefined) delete env.FAKE_PERSON;
  else env.FAKE_PERSON = person;
  const child = spawn(CODEX, args, { env, stdio: ["pipe", "pipe", "pipe"] });
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

const goalStatuses = (notes: Notification[]) => notes.filter((note) => note.method === "thread/goal/updated").map((note) => (note.params.goal as { status: string }).status);

describe("the fake codex's rules", () => {
  test("recall answers with the canary words of the same thread only", async () => {
    const c = newCase();
    c.rules([{ match: "^Recall", recall: true }]);
    const plum = await c.run({ prompt: "Remember the word PLUM." });
    const pelican = await c.run({ prompt: "Remember PELICAN-4417 for later." });
    const first = await c.run({ prompt: "Recall your words.", resume: plum.sessionId });
    const second = await c.run({ prompt: "Recall your words.", resume: pelican.sessionId });
    assert.equal(first.text, "PLUM");
    assert.equal(second.text, "PELICAN-4417");
    const fresh = await c.run({ prompt: "Recall your words." });
    assert.equal(fresh.text, "Nothing to recall.");
  });

  test("files and run make a turn's edits in its folder before it answers, and a failed command does not stop the turn", async () => {
    const c = newCase();
    c.rules([
      { match: "^Edit", files: { "src/a.txt": "one\n" }, run: "cp src/a.txt b.txt && printf two >> b.txt", answer: "Edited." },
      { match: "^Break", run: "exit 3", answer: "Tried." },
    ]);
    assert.equal((await c.run({ prompt: "Edit the files." })).text, "Edited.");
    assert.equal(readFileSync(join(c.cwd, "src", "a.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(c.cwd, "b.txt"), "utf8"), "one\ntwo");
    assert.equal((await c.run({ prompt: "Break it." })).text, "Tried.");
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

  test("system and session matchers pick the rule for one thread", async () => {
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

  test("a session matcher takes a regex on the thread id", async () => {
    const c = newCase();
    const plain = await c.run({ prompt: "Start." });
    c.rules([{ session: { match: `^${plain.sessionId.slice(0, 8)}` }, answer: "regex rule" }]);
    assert.equal((await c.run({ prompt: "Continue the task.", resume: plain.sessionId })).text, "regex rule");
    assert.equal((await c.run({ prompt: "Continue the task." })).text, "Fake codex answer.");
  });

  test("a fork gets a new id and its parent's words, and the parent never learns the fork's", async () => {
    const c = newCase();
    c.rules([{ match: "^Recall", recall: true }]);
    const parent = await c.run({ prompt: "Remember the word PLUM." });
    const before = c.transcript(parent.sessionId);
    const elsewhere = join(c.dir, "elsewhere");
    mkdirSync(elsewhere);
    const client = await Client.open(c.account);
    let forkId: string;
    try {
      const forked = await client.request<{ thread: { id: string; cwd: string }; model: string; cwd: string }>("thread/fork", { threadId: parent.sessionId, cwd: elsewhere });
      forkId = forked.thread.id;
      assert.equal(typeof forkId, "string");
      assert.notEqual(forkId, parent.sessionId);
      assert.equal(forked.thread.cwd, elsewhere);
      assert.equal(forked.cwd, elsewhere);
      assert.equal(typeof forked.model, "string");
      await clientTurn(client, forkId, "Remember KIWI too.");
      await assert.rejects(client.request("thread/fork", { threadId: randomUUID() }), /no rollout found/);
    } finally {
      client.close();
    }
    assert.equal(c.transcript(parent.sessionId), before);
    const turn = c.lines().find((line) => line.sessionId === forkId && line.prompt === "Remember KIWI too.");
    assert.equal(turn?.cwd, elsewhere);
    const fork = await c.run({ prompt: "Recall your words.", resume: forkId });
    assert.equal(fork.text, "PLUM KIWI");
    const again = await c.run({ prompt: "Recall your words.", resume: parent.sessionId });
    assert.equal(again.text, "PLUM");
  });

  test("codex resume by hand appends the person's line, exits 0 without reading stdin, and recall sees it", async () => {
    const c = newCase();
    c.rules([{ match: "^Recall", recall: true }]);
    const step = await c.run({ prompt: "Remember the word PLUM." });
    const ran = await byHand(["resume", "-m", "gpt-fake", "-c", "model_reasoning_effort=high", step.sessionId], "Also keep KIWI in mind.");
    assert.equal(ran.code, 0, ran.stderr);
    const last = c.transcript(step.sessionId).trim().split("\n").at(-1) ?? "";
    assert.deepEqual(JSON.parse(last), { role: "user", text: "Also keep KIWI in mind." });
    assert.deepEqual(
      c.lines().filter((line) => line.byHand !== undefined).map((line) => ({ sessionId: line.sessionId, byHand: line.byHand })),
      [{ sessionId: step.sessionId, byHand: "Also keep KIWI in mind." }],
    );
    const quiet = await byHand(["resume", step.sessionId], undefined);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.equal(c.lines().filter((line) => line.byHand !== undefined).length, 1);
    const recalled = await c.run({ prompt: "Recall your words.", resume: step.sessionId });
    assert.equal(recalled.text, "PLUM KIWI");
  });

  test("codex resume on an unknown thread fails, and other subcommands still exit 2", async () => {
    newCase();
    const ran = await byHand(["resume", randomUUID()], "Hello.");
    assert.notEqual(ran.code, 0);
    assert.match(ran.stderr, /No saved session found/);
    const other = await byHand(["exec", "hello"], "Hello.");
    assert.equal(other.code, 2);
  });

  test("a goal rule of 3 plays three turns with no turn/start, and the goal ends complete", async () => {
    const c = newCase();
    c.rules([{ goal: 3, answer: "The goal is met." }]);
    const client = await Client.open(c.account);
    try {
      const started = await client.request<{ thread: { id: string } }>("thread/start", { cwd: c.cwd });
      const threadId = started.thread.id;
      await client.request("thread/goal/set", { threadId, objective: "the tests pass" });
      await client.until((notes) => goalStatuses(notes).includes("complete") && notes.at(-1)?.method === "turn/completed", "the goal to complete");
      const notes = client.notes;
      const completed = notes.filter((note) => note.method === "turn/completed");
      assert.equal(notes.filter((note) => note.method === "turn/started").length, 3);
      assert.equal(completed.length, 3);
      assert.ok(completed.every((note) => (note.params.turn as { status: string }).status === "completed"));
      assert.deepEqual(goalStatuses(notes), ["active", "active", "complete"]);
      // complete comes after the second turn ends and before the last one does.
      const order = notes.filter((note) => note.method === "turn/completed" || note.method === "thread/goal/updated").map((note) => (note.method === "turn/completed" ? "turn" : goalStatuses([note])[0]));
      assert.deepEqual(order, ["turn", "active", "turn", "active", "complete", "turn"]);
      const said = notes.filter((note) => note.method === "item/completed").map((note) => (note.params.item as { text?: string }).text);
      assert.equal(said.at(-1), "The goal is met.");
      assert.deepEqual(
        c.lines().filter((line) => line.goal).map((line) => line.goal),
        [1, 2, 3].map((turn) => ({ turn, of: 3 })),
      );
      const got = await client.request<{ goal: { objective: string; status: string } | null }>("thread/goal/get", { threadId });
      assert.equal(got.goal?.objective, "the tests pass");
      assert.equal(got.goal?.status, "complete");
      await client.request("thread/goal/clear", { threadId });
      await client.until((all) => all.some((note) => note.method === "thread/goal/cleared" && note.params.threadId === threadId), "thread/goal/cleared");
      const gone = await client.request<{ goal: unknown }>("thread/goal/get", { threadId });
      assert.equal(gone.goal, null);
    } finally {
      client.close();
    }
  });

  test("a goal with no goal rule plays one turn that ends complete, and a plain turn plays no goal", async () => {
    const c = newCase();
    const client = await Client.open(c.account);
    try {
      const started = await client.request<{ thread: { id: string } }>("thread/start", { cwd: c.cwd });
      const threadId = started.thread.id;
      await client.request("thread/goal/set", { threadId, objective: "the tests pass" });
      await client.until((notes) => goalStatuses(notes).includes("complete") && notes.at(-1)?.method === "turn/completed", "the goal to complete");
      assert.equal(client.notes.filter((note) => note.method === "turn/completed").length, 1);
      assert.deepEqual(goalStatuses(client.notes), ["complete"]);
      assert.deepEqual(
        c.lines().filter((line) => line.goal).map((line) => line.goal),
        [{ turn: 1, of: 1 }],
      );
    } finally {
      client.close();
    }
    c.rules([{ goal: 3, answer: "The goal is met." }]);
    const plain = await c.run({ prompt: "the tests pass /goal" });
    assert.equal(plain.text, "Fake codex answer.");
    assert.equal(c.lines().filter((line) => line.goal).length, 1);
  });
});

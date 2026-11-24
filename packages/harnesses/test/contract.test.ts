// One contract for both adapters, run against the fake programs in test/fakes. No login and no
// model: each case gets its own folder under a temporary HOME, and the account folder there
// stands in for ~/.claude or ~/.codex.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHarness } from "../src/index.js";
import type { Account, Harness, HarnessFailure, HarnessId, HistoryEntry, Step, Usage } from "../src/index.js";
import type { Steer, SteerOutcome } from "../src/seam.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");

// The package script gives a temporary HOME. Run alone, or on a HOME that does not exist, the test
// makes one.
if (!process.env.HOME || process.env.HOME === userInfo().homedir || !existsSync(process.env.HOME)) process.env.HOME = mkdtempSync(join(tmpdir(), "harness-contract-home-"));
const ROOT = mkdtempSync(join(process.env.HOME, "contract-"));
delete process.env.FAKE_VERSION;

interface Kit {
  id: HarnessId;
  /** Writes a configured MCP server named demo, over http, into the account folder. */
  configureDemo(folder: string): void;
  /** A version the adapter does not support. */
  oldVersion: string;
}

const KITS: Kit[] = [
  {
    id: "claude",
    configureDemo: (folder) => writeFileSync(join(folder, ".claude.json"), JSON.stringify({ mcpServers: { demo: { type: "http", url: "https://configured.invalid/mcp" } } })),
    oldVersion: "2.0.0",
  },
  {
    id: "codex",
    // enabled_tools would carry over into a step server under the same name.
    configureDemo: (folder) => writeFileSync(join(folder, "config.toml"), '[mcp_servers.demo]\nurl = "https://configured.invalid/mcp"\nenabled_tools = ["configured_only"]\n'),
    oldVersion: "0.150.0",
  },
];

/** One line of the fakes' request log. */
interface LogLine {
  argv: string[];
  sessionId: string;
  resume: boolean;
  schema: unknown;
  prompt: string;
  mcpServers: Array<{ name: string; transport: string }>;
  disallowedTools?: string[];
  disabledTools?: Record<string, string[]>;
  /** Codex: what the turn was started with. */
  approvalPolicy?: string;
  sandboxPolicy?: string;
  /** The client's answer to the request the fake sent, as the client gave it. */
  approval?: unknown;
  /** Claude: the mode a set_permission_mode request gave before the turn. Missing when none did. */
  permissionMode?: string;
  /** A line for a message sent into a turn, rather than a turn. See test/fakes/lib.mjs. */
  steer?: { id: string | null; text: string; priority?: string | null; expectedTurnId?: string | null };
  state?: string;
}

interface Case {
  harness: Harness;
  dir: string;
  account: Account;
  rules(list: object[]): void;
  lines(): LogLine[];
  step(fields: Partial<Step> & { prompt: string }): Step;
}

/** A folder for one case, with the fake's log and rules, a project and an account folder. */
function newCase(kit: Kit, program = join(FAKES, kit.id)): Case {
  const dir = mkdtempSync(join(ROOT, `${kit.id}-`));
  const cwd = join(dir, "project");
  const folder = join(dir, "account");
  mkdirSync(cwd);
  mkdirSync(folder);
  const log = join(dir, "fake.log");
  const rules = join(dir, "rules.json");
  writeFileSync(rules, "[]");
  // The adapters pass the caller's environment on, so the fakes read these.
  process.env.FAKE_LOG = log;
  process.env.FAKE_RULES = rules;
  const account: Account = { folder };
  return {
    harness: createHarness(kit.id, { path: program, env: {} }),
    dir,
    account,
    rules: (list) => writeFileSync(rules, JSON.stringify(list)),
    lines: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine) : []),
    step: (fields) => ({ cwd, account, ...fields }),
  };
}

/** The failure a step throws. */
async function failure(run: Promise<unknown>): Promise<HarnessFailure> {
  try {
    await run;
  } catch (error) {
    assert.ok((error as HarnessFailure).failure, `expected a harness failure, got ${String(error)}`);
    return error as HarnessFailure;
  }
  return assert.fail("the step did not fail");
}

const sum = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite;

async function until(check: () => boolean, ms = 10_000, what = "timed out") {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(what);
    await new Promise((done) => setTimeout(done, 20));
  }
}

const RESETS_AT = 1_900_000_000;
const RESET_ISO = new Date(RESETS_AT * 1000).toISOString();

for (const kit of KITS) {
  describe(`the ${kit.id} adapter`, () => {
    test("starts a session, resumes it, and names an unknown one", async () => {
      const c = newCase(kit);
      const sessions: string[] = [];
      const first = await c.harness.run(c.step({ prompt: "hello" }), { session: (id) => sessions.push(id) });
      assert.ok(first.sessionId);
      assert.deepEqual(sessions, [first.sessionId]);
      assert.equal(first.text, `Fake ${kit.id} answer.`);
      assert.ok(first.model);

      const again = await c.harness.run(c.step({ prompt: "again", resume: first.sessionId }));
      assert.equal(again.sessionId, first.sessionId);
      const [, second] = c.lines();
      assert.equal(second?.sessionId, first.sessionId);
      assert.equal(second?.resume, true);

      const unknown = "00000000-0000-4000-8000-000000000000";
      const failed = await failure(c.harness.run(c.step({ prompt: "lost", resume: unknown })));
      assert.deepEqual(failed.failure, { kind: "no_session", sessionId: unknown });
    });

    test("returns the value for a schema", async () => {
      const c = newCase(kit);
      const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
      c.rules([{ answer: { answer: "forty-two" } }]);
      const result = await c.harness.run(c.step({ prompt: "what is it?", schema }));
      assert.deepEqual(result.value, { answer: "forty-two" });
      assert.deepEqual(c.lines()[0]?.schema, schema);
    });

    test("gives the reset time of a usage limit, also before the first answer", async () => {
      const c = newCase(kit);
      c.rules([{ match: "late", limit: { resetsAt: RESETS_AT } }, { match: "early", limit: { resetsAt: RESETS_AT, first: true, silent: true } }]);
      const late = await failure(c.harness.run(c.step({ prompt: "late" })));
      assert.deepEqual(late.failure, { kind: "usage_limit", resetAt: RESET_ISO });
      const early = await failure(c.harness.run(c.step({ prompt: "early" })));
      assert.deepEqual(early.failure, { kind: "usage_limit", resetAt: RESET_ISO });
    });

    test("stops a step mid-turn", async () => {
      const c = newCase(kit);
      c.rules([{ hold: "release", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }]);
      const stop = new AbortController();
      const run = c.harness.run(c.step({ prompt: "long work", signal: stop.signal }));
      await until(() => c.lines().length > 0);
      stop.abort();
      const failed = await failure(run);
      assert.deepEqual(failed.failure, { kind: "stopped" });
      assert.ok(failed.usage);
      assert.equal(failed.usage.total, sum(failed.usage));
    });

    test("stops a step asked to stop before its turn starts", async () => {
      for (const when of ["before the call", "right after the call", "once the session opens"] as const) {
        const c = newCase(kit);
        c.rules([{ hold: "release" }]);
        const stop = new AbortController();
        if (when === "before the call") stop.abort();
        const run = c.harness.run(c.step({ prompt: "never mind", signal: stop.signal }), { session: () => stop.abort() });
        if (when === "right after the call") stop.abort();
        const failed = await failure(run);
        assert.deepEqual(failed.failure, { kind: "stopped" }, when);
      }
    });

    test("replaces a configured MCP server of the same name for one step", async () => {
      const c = newCase(kit);
      kit.configureDemo(c.account.folder!);
      await c.harness.run(c.step({ prompt: "with mine", mcpServers: [{ name: "demo", type: "stdio", command: "node", args: ["demo.js"] }] }));
      await c.harness.run(c.step({ prompt: "without" }));
      const [mine, without] = c.lines();
      // Codex runs the step's server under another name, with the configured one off.
      assert.equal(mine?.mcpServers.length, 1);
      assert.equal(mine?.mcpServers[0]?.transport, "stdio");
      assert.match(mine?.mcpServers[0]?.name ?? "", /^demo/);
      assert.deepEqual(without?.mcpServers, [{ name: "demo", transport: "http" }]);
    });

    test("applies the tool deny list", async () => {
      const c = newCase(kit);
      c.rules([{ listTools: true, approval: "git push" }]);
      const result = await c.harness.run(
        c.step({
          prompt: "which tools?",
          tools: { deny: ["Bash", "mcp__demo__secret"] },
          mcpServers: [{ name: "demo", type: "stdio", command: "node", args: ["demo.js"] }],
        }),
      );
      const line = c.lines()[0];
      if (kit.id === "claude") {
        assert.ok(!result.text.split(",").includes("Bash"), result.text);
        assert.ok(result.text.split(",").includes("Read"), result.text);
        assert.ok(line?.disallowedTools?.includes("mcp__demo__secret"));
      } else {
        assert.deepEqual(line?.disabledTools, { demo: ["secret"] });
        assert.deepEqual(line?.approval, { decision: "decline" });
        assert.ok(result.notes?.some((note) => note.includes("Bash")), JSON.stringify(result.notes));
      }
    });

    test("reports usage after a failed turn as input plus output plus cache", async () => {
      const c = newCase(kit);
      c.rules([{ fail: "server fell over", usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 40 } }]);
      const seen: Usage[] = [];
      const failed = await failure(c.harness.run(c.step({ prompt: "try" }), { usage: (u) => seen.push(u) }));
      assert.deepEqual(failed.failure, { kind: "failed", retry: true });
      const { input, output, cacheRead, cacheWrite, total } = failed.usage!;
      assert.deepEqual({ input, output, cacheRead, cacheWrite, total }, { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, total: 460 });
      assert.equal(seen.at(-1)?.total, 460);
    });

    test("fails a step whose program exits mid-turn as a failure a retry can fix", async () => {
      const c = newCase(kit);
      c.rules([{ exit: 3 }]);
      const failed = await failure(c.harness.run(c.step({ prompt: "crash" })));
      assert.deepEqual(failed.failure, { kind: "failed", retry: true });
      assert.equal(c.lines().length, 1, "the program got the turn before it exited");
      // The program's own error output, once.
      assert.match(failed.message, /fake crash/);
      assert.doesNotMatch(failed.message, /fake crash[\s\S]*fake crash/);
    });

    test("names an auth failure", async () => {
      const c = newCase(kit);
      c.rules([{ auth: true }]);
      const failed = await failure(c.harness.run(c.step({ prompt: "who am I?" })));
      assert.deepEqual(failed.failure, { kind: "auth" });
    });

    test("refuses a version it does not support", async () => {
      const c = newCase(kit);
      assert.equal((await c.harness.version()).problem, undefined);
      const wrapper = join(c.dir, kit.id);
      writeFileSync(wrapper, `#!/bin/sh\nFAKE_VERSION=${kit.oldVersion} exec "${join(FAKES, kit.id)}" "$@"\n`);
      chmodSync(wrapper, 0o755);
      const old = createHarness(kit.id, { path: wrapper, env: {} });
      const { version, problem } = await old.version();
      assert.equal(version, kit.oldVersion);
      assert.match(problem ?? "", new RegExp(kit.oldVersion.replace(/\./g, "\\.")));
      const failed = await failure(old.run(c.step({ prompt: "hello" })));
      assert.equal(failed.failure.kind, "program");
      assert.equal(c.lines().length, 0);
    });

    test("lists models without a turn", async () => {
      const c = newCase(kit);
      const models = await c.harness.models(c.account);
      assert.ok(models.length > 0);
      assert.equal(c.lines().length, 0);
    });
  });
}

const CLAUDE = KITS.find((kit) => kit.id === "claude")!;
const CODEX = KITS.find((kit) => kit.id === "codex")!;

describe("the claude adapter's permission mode", () => {
  /** The flags a step with this mode starts the program with, of the two that carry it. */
  const MODES: Array<{ title: string; mode: string | undefined; flags: string[]; note?: RegExp }> = [
    { title: "passes the mode on to the program", mode: "plan", flags: ["--permission-mode=plan"] },
    { title: "lets bypassPermissions skip the permission checks", mode: "bypassPermissions", flags: ["--permission-mode=bypassPermissions", "--allow-dangerously-skip-permissions"] },
    { title: "names a mode it does not know and keeps the user's default", mode: "yolo", flags: [], note: /no permission mode yolo/ },
    { title: "leaves the user's default when the step names no mode", mode: undefined, flags: [] },
  ];
  for (const row of MODES) {
    test(row.title, async () => {
      const c = newCase(CLAUDE);
      const result = await c.harness.run(c.step({ prompt: "hello", ...(row.mode ? { mode: row.mode } : {}) }));
      const got = c.lines()[0]!.argv.filter((arg) => arg.startsWith("--permission-mode") || arg === "--allow-dangerously-skip-permissions");
      assert.deepEqual(got, row.flags);
      if (row.note) assert.match(result.notes?.join("\n") ?? "", row.note);
      else assert.equal(result.notes, undefined);
    });
  }
});

describe("the codex adapter's mode", () => {
  const MODES: Array<{ title: string; mode: string; approvalPolicy: string; sandboxPolicy: string; note?: RegExp }> = [
    { title: "runs a read-only step in the read-only sandbox", mode: "read-only", approvalPolicy: "on-request", sandboxPolicy: "readOnly" },
    { title: "runs an agent-full-access step with no sandbox and no approvals", mode: "agent-full-access", approvalPolicy: "never", sandboxPolicy: "dangerFullAccess" },
    { title: "names a mode it does not know and runs in agent mode", mode: "yolo", approvalPolicy: "on-request", sandboxPolicy: "workspaceWrite", note: /no mode yolo.*agent mode/ },
  ];
  for (const row of MODES) {
    test(row.title, async () => {
      const c = newCase(CODEX);
      const result = await c.harness.run(c.step({ prompt: "hello", mode: row.mode }));
      const line = c.lines()[0]!;
      assert.deepEqual({ approvalPolicy: line.approvalPolicy, sandboxPolicy: line.sandboxPolicy }, { approvalPolicy: row.approvalPolicy, sandboxPolicy: row.sandboxPolicy });
      if (row.note) assert.match(result.notes?.join("\n") ?? "", row.note);
      else assert.equal(result.notes, undefined);
    });
  }
});

describe("the codex adapter's answers to requests in the middle of a turn", () => {
  const DENIED_MESSAGE = "No one answers questions during a step. Ask the question in your answer instead.";
  const ACCEPTED = { action: "accept", content: null, _meta: null };
  const DECLINED = { action: "decline", content: null, _meta: null };
  const GRANT = { decision: "accept" };
  const REFUSE = { decision: "decline" };

  /** The fake asks `ask`, the step has `tools`, and the adapter must answer `answer`. A refusal also says why in the history. */
  const REQUESTS: Array<{ title: string; ask: string | object; tools?: Step["tools"]; answer: unknown; refused?: { tool: string; why: string } }> = [
    { title: "runs a command no list refuses", ask: "git status", answer: GRANT },
    { title: "declines a command the allow list leaves out", ask: "git push", tools: { allow: ["Read"] }, answer: REFUSE, refused: { tool: "Bash", why: "Bash is not on the step's allow list." } },
    { title: "applies a file change no list refuses", ask: { kind: "fileChange" }, answer: GRANT },
    { title: "declines a file change when Edit is on the deny list", ask: { kind: "fileChange" }, tools: { deny: ["Edit"] }, answer: REFUSE, refused: { tool: "Edit", why: "Edit is on the step's deny list (Edit)." } },
    { title: "declines a file change when Write is on the deny list", ask: { kind: "fileChange" }, tools: { deny: ["Write"] }, answer: REFUSE, refused: { tool: "Edit", why: "Write is on the step's deny list (Write)." } },
    { title: "grants a network right for the turn", ask: { kind: "permissions", network: { enabled: true } }, answer: { permissions: { network: { enabled: true } }, scope: "turn" } },
    {
      title: "grants file rights for the turn, since the lists act on the actions and not on the rights",
      ask: { kind: "permissions", fileSystem: { read: ["/data"], write: ["/out"] } },
      tools: { deny: ["Bash", "Edit"] },
      answer: { permissions: { fileSystem: { read: ["/data"], write: ["/out"] } }, scope: "turn" },
    },
    { title: "grants nothing when the request asks for nothing", ask: { kind: "permissions" }, answer: { permissions: {}, scope: "turn" } },
    { title: "runs an MCP tool no list refuses", ask: { kind: "mcp", server: "demo", tool: "lookup" }, answer: ACCEPTED },
    {
      title: "declines an MCP tool on the deny list, named from the tool the server runs",
      ask: { kind: "mcp", server: "demo", tool: "secret" },
      tools: { deny: ["mcp__demo__secret"] },
      answer: DECLINED,
      refused: { tool: "mcp__demo__secret", why: "mcp__demo__secret is on the step's deny list (mcp__demo__secret)." },
    },
    { title: "declines a question from an MCP server, since no one is there to answer", ask: { kind: "form" }, answer: DECLINED },
    { title: "answers the model's own question with an error that tells it to ask in its answer", ask: { kind: "question" }, answer: { error: { code: -32000, message: DENIED_MESSAGE } } },
  ];

  for (const row of REQUESTS) {
    test(row.title, async () => {
      const c = newCase(CODEX);
      c.rules([{ approval: row.ask }]);
      const history: HistoryEntry[] = [];
      await c.harness.run(c.step({ prompt: "ask first", ...(row.tools ? { tools: row.tools } : {}) }), { history: (entry) => history.push(entry) });
      assert.deepEqual(c.lines()[0]?.approval, row.answer);
      const declined = history.filter((entry) => entry.text.startsWith("Declined: ")).map(({ role, kind, text, toolName, isError }) => ({ role, kind, text, toolName, isError }));
      const expected = row.refused ? [{ role: "tool", kind: "toolResult", text: `Declined: ${row.refused.why}`, toolName: row.refused.tool, isError: true }] : [];
      assert.deepEqual(declined, expected);
    });
  }
});

/** The turns the fake logged, without the lines for messages sent into a turn. */
const turnLines = (c: Case) => c.lines().filter((line) => line.steer === undefined);
const steerLines = (c: Case) => c.lines().filter((line) => line.steer !== undefined);

/** A step held on a gate file, with what its events gave. */
function heldStep(c: Case, prompt: string) {
  const seams: Array<Steer | undefined> = [];
  const history: HistoryEntry[] = [];
  const run = c.harness.run(c.step({ prompt }), { history: (entry) => history.push(entry), steer: (send) => seams.push(send) });
  return {
    run,
    seams,
    history,
    open: () => writeFileSync(join(c.dir, "go"), ""),
    /** The seam the adapter gives once the turn has started. */
    async seam(): Promise<Steer> {
      await until(() => seams.at(-1) !== undefined, 10_000, "the adapter never opened the steer seam");
      return seams.at(-1)!;
    },
    /** Opens the gate whatever happened, so no fake stays up after a failed test. */
    async finish() {
      writeFileSync(join(c.dir, "go"), "");
      await run.catch(() => undefined);
    },
  };
}

const TELL = "Stop counting at five.";
const tellIn = (history: HistoryEntry[], text = TELL) => history.findIndex((entry) => entry.role === "user" && entry.kind === "text" && entry.text === text);

for (const kit of KITS) {
  describe(`the ${kit.id} adapter's steer seam`, () => {
    test("delivers a tell sent during a tool call, in the same turn", async () => {
      const c = newCase(kit);
      c.rules([{ tool: "seq 1 10", hold: "go", answer: "Stopped at five." }]);
      const held = heldStep(c, "Count to ten.");
      try {
        await until(() => held.history.some((entry) => entry.kind === "toolCall"), 10_000, "the fake's tool call never reached the history");
        const send = await held.seam();
        const id = randomUUID();
        const told = send(TELL, id);
        await until(() => steerLines(c).some((line) => line.steer?.id === id), 10_000, "the tell never reached the program");
        held.open();
        assert.equal(await told, "delivered");
        const result = await held.run;
        assert.equal(result.text, "Stopped at five.");
        assert.equal(turnLines(c).length, 1, "the tell started a turn of its own");
        assert.ok(steerLines(c).some((line) => line.steer?.id === id && line.state === "read"), "the turn never read the tell");
        const toolCall = held.history.findIndex((entry) => entry.kind === "toolCall");
        assert.ok(tellIn(held.history) > toolCall, "the tell is not in the history after the tool call");
        assert.equal(held.seams.at(-1), undefined, "the seam stayed open after the turn");
      } finally {
        await held.finish();
      }
    });

    test("sends a repeated id once, and answers it with the first one's outcome", async () => {
      const c = newCase(kit);
      c.rules([{ tool: "seq 1 10", hold: "go", answer: "Stopped at five." }]);
      const held = heldStep(c, "Count to ten.");
      try {
        await until(() => held.history.some((entry) => entry.kind === "toolCall"), 10_000, "the fake's tool call never reached the history");
        const send = await held.seam();
        const id = randomUUID();
        const first = send(TELL, id);
        const again = send(TELL, id);
        assert.equal(again, first, "a repeated id did not get the first one's outcome");
        await until(() => steerLines(c).some((line) => line.steer?.id === id), 10_000, "the tell never reached the program");
        held.open();
        assert.deepEqual(await Promise.all([first, again]), ["delivered", "delivered"]);
        await held.run;
        assert.equal(steerLines(c).filter((line) => line.steer?.id === id && line.state === "read").length, 1, "the program read the tell more than once");
        assert.equal(held.history.filter((entry) => entry.role === "user" && entry.text === TELL).length, 1, "the history has the tell more than once");
      } finally {
        await held.finish();
      }
    });

    test("answers ended to a tell after the result, and sends nothing", async () => {
      const c = newCase(kit);
      const seams: Array<Steer | undefined> = [];
      const result = await c.harness.run(c.step({ prompt: "hello" }), { steer: (send) => seams.push(send) });
      assert.equal(result.text, `Fake ${kit.id} answer.`);
      const send = seams.find((seam) => seam !== undefined);
      assert.ok(send, "the adapter never opened the steer seam");
      assert.equal(seams.at(-1), undefined, "the seam stayed open after the turn");
      assert.equal(await send("Too late.", randomUUID()), "ended");
      assert.equal(turnLines(c).length, 1);
      assert.equal(steerLines(c).length, 0);
    });
  });
}

describe("the codex adapter's steer seam, when Codex refuses", () => {
  test("answers not_steerable during a turn Codex cannot steer", async () => {
    const c = newCase(CODEX);
    c.rules([{ tool: "seq 1 10", hold: "go", notSteerable: "compact", answer: "Counted to ten." }]);
    const held = heldStep(c, "Count to ten.");
    try {
      await until(() => held.history.some((entry) => entry.kind === "toolCall"), 10_000, "the fake's tool call never reached the history");
      const send = await held.seam();
      const outcome: SteerOutcome = await send(TELL, randomUUID());
      assert.equal(outcome, "not_steerable");
      assert.deepEqual(steerLines(c).map((line) => line.state), ["not_steerable"]);
      held.open();
      const result = await held.run;
      assert.equal(result.text, "Counted to ten.");
      assert.equal(tellIn(held.history), -1, "a tell Codex refused is in the history");
    } finally {
      await held.finish();
    }
  });

  test("answers not_steerable on a Codex without turn/steer, with one note", async () => {
    const c = newCase(CODEX);
    c.rules([{ tool: "seq 1 10", hold: "go", noSteer: true, answer: "Counted to ten." }]);
    const held = heldStep(c, "Count to ten.");
    try {
      await until(() => held.history.some((entry) => entry.kind === "toolCall"), 10_000, "the fake's tool call never reached the history");
      const send = await held.seam();
      assert.equal(await send(TELL, randomUUID()), "not_steerable");
      assert.equal(await send("And say why.", randomUUID()), "not_steerable");
      assert.deepEqual(steerLines(c).map((line) => line.state), ["unknown_method", "unknown_method"]);
      held.open();
      const result = await held.run;
      assert.equal(result.text, "Counted to ten.");
      assert.equal(result.notes?.filter((note) => note.includes("0.169.0")).length, 1, JSON.stringify(result.notes));
      assert.equal(tellIn(held.history), -1, "a tell Codex refused is in the history");
    } finally {
      await held.finish();
    }
  });

  test("answers ended when the turn ends before Codex takes the tell", async () => {
    const c = newCase(CODEX);
    c.rules([{ answer: "All done." }]);
    const seams: Array<Steer | undefined> = [];
    let told: Promise<SteerOutcome> | undefined;
    // The fake ends its turn before it sends the answer, so a tell sent on the answer finds no turn.
    const result = await c.harness.run(c.step({ prompt: "hello" }), {
      steer: (send) => seams.push(send),
      history: (entry) => {
        const send = seams.at(-1);
        if (entry.role === "assistant" && entry.kind === "text" && send && !told) told = send(TELL, randomUUID());
      },
    });
    assert.equal(result.text, "All done.");
    assert.ok(told, "the seam was not open when the answer came");
    assert.equal(await told, "ended");
  });
});

describe("the claude adapter's steer seam, on what Claude Code does", () => {
  test("answers ended to a tell still waiting when the result comes", async () => {
    const c = newCase(CLAUDE);
    // No tool call, so the turn never reads the tell. The fake then runs it as a second turn,
    // as Claude Code does. That turn must not become the step's answer, and must not run to its
    // end: the step reports the tell ended, so the agent must never act on it.
    c.rules([{ hold: "go", answer: "Done.", times: 1 }, { hold: "go2", answer: "A second turn.", mark: "second-turn-ended" }]);
    const held = heldStep(c, "Say done.");
    try {
      const send = await held.seam();
      const id = randomUUID();
      const told = send(TELL, id);
      await until(() => steerLines(c).some((line) => line.steer?.id === id && line.state === "queued"), 10_000, "the tell never reached the program");
      held.open();
      assert.equal(await told, "ended");
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("the step waited on the tell's second turn")), 10_000)));
      const result = await Promise.race([held.run, waited]).finally(() => clearTimeout(timer));
      assert.equal(result.text, "Done.");
      assert.equal(tellIn(held.history), -1, "a tell the turn never read is in the history");
      // The second turn may go on only if Claude Code still runs. Let it, and see that it can't.
      writeFileSync(join(c.dir, "go2"), "");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(existsSync(join(c.dir, "second-turn-ended")), false, "the tell's second turn ran to its end");
    } finally {
      writeFileSync(join(c.dir, "go2"), "");
      await held.finish();
    }
  });

  test("sends every tell with priority next", async () => {
    const c = newCase(CLAUDE);
    c.rules([{ tool: "seq 1 10", hold: "go", answer: "Stopped at five." }]);
    const held = heldStep(c, "Count to ten.");
    try {
      await until(() => held.history.some((entry) => entry.kind === "toolCall"), 10_000, "the fake's tool call never reached the history");
      const send = await held.seam();
      const ids = [randomUUID(), randomUUID()];
      const told = [send(TELL, ids[0]!), send("And say why.", ids[1]!)];
      await until(() => steerLines(c).filter((line) => line.state === "queued").length === 2, 10_000, "the tells never reached the program");
      held.open();
      assert.deepEqual(await Promise.all(told), ["delivered", "delivered"]);
      await held.run;
      // The fake exits with an error on now or later, so a step that ends well sent neither.
      assert.deepEqual(steerLines(c).map((line) => line.steer?.priority), ["next", "next", "next", "next"]);
      assert.equal(turnLines(c).length, 1);
    } finally {
      await held.finish();
    }
  });

  test("the fake fails loudly on a message with priority now or later", () => {
    for (const priority of ["now", "later"]) {
      const message = { type: "user", message: { role: "user", content: [{ type: "text", text: "x" }] }, parent_tool_use_id: null, priority };
      const ran = spawnSync(join(FAKES, "claude"), ["--input-format", "stream-json", "--output-format", "stream-json"], { input: `${JSON.stringify(message)}\n`, encoding: "utf8", env: { ...process.env, FAKE_LOG: join(ROOT, "priority.log") } });
      assert.notEqual(ran.status, 0, priority);
      assert.match(ran.stderr, new RegExp(`priority ${priority}`));
    }
  });

  test("turns on auto mode when the step names no mode and the model offers it", async () => {
    const ROWS: Array<{ fields: Partial<Step>; permissionMode: string | null }> = [
      { fields: {}, permissionMode: "auto" },
      { fields: { model: "haiku" }, permissionMode: null },
      { fields: { mode: "plan" }, permissionMode: null },
    ];
    for (const row of ROWS) {
      const c = newCase(CLAUDE);
      await c.harness.run(c.step({ prompt: "hello", ...row.fields }));
      assert.equal(c.lines()[0]?.permissionMode ?? null, row.permissionMode, JSON.stringify(row.fields));
    }
  });
});

describe("the login variables", () => {
  const claude = createHarness("claude", { env: {} });
  const codex = createHarness("codex", { env: {} });
  const home = process.env.HOME!;

  test("name each program's folder variable and the folder it uses", () => {
    assert.deepEqual(claude.login({}), { variable: "CLAUDE_CONFIG_DIR", folder: join(home, ".claude") });
    assert.deepEqual(codex.login({}), { variable: "CODEX_HOME", folder: join(home, ".codex") });
    assert.deepEqual(claude.login({ CLAUDE_CONFIG_DIR: "/a", CLAUDE_CODE_OAUTH_TOKEN: "t" }), { variable: "CLAUDE_CONFIG_DIR", value: "/a", folder: "/a", token: "t" });
    assert.deepEqual(codex.login({ CODEX_HOME: "/b", CLAUDE_CODE_OAUTH_TOKEN: "t" }), { variable: "CODEX_HOME", value: "/b", folder: "/b" });
  });

  test("put an account on an environment", () => {
    const base = { KEEP: "1", CLAUDE_CONFIG_DIR: "/old", CLAUDE_CODE_OAUTH_TOKEN: "old", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "a", CODEX_HOME: "/c" };
    assert.deepEqual(claude.env(undefined, base), base);
    // A named login sets its token and removes the keys Claude Code would take over it.
    assert.deepEqual(claude.env({ folder: "/f", token: "new", named: true }, base), { KEEP: "1", CLAUDE_CONFIG_DIR: "/f", CLAUDE_CODE_OAUTH_TOKEN: "new", CODEX_HOME: "/c" });
    // The default login keeps the keys, and no token removes the old one.
    assert.deepEqual(claude.env({}, base), { KEEP: "1", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "a", CODEX_HOME: "/c" });
    assert.deepEqual(codex.env({ folder: "/d" }, base), { ...base, CODEX_HOME: "/d" });
    const { CODEX_HOME: _gone, ...noCodex } = base;
    assert.deepEqual(codex.env({}, base), noCodex);
    assert.equal(base.CLAUDE_CONFIG_DIR, "/old");
  });
});

// One contract for both adapters, run against the fake programs in test/fakes. No login and no
// model: each case gets its own folder under a temporary HOME, and the account folder there
// stands in for ~/.claude or ~/.codex.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHarness } from "../src/index.js";
import type { Account, Harness, HarnessFailure, HarnessId, Step, Usage } from "../src/index.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");

// The package script gives a temporary HOME. Run alone, the test makes one.
if (!process.env.HOME || process.env.HOME === userInfo().homedir) process.env.HOME = mkdtempSync(join(tmpdir(), "harness-contract-home-"));
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
  sessionId: string;
  resume: boolean;
  schema: unknown;
  prompt: string;
  mcpServers: Array<{ name: string; transport: string }>;
  disallowedTools?: string[];
  disabledTools?: Record<string, string[]>;
  /** Codex: the client's answer to the request the fake sent, as the client gave it. */
  approval?: unknown;
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

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail("timed out");
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

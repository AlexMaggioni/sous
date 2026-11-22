import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  addAccount,
  createRun,
  currentAccount,
  ensureHome,
  homePaths,
  limitNotice,
  listAccounts,
  loadRecord,
  removeAccount,
  useAccount,
  type HomePaths,
  type RunRecord,
} from "@orchestrator/engine";
// orc does not import these, so the engine entry does not export them. The tests load the
// engine's built modules by path. They are the same modules the entry loads.
import { WorkflowError, WorkflowErrorCode } from "../../engine/dist/errors.js";
import { managerFor, runWorker } from "../../engine/dist/runs/worker.js";
import type { AgentRunner } from "../../engine/dist/steps/agent-runner.js";
import { cmdAccount } from "../src/account-cli.js";
import { main } from "../src/cli.js";

// orc's accounts: one per program, the program's own login by default. Tokens here are made up.

const harnessHome = mkdtempSync(join(tmpdir(), "orc-harness-home-"));
process.env.CLAUDE_CONFIG_DIR = join(harnessHome, ".claude");
process.env.CODEX_HOME = join(harnessHome, ".codex");
process.env.XDG_CONFIG_HOME = join(harnessHome, ".config");
delete process.env.AGENTPRISM_DEFAULT_BACKEND;
// This file may run inside a Claude Code session. Each test sets what it needs.
for (const name of ["CLAUDECODE", "ORC_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete process.env[name];

const WORK = "sk-ant-oat01-made-up-work-token";
const SPARE = "sk-ant-oat01-made-up-spare-token";
const AGENT = "sk-ant-oat01-made-up-agent-token";
const quiet = () => {};

function setup(workflows: Record<string, string> = {}): { paths: HomePaths; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "orc-accounts-"));
  const paths = ensureHome(homePaths(join(root, "home")));
  writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder" }));
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".orchestrator", "workflows"), { recursive: true });
  for (const [name, script] of Object.entries(workflows)) writeFileSync(join(projectDir, ".orchestrator", "workflows", `${name}.js`), script);
  return { paths, projectDir };
}

const ONE_STEP = `export const meta = { name: 'one', description: 'one step' }\nreturn await agent('go', { label: 'go' })`;

/** The account a step gets: its folder, its token, and whether it is one of orc's named logins. */
interface SeenAccount {
  token?: string;
  folder?: string;
  named?: boolean;
}

/** A runner that notes the account each step gets, and can stop at the usage limit. */
function loginRunner(limited: () => boolean = () => false): { runner: AgentRunner; seen: SeenAccount[] } {
  const seen: SeenAccount[] = [];
  const runner = {
    async run(_prompt: string, options: Record<string, unknown> = {}) {
      seen.push({ ...(options.account as SeenAccount | undefined) });
      (options.onSessionOpen as ((ref: unknown) => void) | undefined)?.({ sessionId: `s${seen.length}`, backendId: "claude", cwd: options.cwd, reopen: { load: true, resume: true, list: true } });
      if (limited()) {
        const reset = new Date(Date.now() + 2 * 3600_000).toISOString();
        throw new WorkflowError("You've hit your limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false, resetHint: `Resets at ${reset}` });
      }
      return "done";
    },
  } as unknown as AgentRunner;
  return { runner, seen };
}

function atLimit(paths: HomePaths) {
  return (record: RunRecord) => {
    const state = managerFor(paths, record.projectDir).getPersistence().load(record.runId);
    return state?.status === "paused" && state.pauseReason === "usage_limit";
  };
}

async function withHome<T>(paths: HomePaths, body: () => Promise<T>): Promise<{ value: T; printed: string }> {
  const before = process.env.ORC_HOME;
  process.env.ORC_HOME = paths.home;
  const printed: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    return { value: await body(), printed: printed.join("") };
  } finally {
    process.stdout.write = write;
    if (before === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = before;
  }
}

describe("accounts", () => {
  it("adds, lists, switches and removes logins, in a file only the user can read", () => {
    const { paths } = setup();
    assert.equal(currentAccount(paths, "claude"), "default");
    addAccount(paths, "work", `  ${WORK}\n`);
    addAccount(paths, "claude/spare", SPARE);
    assert.equal(statSync(paths.accounts).mode & 0o777, 0o600);

    assert.throws(() => addAccount(paths, "other", "hello"), /not a Claude Code login token/);
    assert.throws(() => addAccount(paths, "two words", SPARE), /not a usable name/);
    assert.throws(() => addAccount(paths, "default", "sk-ant-oat01-x"), /taken by orc/);
    assert.throws(() => addAccount(paths, "caller", "sk-ant-oat01-x"), /taken by orc/);
    assert.throws(() => addAccount(paths, "work", "sk-ant-oat01-x"), /there is an account work already/);
    assert.throws(() => addAccount(paths, "again", WORK), /account work has this token already/);
    assert.throws(() => addAccount(paths, "codex/team", "sk-ant-oat01-x"), /Codex accounts come later/);
    assert.throws(() => addAccount(paths, "gemini/x", "sk-ant-oat01-x"), /"gemini" is no program/);

    const rows = listAccounts(paths);
    assert.deepEqual(rows.map((row) => `${row.program}/${row.name}${row.current ? "*" : ""}`), ["claude/default*", "claude/spare", "claude/work", "codex/default*"]);
    assert.doesNotMatch(JSON.stringify(rows), /sk-ant/);

    useAccount(paths, "work", { atLimit: () => false, resume: () => assert.fail("nothing waits") });
    assert.equal(currentAccount(paths, "claude"), "work");
    assert.throws(() => useAccount(paths, "nobody", { atLimit: () => false, resume: quiet }), /no account nobody/);

    removeAccount(paths, "work", new Set());
    assert.equal(currentAccount(paths, "claude"), "default", "removing the current account goes back to default");
    assert.throws(() => removeAccount(paths, "work", new Set()), /no account work/);
    assert.deepEqual(listAccounts(paths).map((row) => row.name), ["default", "spare", "default"]);
    assert.doesNotMatch(readFileSync(paths.accounts, "utf8"), new RegExp(WORK));
  });

  it("a run records orc's account, and its steps run on that login, as a named one whose API key the harness removes", async () => {
    const { paths, projectDir } = setup({ one: ONE_STEP });
    addAccount(paths, "work", WORK);
    useAccount(paths, "work", { atLimit: () => false, resume: quiet });
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-made-up";
    try {
      const record = createRun(paths, { workflow: "one", projectDir, inputs: {} });
      assert.deepEqual(record.accounts, { claude: { name: "work", folder: process.env.CLAUDE_CONFIG_DIR }, codex: { name: "default", folder: process.env.CODEX_HOME } });

      const { runner, seen } = loginRunner();
      const done = await runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
      assert.equal(done?.status, "completed");
      assert.deepEqual(seen, [{ token: WORK, named: true, folder: process.env.CLAUDE_CONFIG_DIR }]);
      assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the worker leaves its own environment alone");
      assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-api03-made-up");

      const { printed } = await withHome(paths, () => main(["show", record.runId]));
      assert.match(printed, /account   Claude Code: work\n/);
      assert.match(printed, /account   Codex: default, Codex's own login in /);
      assert.doesNotMatch(printed, /sk-ant/);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("a run that a Claude Code session starts uses that session's login, also when the service resumes it", async () => {
    const { paths, projectDir } = setup({ one: ONE_STEP });
    addAccount(paths, "work", WORK);
    addAccount(paths, "spare", SPARE);
    useAccount(paths, "spare", { atLimit: () => false, resume: quiet });

    process.env.CLAUDE_CODE_OAUTH_TOKEN = WORK;
    const known = createRun(paths, { workflow: "one", projectDir, inputs: {}, caller: true });
    assert.equal(known.accounts?.claude?.name, "work", "a session on a login orc has gets that account");

    process.env.CLAUDE_CODE_OAUTH_TOKEN = AGENT;
    const record = createRun(paths, { workflow: "one", projectDir, inputs: {}, caller: true });
    assert.equal(record.accounts?.claude?.name, "caller");
    assert.ok(record.accounts?.claude?.kept);
    assert.doesNotMatch(readFileSync(join(paths.records, `${record.runId}.json`), "utf8"), /sk-ant/, "the run's record holds no token");

    const plain = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    assert.equal(plain.accounts?.claude?.name, "spare", "without the session flag, a run uses orc's account");

    // The service starts the worker from its own environment, without the session's token.
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const { runner, seen } = loginRunner();
    await runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
    assert.equal(seen[0]?.token, AGENT);

    // A session on Claude Code's own login keeps no token, and its steps get none.
    const own = createRun(paths, { workflow: "one", projectDir, inputs: {}, caller: true });
    assert.deepEqual(own.accounts?.claude, { name: "caller", folder: process.env.CLAUDE_CONFIG_DIR });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = WORK;
    try {
      await runWorker(own.runId, "start", { paths, inner: runner, log: quiet });
      assert.equal(seen[1]?.token, undefined);
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  it("a run that an agent of another run starts takes that run's accounts", () => {
    const { paths, projectDir } = setup({ one: ONE_STEP });
    addAccount(paths, "work", WORK);
    useAccount(paths, "work", { atLimit: () => false, resume: quiet });
    const parent = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    useAccount(paths, "default", { atLimit: () => false, resume: quiet });
    const child = createRun(paths, { workflow: "one", projectDir, inputs: {}, startedByRun: parent.runId, caller: true });
    assert.deepEqual(child.accounts, parent.accounts);
  });

  it("at the usage limit the run waits and says whose limit it is; orc account use moves it and it goes on", async () => {
    const { paths, projectDir } = setup({ one: ONE_STEP });
    let limited = true;
    const { runner, seen } = loginRunner(() => limited);
    const record = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    const lines: string[] = [];
    const paused = await runWorker(record.runId, "start", { paths, inner: runner, log: (line) => lines.push(line) });
    assert.equal(paused?.status, "paused");
    assert.equal(managerFor(paths, projectDir).getPersistence().load(record.runId)?.pauseReason, "usage_limit");
    assert.deepEqual({ ...loadRecord(paths, record.runId)?.limit, at: undefined }, { program: "claude", account: "default", at: undefined });
    const notice = lines.find((line) => line.includes(" limit      "));
    assert.match(String(notice), /Claude Code's own login \(default\) hit its usage limit\. It resets at \d\d:\d\d\. orc account use <name> goes on now on another account\./);

    addAccount(paths, "spare", SPARE);
    const resumed: string[] = [];
    const result = useAccount(paths, "spare", { atLimit: atLimit(paths), resume: (runId) => resumed.push(runId) });
    assert.deepEqual(resumed, [record.runId]);
    assert.deepEqual(result.moved, [{ runId: record.runId, workflow: "one", from: "default" }]);
    assert.equal(loadRecord(paths, record.runId)?.accounts?.claude?.name, "spare");
    assert.equal(loadRecord(paths, record.runId)?.accounts?.claude?.folder, process.env.CLAUDE_CONFIG_DIR, "the run keeps its settings folder");

    // A run at the limit of the account orc uses now waits for the reset.
    const second = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    await runWorker(second.runId, "start", { paths, inner: runner, log: quiet });
    const show = await withHome(paths, () => main(["show", second.runId]));
    assert.match(show.printed, /limit     Claude Code account spare hit its usage limit\. It resets at \d\d:\d\d\. orc account use <name> goes on now on another account\./);
    useAccount(paths, "default", { atLimit: () => false, resume: quiet });
    assert.match(limitNotice(paths, loadRecord(paths, second.runId)!, undefined), /^Claude Code account spare hit its usage limit\. orc account use default moves it to the account orc uses now\.$/);
    const again = useAccount(paths, "spare", { atLimit: atLimit(paths), resume: (runId) => resumed.push(runId) });
    // The first run is on spare too now, and since this test resumed neither, both still wait.
    assert.deepEqual(again.same.map((run) => run.runId).sort(), [record.runId, second.runId].sort());
    assert.deepEqual(again.moved, []);
    assert.deepEqual(resumed, [record.runId], "the run on spare is not resumed on spare");

    // The worker that resumes it runs the step on the new login, and the limit is gone from the record.
    limited = false;
    const done = await runWorker(record.runId, "resume", { paths, inner: runner, log: quiet });
    assert.equal(done?.status, "completed");
    assert.equal(seen.at(-1)?.token, SPARE);
    assert.equal(loadRecord(paths, record.runId)?.limit, undefined);
  });

  it("remove is refused while an unfinished run uses the account", () => {
    const { paths, projectDir } = setup({ one: ONE_STEP });
    addAccount(paths, "work", WORK);
    useAccount(paths, "work", { atLimit: () => false, resume: quiet });
    const record = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    assert.throws(() => removeAccount(paths, "work", new Set([record.runId])), new RegExp(`${record.runId} uses account work`));
    removeAccount(paths, "work", new Set());
  });

  it("orc account lists, switches and removes; add reads the token from stdin off a terminal", async () => {
    const { paths } = setup();
    const here = dirname(dirname(fileURLToPath(import.meta.url)));
    const env = { ...process.env, ORC_HOME: paths.home };
    delete env.CLAUDECODE;
    const added = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "account", "add", "work"], { cwd: here, env, input: `${WORK}\n`, encoding: "utf8" });
    assert.equal(added, "added Claude Code account work. orc account use work makes orc use it.\n");
    const refused = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "account", "add", "work"], { cwd: here, env, input: `${SPARE}\n`, encoding: "utf8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /there is an account work already/);
    const usage = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "account", "swap", "work"], { cwd: here, env, encoding: "utf8" });
    assert.equal(usage.status, 64);

    const lines: string[] = [];
    const out = (line: string) => lines.push(line);
    await withHome(paths, async () => {
      await cmdAccount(["use", "work"], { out });
      await cmdAccount([], { out });
      process.env.CLAUDECODE = "1";
      try {
        await cmdAccount(["list"], { out });
      } finally {
        delete process.env.CLAUDECODE;
      }
      await cmdAccount(["rm", "work"], { out });
    });
    const text = lines.join("\n");
    assert.match(text, /^orc uses Claude Code account work for new runs\.$/m);
    assert.match(text, /^Claude Code\n  default        Claude Code's own login, in \S+\n\* work           login token, added \d{4}-\d\d-\d\d\nCodex\n\* codex\/default  Codex's own login, in /m);
    assert.match(text, /This shell is a Claude Code session\. A run started here uses that session's login for its Claude Code steps\./);
    assert.match(text, /^removed Claude Code account work\. orc uses default\.$/m);
    assert.doesNotMatch(text, /sk-ant/);

    const json = await withHome(paths, () => main(["account", "--json"]));
    assert.deepEqual(JSON.parse(json.printed).accounts.map((row: { name: string }) => row.name), ["default", "default"]);
  });
});

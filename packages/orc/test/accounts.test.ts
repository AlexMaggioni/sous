import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  addAccount,
  currentAccount,
  limitNotice,
  listAccounts,
  loadRecord,
  removeAccount,
  useAccount,
  workerProcess,
  type HomePaths,
} from "@orchestrator/engine";
import {
  createRun,
  enginePersistence,
  fakeRunner,
  plantState,
  processAlive,
  readState,
  runWorker,
  testHome,
  tick,
  WorkflowError,
  WorkflowErrorCode,
  type InnerRunner,
} from "@orchestrator/engine/testing";
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

/** A cli file that does not exist. A worker process started with it ends at once. */
const NO_CLI = "/nonexistent/orc/cli.js";

const ONE_STEP = `export const meta = { name: 'one', description: 'one step' }\nreturn await agent('go', { label: 'go' })`;

/** The account a step gets: its folder, its token, and whether it is one of orc's named logins. */
interface SeenAccount {
  token?: string;
  folder?: string;
  named?: boolean;
}

/** A runner that notes the account each step gets, and can stop at the usage limit. */
function loginRunner(limited: () => boolean = () => false): { runner: InnerRunner; seen: SeenAccount[] } {
  const seen: SeenAccount[] = [];
  const { runner } = fakeRunner((call) => {
    seen.push({ ...(call.options.account as SeenAccount | undefined) });
    if (limited()) {
      const reset = new Date(Date.now() + 2 * 3600_000).toISOString();
      throw new WorkflowError("You've hit your limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false, resetHint: `Resets at ${reset}` });
    }
    return "done";
  });
  return { runner, seen };
}

/** A runner whose steps stop at the usage limit. The reset time, if any, is in the error's typed
 *  context alone, with no resetHint. */
function typedLimitRunner(resetAt: string | undefined): InnerRunner {
  return {
    async run() {
      throw new WorkflowError("You've hit your limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable: false,
        providerUsageLimitContext: { backendId: "claude", source: "provider", ...(resetAt ? { resetAt } : {}) },
      });
    },
  } as unknown as InnerRunner;
}

/** Wait until the worker that orc account use started for a run is gone. Its cli file does not
 *  exist, so it ends at once. */
async function workerGone(paths: HomePaths, runId: string): Promise<void> {
  const pid = loadRecord(paths, runId)?.pid;
  assert.ok(pid, "the run has a worker");
  for (let i = 0; i < 400 && processAlive(pid); i++) await new Promise((done) => setTimeout(done, 25));
  assert.ok(!processAlive(pid), `worker ${pid} ended`);
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
    const { paths } = testHome();
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

    useAccount(paths, "work", () => assert.fail("nothing waits"));
    assert.equal(currentAccount(paths, "claude"), "work");
    assert.throws(() => useAccount(paths, "nobody", quiet), /no account nobody/);

    removeAccount(paths, "work");
    assert.equal(currentAccount(paths, "claude"), "default", "removing the current account goes back to default");
    assert.throws(() => removeAccount(paths, "work"), /no account work/);
    assert.deepEqual(listAccounts(paths).map((row) => row.name), ["default", "spare", "default"]);
    assert.doesNotMatch(readFileSync(paths.accounts, "utf8"), new RegExp(WORK));
  });

  it("a run records orc's account, and its steps run on that login, as a named one whose API key the harness removes", async () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    addAccount(paths, "work", WORK);
    useAccount(paths, "work", quiet);
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
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    addAccount(paths, "work", WORK);
    addAccount(paths, "spare", SPARE);
    useAccount(paths, "spare", quiet);

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
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    addAccount(paths, "work", WORK);
    useAccount(paths, "work", quiet);
    const parent = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    useAccount(paths, "default", quiet);
    const child = createRun(paths, { workflow: "one", projectDir, inputs: {}, startedByRun: parent.runId, caller: true });
    assert.deepEqual(child.accounts, parent.accounts);
  });

  it("at the usage limit the run waits and says whose limit it is; orc account use moves it and it goes on", async () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    let limited = true;
    const { runner, seen } = loginRunner(() => limited);
    const record = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    const lines: string[] = [];
    const paused = await runWorker(record.runId, "start", { paths, inner: runner, log: (line) => lines.push(line) });
    assert.equal(paused?.status, "paused");
    assert.equal(readState(paths, record.runId)?.pauseReason, "usage_limit");
    assert.deepEqual({ ...loadRecord(paths, record.runId)?.limit, at: undefined }, { program: "claude", account: "default", at: undefined });
    const notice = lines.find((line) => line.includes(" limit      "));
    assert.match(String(notice), /Claude Code's own login \(default\) hit its usage limit\. It resets at \d\d:\d\d\. orc account use <name> goes on now on another account\./);

    addAccount(paths, "spare", SPARE);
    const resumed: string[] = [];
    const result = useAccount(paths, "spare", (_paths, runId) => resumed.push(runId));
    assert.deepEqual(resumed, [record.runId]);
    assert.deepEqual(result.moved, [{ runId: record.runId, workflow: "one", from: "default" }]);
    assert.equal(loadRecord(paths, record.runId)?.accounts?.claude?.name, "spare");
    assert.equal(loadRecord(paths, record.runId)?.accounts?.claude?.folder, process.env.CLAUDE_CONFIG_DIR, "the run keeps its settings folder");

    // A run at the limit of the account orc uses now waits for the reset.
    const second = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    await runWorker(second.runId, "start", { paths, inner: runner, log: quiet });
    const show = await withHome(paths, () => main(["show", second.runId]));
    assert.match(show.printed, /limit     Claude Code account spare hit its usage limit\. It resets at \d\d:\d\d\. orc account use <name> goes on now on another account\./);
    // orc goes back to default without moving the runs, which orc account use would do.
    const file = JSON.parse(readFileSync(paths.accounts, "utf8"));
    delete file.current.claude;
    writeFileSync(paths.accounts, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    assert.equal(currentAccount(paths, "claude"), "default");
    assert.match(limitNotice(paths, loadRecord(paths, second.runId)!, undefined), /^Claude Code account spare hit its usage limit\. orc account use default moves it to the account orc uses now\.$/);
    const again = useAccount(paths, "spare", (_paths, runId) => resumed.push(runId));
    // The second run hit spare's limit, so it waits. The first is on spare too, but no worker ran
    // it there, so it still waits at default's limit, and spare resumes it again.
    assert.deepEqual(again.same, [{ runId: second.runId, workflow: "one", from: "spare" }]);
    assert.deepEqual(again.moved, [{ runId: record.runId, workflow: "one", from: "default" }]);
    assert.deepEqual(resumed, [record.runId, record.runId], "the run at spare's own limit is not resumed on spare");

    // The worker that resumes it runs the step on the new login, and the limit is gone from the record.
    limited = false;
    const done = await runWorker(record.runId, "resume", { paths, inner: runner, log: quiet });
    assert.equal(done?.status, "completed");
    assert.equal(seen.at(-1)?.token, SPARE);
    assert.equal(loadRecord(paths, record.runId)?.limit, undefined);
  });

  it("a limit known only by its typed reset time says when it resets, and the service resumes the run 30 seconds after it", async () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    const resetAt = new Date(Date.now() + 2 * 3600_000);
    const record = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    const lines: string[] = [];
    const paused = await runWorker(record.runId, "start", { paths, inner: typedLimitRunner(resetAt.toISOString()), log: (line) => lines.push(line) });
    assert.equal(paused?.status, "paused");
    const hhmm = resetAt.toTimeString().slice(0, 5);
    assert.match(String(lines.find((line) => line.includes(" limit      "))), new RegExp(`hit its usage limit\\. It resets at ${hhmm}\\.`));
    const show = await withHome(paths, () => main(["show", record.runId]));
    assert.match(show.printed, new RegExp(`limit     .* hit its usage limit\\. It resets at ${hhmm}\\.`));

    const spawned: string[] = [];
    const launch = (_paths: unknown, runId: string) => spawned.push(runId);
    const deps = { log: quiet, notify: quiet };
    tick(paths, launch, { ...deps, now: new Date(resetAt.getTime() + 29_000) });
    assert.deepEqual(spawned, [], "the run waits until 30 seconds after the reset");
    tick(paths, launch, { ...deps, now: new Date(resetAt.getTime() + 30_000) });
    assert.deepEqual(spawned, [record.runId]);
  });

  it("a limit with no reset time is tried again 30 minutes after the pause, whatever saves the state later", async () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    const record = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    await runWorker(record.runId, "start", { paths, inner: typedLimitRunner(undefined), log: quiet });
    const persistence = enginePersistence(paths);
    const first = persistence.load(record.runId)!;
    assert.equal(first.pauseReason, "usage_limit");
    const pausedAt = first.pausedAt;
    assert.ok(pausedAt && Number.isFinite(Date.parse(pausedAt)), "the state says when the run paused");
    await new Promise((done) => setTimeout(done, 5));
    persistence.save(first);
    const later = persistence.load(record.runId)!;
    assert.equal(later.pausedAt, pausedAt, "a later save keeps the pause time");
    assert.ok(Date.parse(later.updatedAt) > Date.parse(pausedAt), "the later save moved updatedAt");

    const spawned: string[] = [];
    const launch = (_paths: unknown, runId: string) => spawned.push(runId);
    const deps = { log: quiet, notify: quiet };
    tick(paths, launch, { ...deps, now: new Date(Date.parse(pausedAt) + 30 * 60_000 - 1000) });
    assert.deepEqual(spawned, [], "the run waits 30 minutes from the pause");
    tick(paths, launch, { ...deps, now: new Date(Date.parse(pausedAt) + 30 * 60_000) });
    assert.deepEqual(spawned, [record.runId], "the time counts from the pause, not from the later save");
  });

  it("remove is refused while an unfinished run uses the account", () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    addAccount(paths, "work", WORK);
    useAccount(paths, "work", quiet);
    const record = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    assert.throws(() => removeAccount(paths, "work"), new RegExp(`^Error: ${record.runId} uses account work\\.`));
    // A run that has not started yet counts as unfinished too. Once it is done, the account can go.
    plantState(paths, { runId: record.runId, status: "completed", startedAt: record.createdAt, updatedAt: record.createdAt, agents: [], logs: [], phases: [] });
    removeAccount(paths, "work");
    assert.deepEqual(listAccounts(paths).map((row) => row.name), ["default", "default"]);
  });

  it("orc account rm names every unfinished run on the account, waiting or not started, and exits 1", async () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    addAccount(paths, "work", WORK);
    useAccount(paths, "work", quiet);
    const waiting = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    await runWorker(waiting.runId, "start", { paths, inner: loginRunner(() => true).runner, log: quiet });
    assert.equal(readState(paths, waiting.runId)?.pauseReason, "usage_limit");
    const fresh = createRun(paths, { workflow: "one", projectDir, inputs: {} });

    const errors: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => (errors.push(String(chunk)), true)) as typeof process.stderr.write;
    let removed;
    try {
      removed = await withHome(paths, () => main(["account", "rm", "work"]));
    } finally {
      process.stderr.write = write;
    }
    assert.equal(removed.value, 1);
    assert.equal(removed.printed, "");
    assert.equal(
      errors.join(""),
      `orc: ${fresh.runId}, ${waiting.runId} use account work. orc account use <name> moves the runs waiting at the limit to another account. Stop or finish the others first.\n`,
    );
    assert.equal(currentAccount(paths, "claude"), "work", "the account stays");
  });

  it("orc account lists, switches and removes; add reads the token from stdin off a terminal", async () => {
    const { paths } = testHome();
    const here = dirname(dirname(fileURLToPath(import.meta.url)));
    const env: NodeJS.ProcessEnv = { ...process.env, ORC_HOME: paths.home };
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
      await cmdAccount(["use", "work"], { out, launch: () => assert.fail("no run waits, so orc account use starts no worker") });
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

  it("orc account lists the runs waiting at the limit, and orc account use says which wait and which it moved", async () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    addAccount(paths, "spare", SPARE);
    const lines: string[] = [];
    const out = (line: string) => lines.push(line);
    // The worker it starts for a moved run never runs: the cli file does not exist.
    const use = (name: string) => withHome(paths, () => cmdAccount(["use", name], { out, launch: workerProcess(() => NO_CLI) }));

    await use("spare");
    assert.deepEqual(lines.splice(0), ["orc uses Claude Code account spare for new runs."]);

    const { runner } = loginRunner(() => true);
    const record = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    await runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
    assert.equal(readState(paths, record.runId)?.pauseReason, "usage_limit");

    const listed = await withHome(paths, () => main(["account"]));
    assert.ok(
      listed.printed.endsWith(`\nWaiting at the usage limit:\n  ${record.runId}  one  on spare\norc account use <name> moves them to another account and resumes them now.\n`),
      listed.printed,
    );
    const json = JSON.parse((await withHome(paths, () => main(["account", "--json"]))).printed);
    assert.equal(json.waiting.length, 1);
    assert.deepEqual({ ...json.waiting[0], limit: { ...json.waiting[0].limit, at: undefined } }, { runId: record.runId, workflow: "one", limit: { program: "claude", account: "spare", at: undefined } });
    assert.ok(Number.isFinite(Date.parse(json.waiting[0].limit.at)), "the limit says when it was hit");

    // The run hit the limit of spare, the account orc uses now, so it waits for the reset.
    await use("spare");
    assert.deepEqual(lines.splice(0), [
      "orc uses Claude Code account spare for new runs.",
      `${record.runId}  one  waits at the limit of spare itself, and goes on after the reset`,
    ]);
    assert.equal(loadRecord(paths, record.runId)?.pid, undefined, "a run that waits gets no worker");

    // Another account moves it and starts its worker.
    await use("default");
    assert.deepEqual(lines.splice(0), [
      "orc uses Claude Code account default for new runs.",
      `resumed ${record.runId}  one  on default, was waiting at the limit of spare`,
    ]);
    assert.equal(loadRecord(paths, record.runId)?.accounts?.claude?.name, "default");
    assert.ok(loadRecord(paths, record.runId)?.pid, "the moved run has a worker");
  });

  it("orc account use goes by the account whose limit a run hit, so a second use after a move whose worker did not start tries again", async () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP });
    addAccount(paths, "spare", SPARE);
    const lines: string[] = [];
    const out = (line: string) => lines.push(line);
    const use = (name: string) => withHome(paths, () => cmdAccount(["use", name], { out, launch: workerProcess(() => NO_CLI) }));

    const { runner } = loginRunner(() => true);
    const record = createRun(paths, { workflow: "one", projectDir, inputs: {} });
    await runWorker(record.runId, "start", { paths, inner: runner, log: quiet });
    assert.equal(readState(paths, record.runId)?.pauseReason, "usage_limit");

    // The move to spare starts a worker that never runs, so the run still waits at default's limit.
    await use("spare");
    assert.deepEqual(lines.splice(0), ["orc uses Claude Code account spare for new runs.", `resumed ${record.runId}  one  on spare, was waiting at the limit of default`]);
    await workerGone(paths, record.runId);
    const first = loadRecord(paths, record.runId)?.pid;
    assert.equal(loadRecord(paths, record.runId)?.accounts?.claude?.name, "spare");
    assert.equal(loadRecord(paths, record.runId)?.limit?.account, "default");
    const listed = await withHome(paths, () => main(["account"]));
    assert.ok(listed.printed.includes(`\n  ${record.runId}  one  on default\n`), listed.printed);

    // The same use again tries the resume again. Before, it said the run waits at the limit of
    // spare itself, though spare hit no limit.
    await use("spare");
    assert.deepEqual(lines.splice(0), ["orc uses Claude Code account spare for new runs.", `resumed ${record.runId}  one  on spare, was waiting at the limit of default`]);
    assert.notEqual(loadRecord(paths, record.runId)?.pid, first, "the run has a new worker");
    await workerGone(paths, record.runId);

    // The account whose limit it hit leaves it waiting. Before, this moved it back to default.
    await use("default");
    assert.deepEqual(lines.splice(0), ["orc uses Claude Code account default for new runs.", `${record.runId}  one  waits at the limit of default itself, and goes on after the reset`]);
    assert.equal(loadRecord(paths, record.runId)?.accounts?.claude?.name, "spare", "a run that waits keeps its account");
  });
});

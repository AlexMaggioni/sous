import assert from "node:assert/strict";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { ensureHome, homePaths, runQuestions, type HomePaths } from "@sous/engine";
import { inProcess, plantState, readState, testHome, tick, workflowProjectPaths, type InnerRunner } from "@sous/engine/testing";
import { main } from "../src/cli.js";
import { capture, sous, waitFor } from "./sous.js";
import { deadPid } from "./helpers/process.js";

// sous's reads write nothing. The home below is planted with raw writes, the way the worker and
// the engine leave it, so the test also shows that sous reads today's files.

delete process.env.SOUS_RUN_ID;
delete process.env.CLAUDECODE;

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

interface Planted {
  root: string;
  paths: HomePaths;
  ids: { dead: string; limit: string; done: string; asking: string; live: string };
}

function plant(): Planted {
  const root = mkdtempSync(join(tmpdir(), "sous-reads-"));
  const paths = ensureHome(homePaths(join(root, "home")));
  writeJson(paths.config, { notify: false, defaultPlace: "folder" });
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".sous", "workflows"), { recursive: true });
  // The engine's folder for sous's runs.
  const engine = workflowProjectPaths(paths.home, { persistenceRoot: paths.runs }).runsDir;
  mkdirSync(engine, { recursive: true });

  const now = new Date();
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const ids = { dead: "run-dead", limit: "run-limit", done: "run-done", asking: "run-asking", live: "run-live" };
  const record = (runId: string, minutesAgo: number, extra: Record<string, unknown> = {}) =>
    writeJson(join(paths.records, `${runId}.json`), {
      runId,
      workflow: "build",
      file: join(projectDir, ".sous", "workflows", "build.js"),
      args: {},
      place: "folder",
      cwd: projectDir,
      projectDir,
      priority: "user",
      origin: "cli",
      createdAt: at(minutesAgo),
      ...extra,
    });
  const state = (runId: string, minutesAgo: number, extra: Record<string, unknown>) => {
    const saved = {
      runId,
      workflowName: "build",
      script: "return 1",
      phases: [],
      agents: [{ id: 1, label: "first", status: "done", startedAt: at(minutesAgo), endedAt: at(minutesAgo) }],
      logs: [],
      startedAt: at(minutesAgo),
      updatedAt: at(minutesAgo),
      ...extra,
    };
    writeJson(join(engine, `${runId}.json`), saved);
    writeJson(join(engine, `${runId}.json.bak`), saved);
  };

  // A running run whose worker died, with the lock it left.
  const gone = deadPid();
  record(ids.dead, 50, { pid: gone });
  state(ids.dead, 50, { status: "running" });
  writeJson(join(engine, `${ids.dead}.lock`), { runId: ids.dead, runPath: join(engine, `${ids.dead}.json`), pid: gone, startedAt: at(50), token: "stale" });

  // A run paused at the usage limit a minute ago. With no reset time, it resumes in 30 minutes.
  record(ids.limit, 40, { limit: { program: "claude", account: "default", at: at(1) } });
  state(ids.limit, 1, { status: "paused", pauseReason: "usage_limit", reason: "usage limit reached" });

  // A finished run with its log.
  record(ids.done, 30);
  state(ids.done, 29, { status: "completed", result: "all done", completedAt: at(29), durationMs: 60_000 });
  writeFileSync(join(paths.logs, `${ids.done}.log`), "12:00:00 run        build\n12:01:00 completed  build\n");

  // A run paused at a question that is still open.
  record(ids.asking, 20);
  state(ids.asking, 19, { status: "paused", pauseReason: "checkpoint_required" });
  writeJson(join(paths.inbox, `${ids.asking}--0.json`), {
    id: `${ids.asking}--0`,
    runId: ids.asking,
    scope: ids.asking,
    callIndex: 0,
    hash: "h",
    workflow: "build",
    prompt: "Ship it?",
    kind: "confirm",
    breakpoint: false,
    askedAt: at(19),
  });

  // A run whose worker is this process, with its lock and an empty event log.
  record(ids.live, 10, { pid: process.pid });
  state(ids.live, 10, { status: "running", eventStreamId: "0123456789abcdef0123456789abcdef", eventSeq: 0 });
  writeFileSync(join(engine, `${ids.live}.events.jsonl`), "");
  writeJson(join(engine, `${ids.live}.lock`), { runId: ids.live, runPath: join(engine, `${ids.live}.json`), pid: process.pid, startedAt: at(10), token: "live" });

  return { root, paths, ids };
}

/** Every file and folder under root, with its size and time. Paths in `skip` are not noted. */
function walk(root: string, skip: ReadonlySet<string> = new Set()): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        if (!skip.has(path)) seen.set(`${path}/`, String(stat.mtimeMs));
        visit(path);
      } else if (!skip.has(path)) {
        seen.set(path, `${stat.size} bytes, ${stat.mtimeMs}`);
      }
    }
  };
  visit(root);
  return seen;
}

/** What changed between two walks, one line per path. */
function changes(before: Map<string, string>, after: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const [path, was] of before) {
    const now = after.get(path);
    if (now === undefined) lines.push(`removed ${path}`);
    else if (now !== was) lines.push(`changed ${path}`);
  }
  for (const path of after.keys()) if (!before.has(path)) lines.push(`added ${path}`);
  return lines;
}

describe("sous's reads", () => {
  it("write no file", async () => {
    const { root, paths, ids } = plant();
    const before = walk(root);
    const runs = Object.values(ids);
    const commands: string[][] = [
      ["list"],
      ["list", "--all"],
      ["list", "--json"],
      ...runs.flatMap((id) => [["show", id], ["show", id, "--json"]]),
      ["wait", ids.done],
      ["wait", ids.done, "--json"],
      ["wait", ids.dead],
      ["inbox"],
      ["inbox", "--json"],
      ["log", ids.done],
      ["log", ids.done, "-f"],
      ["account", "list"],
      ["account", "list", "--json"],
    ];
    const printed = new Map<string, { code: number; out: string }>();
    for (const argv of commands) printed.set(argv.join(" "), await sous(paths, argv));
    assert.deepEqual(changes(before, walk(root)), []);

    // The reads still say what they said when they wrote: the dead run reads as interrupted.
    for (const [command, { code, out }] of printed) {
      const expected = command === `wait ${ids.dead}` ? 2 : 0;
      assert.equal(code, expected, `sous ${command} printed:\n${out}`);
    }
    assert.match(printed.get("list")!.out, new RegExp(`${ids.dead}\\s+build\\s+interrupted`));
    assert.match(printed.get(`show ${ids.dead}`)!.out, /status {4}interrupted/);
    assert.equal(printed.get(`log ${ids.done} -f`)!.out, "12:00:00 run        build\n12:01:00 completed  build\n", "a run with no worker prints its log once");
  });

  /**
   * A live run whose record names this process as its worker, so it counts as running until the
   * record changes. The log holds one line.
   */
  function plantFollowed(paths: HomePaths, doneId: string) {
    const runId = "run-follow";
    const file = join(paths.records, `${runId}.json`);
    const record = { ...JSON.parse(readFileSync(join(paths.records, `${doneId}.json`), "utf8")), runId };
    writeJson(file, { ...record, pid: process.pid });
    const log = join(paths.logs, `${runId}.log`);
    writeFileSync(log, "12:00:00 run        build\n");
    return { runId, log, workerEnds: () => writeJson(file, { ...record, pid: deadPid() }), runGoes: () => rmSync(file, { force: true }) };
  }

  /** Run `sous log <runId> -f` in this process. `printed()` is what it has written so far, to stdout and stderr. */
  function follow(paths: HomePaths, runId: string) {
    const before = process.env.SOUS_HOME;
    process.env.SOUS_HOME = paths.home;
    const chunks: string[] = [];
    const restore = capture(chunks);
    const ended = main(["log", runId, "-f"]).finally(() => {
      restore();
      if (before === undefined) delete process.env.SOUS_HOME;
      else process.env.SOUS_HOME = before;
    });
    return { printed: () => chunks.join(""), ended };
  }

  it("keep the reply of sous log --json under 8,000 characters, though quotes print longer than they are", async () => {
    const { paths, ids } = plant();
    const text = `12:00:00 agent      said ${'"'.repeat(40)}\n`.repeat(300);
    writeFileSync(join(paths.logs, `${ids.done}.log`), text);
    const result = await sous(paths, ["log", ids.done, "--json"]);
    assert.equal(result.code, 0, result.out);
    const printed = result.out.trimEnd();
    assert.ok(printed.length <= 8000, `the reply is ${printed.length} characters`);
    const reply = JSON.parse(printed) as { log: string; notes: string[] };
    assert.ok(text.endsWith(reply.log), "the log is the end of the file");
    assert.ok(reply.log.length > 3000, `it keeps as much as fits, here ${reply.log.length} characters`);
    assert.deepEqual(reply.notes, [`The log is longer. This is its last ${reply.log.length} characters. sous log ${ids.done} prints all of it.`]);

    const whole = JSON.parse((await sous(paths, ["log", ids.dead, "--json"])).out) as { log: string; notes: string[] };
    assert.deepEqual(whole.notes, [], "a short log comes whole, with no note");
  });

  it("let sous log -f print the log, then what the worker adds, until the worker ends", async () => {
    const { paths, ids } = plant();
    const { runId, log, workerEnds } = plantFollowed(paths, ids.done);
    const following = follow(paths, runId);
    try {
      await waitFor(() => following.printed().includes("build\n"), "the log so far");
      assert.equal(following.printed(), "12:00:00 run        build\n", "the log so far comes at once");
      appendFileSync(log, "12:01:00 agent      first\n");
      await waitFor(() => following.printed().includes("first\n"), "a line the worker adds");
      assert.equal(following.printed(), "12:00:00 run        build\n12:01:00 agent      first\n", "a line the worker adds comes while it runs");

      // The line written just before the worker ends comes too.
      appendFileSync(log, "12:02:00 completed  build\n");
      workerEnds();
      assert.equal(await following.ended, 0, following.printed());
      assert.equal(following.printed(), "12:00:00 run        build\n12:01:00 agent      first\n12:02:00 completed  build\n");
    } finally {
      // A failed assert must not leave the follow running, since this process counts as the worker.
      workerEnds();
      await following.ended;
    }
  });

  it("let sous log -f print the no run error, and exit 1, when the run goes away while it follows", async () => {
    const { paths, ids } = plant();
    const { runId, runGoes } = plantFollowed(paths, ids.done);
    const following = follow(paths, runId);
    try {
      await waitFor(() => following.printed().includes("build\n"), "the log so far");
      runGoes();
      assert.equal(await following.ended, 1);
      assert.equal(following.printed(), `12:00:00 run        build\nsous: no run "${runId}". sous list shows the runs.\n`);
    } finally {
      runGoes();
      await following.ended;
    }
  });

  it("let sous stop on a paused run change only that run's files", async () => {
    const { root, paths, ids } = plant();
    const engine = workflowProjectPaths(paths.home, { persistenceRoot: paths.runs });
    const before = walk(root);
    const { code, out } = await sous(paths, ["stop", ids.limit]);
    assert.equal(code, 0, out);
    assert.equal(out.trim(), `stopped ${ids.limit}`);
    assert.equal(readState(paths, ids.limit)?.status, "aborted");

    // Each file that changed is the stopped run's, and each folder that changed holds one of them.
    const changed = changes(before, walk(root)).map((line) => line.replace(/^\w+ /, ""));
    const files = changed.filter((path) => !path.endsWith("/"));
    const folders = changed.filter((path) => path.endsWith("/")).map((path) => path.slice(0, -1));
    assert.ok(files.includes(join(engine.runsDir, `${ids.limit}.json`)), changed.join("\n"));
    assert.deepEqual(files.filter((file) => !basename(file).startsWith(`${ids.limit}.`)), [], "no other run's file changed");
    assert.deepEqual(folders.filter((folder) => !files.some((file) => dirname(file) === folder)), [], "no other folder changed");
  });

  it("leave every file but the service's own state as it was after a tick", async () => {
    const { root, paths, ids } = plant();
    const skip = new Set([paths.home, paths.daemonState]);
    const before = walk(root, skip);
    const lines: string[] = [];
    const spawned: string[] = [];
    tick(paths, (_paths, runId) => spawned.push(runId), { log: (line) => lines.push(line), notify: () => {} });
    assert.deepEqual(changes(before, walk(root, skip)), []);
    assert.deepEqual(spawned, []);
    assert.ok(lines.some((line) => line.includes(`run ${ids.dead} was cut off`)), lines.join("\n"));
  });
});

// Piece 4: the run reply, wait, show and status. The workflows hello, asks and fails are copies
// of the agent-native proof's fixtures, in test/fixtures/workflows. Their steps are js, sh and
// ask, so no program runs. The slow workflow's one agent step waits on the test's fake runner.

const FIXTURES = join(import.meta.dirname, "fixtures", "workflows");
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.js`), "utf8");
const SLOW = `export const meta = { name: 'slow', description: 'one step that waits', place: 'none' }
return await agent('wait here', { label: 'slow' })`;

/** A runner for workflows whose agent steps wait until `release`. */
function heldRunner(): { runner: InnerRunner; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  const runner = { run: async () => (await held, "late") } as unknown as InnerRunner;
  return { runner, release };
}

/** The --json reply sous printed, with its notes and next checked. */
function replyIn(printed: { code: number; out: string }): Record<string, unknown> & { notes: string[]; next: Array<{ call: string; does: string }> } {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  const reply = parsed as Record<string, unknown>;
  assert.ok(reply && typeof reply === "object" && !Array.isArray(reply), printed.out);
  assert.ok(Array.isArray(reply.notes), `notes is an array: ${printed.out}`);
  assert.ok(Array.isArray(reply.next), `next is an array: ${printed.out}`);
  for (const next of reply.next as Array<Record<string, unknown>>) {
    assert.equal(typeof next.call, "string", printed.out);
    assert.equal(typeof next.does, "string", printed.out);
  }
  return reply as Record<string, unknown> & { notes: string[]; next: Array<{ call: string; does: string }> };
}

const calls = (reply: { next: Array<{ call: string }> }) => reply.next.map((next) => next.call);

/** The keys the short `sous show --json` may have, besides notes and next. A failed run's step
 *  and message sit under failure, since a reply keeps error for a refusal. */
const SHORT_SHOW = new Set(["runId", "workflow", "status", "word", "cwd", "branch", "worktree", "startedAt", "seconds", "tokens", "steps", "questions", "failure", "notes", "next"]);

/** Start a fixture's run with --json through workers in this process, and give the reply. */
async function started(paths: HomePaths, projectDir: string, workers: ReturnType<typeof inProcess>, argv: string[]) {
  const run = await sous(paths, ["run", ...argv, "--json", "--project", projectDir], { launch: workers.launch });
  assert.equal(run.code, 0, run.out);
  const reply = replyIn(run);
  const runId = reply.runId as string;
  assert.equal(runId, workers.launched.at(-1)!.runId);
  return { reply, runId };
}

/** A record for a planted run. A `pid` of this process makes its worker alive. */
function plantRecord(paths: HomePaths, projectDir: string, runId: string, createdAt: string, extra: Record<string, unknown> = {}): void {
  writeJson(join(paths.records, `${runId}.json`), { runId, workflow: "build", file: join(projectDir, ".sous", "workflows", "build.js"), args: {}, place: "folder", cwd: projectDir, projectDir, priority: "user", origin: "cli", createdAt, ...extra });
}

/** A home with a live run at a select question, a run paused at a usage limit, and a run that
 *  finished two hours ago. */
function plantStatus(): { paths: HomePaths; projectDir: string; root: string; questionId: string } {
  const { paths, projectDir } = testHome();
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const base = { workflowName: "build", script: "return 1", phases: [], agents: [], logs: [] };

  plantRecord(paths, projectDir, "run-asking", at(20), { pid: process.pid });
  plantState(paths, { ...base, runId: "run-asking", status: "running", startedAt: at(20), updatedAt: at(19) }, "");
  const questionId = "run-asking--0";
  writeJson(join(paths.inbox, `${questionId}.json`), { id: questionId, runId: "run-asking", scope: "run-asking", callIndex: 0, hash: "h0", workflow: "build", prompt: "Which color?", kind: "select", choices: ["red", "blue"], breakpoint: false, askedAt: at(19) });

  plantRecord(paths, projectDir, "run-limit", at(40), { limit: { program: "claude", account: "default", at: at(2) } });
  plantState(paths, { ...base, runId: "run-limit", status: "paused", pauseReason: "usage_limit", reason: "usage limit reached", resetAt: new Date(Date.now() + 3600_000).toISOString(), pausedAt: at(2), startedAt: at(40), updatedAt: at(2) });

  plantRecord(paths, projectDir, "run-done", at(125));
  plantState(paths, { ...base, runId: "run-done", status: "completed", result: "done", startedAt: at(125), updatedAt: at(120), completedAt: at(120), durationMs: 300_000 });
  return { paths, projectDir, root: dirname(paths.home), questionId };
}

describe("piece 4: the run reply and sous wait", () => {
  it("the hello run reply keeps today's fields, starts its next with the wait, and that wait exits 0 with hello Ada under review", async () => {
    const { paths, projectDir } = testHome({ hello: fixture("hello") });
    const workers = inProcess({ inner: heldRunner().runner });
    const { reply: run, runId } = await started(paths, projectDir, workers, ["hello", "--name", "Ada"]);
    assert.equal(run.workflow, "hello");
    assert.equal(typeof run.cwd, "string");
    assert.equal(typeof run.log, "string");
    assert.equal(run.status, "starting");
    assert.equal(run.asks, 0, "hello asks nothing");
    assert.equal(run.next[0]?.call, `sous wait ${runId} --json`);
    assert.ok(calls(run).includes(`sous show ${runId} --json`), JSON.stringify(run.next));

    const waited = await sous(paths, ["wait", runId, "--json"]);
    assert.equal(waited.code, 0, waited.out);
    const wait = replyIn(waited);
    assert.equal(wait.status, "completed");
    assert.equal((wait.review as { result?: unknown } | undefined)?.result, "hello Ada", waited.out);
    assert.ok(calls(wait).includes(`sous show ${runId} --json`), JSON.stringify(wait.next));
    await workers.ended(runId);
  });

  it("the run reply gives what the workflow's last runs cost under lastRuns", async () => {
    const { paths, projectDir } = testHome({ hello: fixture("hello") });
    const workers = inProcess({ inner: heldRunner().runner });
    const first = await started(paths, projectDir, workers, ["hello", "--name", "Ada"]);
    assert.deepEqual(first.reply.lastRuns, { count: 0, seconds: 0, tokens: 0 }, "no run of hello came before");
    assert.equal((await workers.ended(first.runId))?.status, "completed");

    const second = await started(paths, projectDir, workers, ["hello", "--name", "Bo"]);
    const last = second.reply.lastRuns as { count: number; seconds: number; tokens: number };
    assert.equal(last.count, 1, JSON.stringify(last));
    assert.equal(typeof last.seconds, "number");
    assert.equal(last.tokens, 0, "a js step spends no tokens");
    await workers.ended(second.runId);
  });

  it("the asks run reply counts its ask, and its wait exits 4 with one question for people and the answer call", async () => {
    const { paths, projectDir } = testHome({ asks: fixture("asks") });
    const workers = inProcess({ inner: heldRunner().runner });
    const { reply: run, runId } = await started(paths, projectDir, workers, ["asks"]);
    try {
      assert.equal(run.asks, 1, "the parse finds one ask");
      const waited = await sous(paths, ["wait", runId, "--json"]);
      assert.equal(waited.code, 4, waited.out);
      const wait = replyIn(waited);
      assert.equal(wait.status, "asks");
      const questions = wait.questions as Array<Record<string, unknown>>;
      assert.equal(questions.length, 1, waited.out);
      const [question] = questions;
      assert.equal(question!.prompt, "Which color?");
      assert.deepEqual(question!.choices, ["red", "blue"]);
      assert.equal(question!.answeredBy, "people");
      assert.ok(calls(wait).some((call) => call.startsWith(`sous answer ${question!.id} `)), JSON.stringify(wait.next));
      assert.ok(calls(wait).includes(`sous wait ${runId} --json`), JSON.stringify(wait.next));
    } finally {
      await waitFor(() => runQuestions(paths, runId).length > 0, "the asks run's question");
      for (const open of runQuestions(paths, runId)) await sous(paths, ["answer", open.id, "red"]);
      await workers.ended(runId);
    }
  });

  it("the fails wait exits 2 with failure.step boom, and next holds the step and resume calls", async () => {
    const { paths, projectDir } = testHome({ fails: fixture("fails") });
    const workers = inProcess({ inner: heldRunner().runner });
    const { runId } = await started(paths, projectDir, workers, ["fails"]);
    const waited = await sous(paths, ["wait", runId, "--json"]);
    assert.equal(waited.code, 2, waited.out);
    const wait = replyIn(waited);
    assert.equal(wait.status, "paused");
    assert.equal(wait.pauseReason, "step_failed");
    const failed = wait.failure as { step?: string; message?: string } | undefined;
    assert.equal(failed?.step, "boom", waited.out);
    assert.match(failed?.message ?? "", /code 3|disk check failed/);
    assert.ok(calls(wait).includes(`sous step ${runId} boom --json`), JSON.stringify(wait.next));
    assert.ok(calls(wait).includes(`sous resume ${runId} --json`), JSON.stringify(wait.next));
    await workers.ended(runId);
  });

  it("wait --timeout 1 on a slow run exits 5 with status running and the same wait in next, and the run goes on", async () => {
    const { paths, projectDir } = testHome({ slow: SLOW });
    const held = heldRunner();
    const workers = inProcess({ inner: held.runner });
    const { runId } = await started(paths, projectDir, workers, ["slow"]);
    // A wait that misses its timeout would wait forever, so the step ends by itself after 10 seconds.
    const guard = setTimeout(held.release, 10_000);
    try {
      const began = Date.now();
      const waited = await sous(paths, ["wait", runId, "--timeout", "1", "--json"]);
      assert.ok(Date.now() - began < 10_000, `the wait took ${Date.now() - began} ms`);
      assert.equal(waited.code, 5, waited.out);
      const wait = replyIn(waited);
      assert.equal(wait.status, "running");
      const again = calls(wait).find((call) => call.startsWith(`sous wait ${runId} `));
      assert.ok(again, JSON.stringify(wait.next));
      assert.match(again!, /--timeout 1\b/);
      assert.match(again!, /--json\b/);

      const text = await sous(paths, ["wait", runId, "--timeout", "1"]);
      assert.equal(text.code, 5, text.out);
    } finally {
      clearTimeout(guard);
      held.release();
    }
    assert.equal((await workers.ended(runId))?.status, "completed", "the timeout ends the wait, not the run");
  });
});

describe("piece 4: sous show", () => {
  it("show --json is short: no state key, no record, and the steps by label", async () => {
    const { paths, projectDir } = testHome({ hello: fixture("hello") });
    const workers = inProcess({ inner: heldRunner().runner });
    const { runId } = await started(paths, projectDir, workers, ["hello", "--name", "Ada"]);
    assert.equal((await workers.ended(runId))?.status, "completed");

    const shown = await sous(paths, ["show", runId, "--json"]);
    assert.equal(shown.code, 0, shown.out);
    const show = replyIn(shown);
    assert.equal("state" in show, false, "the short view has no state key");
    assert.deepEqual(Object.keys(show).filter((key) => !SHORT_SHOW.has(key)), [], `keys past the short view: ${Object.keys(show).join(", ")}`);
    assert.equal(show.runId, runId);
    assert.equal(show.workflow, "hello");
    assert.equal(show.status, "completed");
    assert.equal(typeof show.word, "string");
    assert.equal(typeof show.startedAt, "string");
    assert.deepEqual(show.questions, []);
    const steps = show.steps as Array<{ label?: string; status?: string }>;
    assert.ok(steps.some((step) => step.label === "greet" && typeof step.status === "string"), shown.out);
  });

  it("show --full --json keeps the short view and puts today's detail under state", async () => {
    const { paths, projectDir } = testHome({ hello: fixture("hello") });
    const workers = inProcess({ inner: heldRunner().runner });
    const { runId } = await started(paths, projectDir, workers, ["hello", "--name", "Ada"]);
    assert.equal((await workers.ended(runId))?.status, "completed");

    const shown = await sous(paths, ["show", runId, "--full", "--json"]);
    assert.equal(shown.code, 0, shown.out);
    const show = replyIn(shown);
    assert.equal(show.runId, runId);
    assert.equal(show.workflow, "hello");
    const state = show.state as { status?: string; agents?: Array<{ label: string }> } | undefined;
    assert.ok(state && typeof state === "object", "the full view has a state key");
    assert.equal(state!.status, "completed");
    assert.ok(state!.agents?.some((agent) => agent.label === "greet"), shown.out);
  });

  it("show --json cuts the steps at 30 with a note naming --full, and stays under 8,000 characters", async () => {
    const { paths, projectDir } = testHome();
    const at = new Date(Date.now() - 60_000).toISOString();
    plantRecord(paths, projectDir, "run-long", at);
    const agents = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, label: `step ${i + 1}`, prompt: `Do part ${i + 1}. `.repeat(40), status: "done", startedAt: at, endedAt: at, tokens: 100 }));
    plantState(paths, { runId: "run-long", workflowName: "build", script: "return 1", status: "completed", result: "done", phases: [], agents: agents as never, logs: [], startedAt: at, updatedAt: at, completedAt: at });

    const shown = await sous(paths, ["show", "run-long", "--json"]);
    assert.equal(shown.code, 0, shown.out);
    assert.ok(shown.out.length < 8000, `the reply is ${shown.out.length} characters`);
    const show = replyIn(shown);
    assert.equal((show.steps as unknown[]).length, 30);
    assert.ok(show.notes.some((note) => note.includes("--full")), JSON.stringify(show.notes));
  });
});

describe("piece 4: sous status", () => {
  it("sous status --json names the question under needsYou with the answer call, the limit under waiting and the finished run", async () => {
    const { paths, questionId } = plantStatus();
    const printed = await sous(paths, ["status", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    const status = replyIn(printed);
    const needsYou = status.needsYou as Array<{ runId: string; what: string; question?: { id: string; prompt: string; answeredBy: string }; call: string }>;
    const asking = needsYou.find((entry) => entry.runId === "run-asking");
    assert.ok(asking, printed.out);
    assert.equal(asking!.what, "asks");
    assert.deepEqual(asking!.question, { id: questionId, prompt: "Which color?", answeredBy: "people" });
    assert.ok(asking!.call.startsWith(`sous answer ${questionId} `), asking!.call);
    const waiting = status.waiting as Array<{ runId: string; what: string; resumesAt?: string }>;
    assert.deepEqual(waiting.map((run) => [run.runId, run.what, typeof run.resumesAt]), [["run-limit", "paused: limit", "string"]]);
    assert.deepEqual((status.finished as Array<{ runId: string }>).map((run) => run.runId), ["run-done"]);
    assert.ok(Array.isArray(status.running));
    assert.deepEqual(status.service, { running: false });
  });

  it("sous status in text names the question, its answer call and the waiting run, and exits 0", async () => {
    const { paths, questionId } = plantStatus();
    const printed = await sous(paths, ["status"]);
    assert.equal(printed.code, 0, printed.out);
    assert.equal(printed.out.trimStart().startsWith("{"), false, "text, not JSON");
    assert.match(printed.out, /run-asking/);
    assert.match(printed.out, /Which color\?/);
    assert.ok(printed.out.includes(`sous answer ${questionId} `), printed.out);
    assert.match(printed.out, /run-limit/);
  });

  it("sous status on an empty home exits 0, in text and in --json with empty lists", async () => {
    const { paths } = testHome();
    const text = await sous(paths, ["status"]);
    assert.equal(text.code, 0, text.out);
    assert.notEqual(text.out.trim(), "", "the text says something, even with nothing to show");
    const printed = await sous(paths, ["status", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    const status = replyIn(printed);
    for (const list of ["needsYou", "running", "waiting", "finished"]) assert.deepEqual(status[list], [], list);
    assert.deepEqual(status.service, { running: false });
  });

  it("sous status --since 3d shows a run that finished 30 hours ago, which the default leaves out with a note naming --since", async () => {
    const { paths, projectDir } = testHome();
    const at = new Date(Date.now() - 30 * 3600_000).toISOString();
    plantRecord(paths, projectDir, "run-old", at);
    plantState(paths, { runId: "run-old", workflowName: "build", script: "return 1", status: "completed", result: "done", phases: [], agents: [], logs: [], startedAt: at, updatedAt: at, completedAt: at });

    const today = replyIn(await sous(paths, ["status", "--json"]));
    assert.deepEqual(today.finished, []);
    assert.ok(today.notes.some((note) => note.includes("--since")), JSON.stringify(today.notes));
    const longer = replyIn(await sous(paths, ["status", "--since", "3d", "--json"]));
    assert.deepEqual((longer.finished as Array<{ runId: string }>).map((run) => run.runId), ["run-old"]);
  });

  it("sous status --json is the call a no_such_run refusal gives, and that call works", async () => {
    const { paths } = plantStatus();
    const shown = await sous(paths, ["show", "nosuch", "--json"]);
    assert.equal(shown.code, 65, shown.out);
    const call = (JSON.parse(shown.out) as { error: { call: string } }).error.call;
    assert.equal(call, "sous status --json");
    const [program, ...argv] = call.split(" ");
    assert.equal(program, "sous");
    const printed = await sous(paths, argv);
    assert.equal(printed.code, 0, printed.out);
    assert.ok(Array.isArray(replyIn(printed).needsYou));
  });

  it("sous status writes no file", async () => {
    const { paths, root } = plantStatus();
    const before = walk(root);
    for (const argv of [["status"], ["status", "--json"], ["status", "--since", "3d", "--json"]]) await sous(paths, argv);
    assert.deepEqual(changes(before, walk(root)), []);
  });
});

describe("piece 4: review fixes", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const base = { workflowName: "build", script: "return 1", phases: [], agents: [], logs: [] };

  it("show --full --json gives the questions as the inbox keeps them", async () => {
    const { paths, questionId } = plantStatus();
    const shown = await sous(paths, ["show", "run-asking", "--full", "--json"]);
    assert.equal(shown.code, 0, shown.out);
    const questions = replyIn(shown).questions as Array<Record<string, unknown>>;
    assert.equal(questions.length, 1, shown.out);
    assert.deepEqual(
      { id: questions[0]!.id, runId: questions[0]!.runId, scope: questions[0]!.scope, callIndex: questions[0]!.callIndex, hash: questions[0]!.hash, workflow: questions[0]!.workflow, askedAt: typeof questions[0]!.askedAt },
      { id: questionId, runId: "run-asking", scope: "run-asking", callIndex: 0, hash: "h0", workflow: "build", askedAt: "string" },
    );
    const short = replyIn(await sous(paths, ["show", "run-asking", "--json"])).questions as Array<{ askedAt?: string }>;
    assert.equal(typeof short[0]?.askedAt, "string", "the short view has askedAt too");
  });

  it("wait --json on a stopped run gives status stopped, exit 3 and the rerun call", async () => {
    const { paths, projectDir } = testHome();
    plantRecord(paths, projectDir, "run-stopped", minutesAgo(10), { pid: deadPid() });
    plantState(paths, { ...base, runId: "run-stopped", status: "aborted", reason: "stopped by the person", startedAt: minutesAgo(10), updatedAt: minutesAgo(5) });
    const printed = await sous(paths, ["wait", "run-stopped", "--json"]);
    assert.equal(printed.code, 3, printed.out);
    const wait = replyIn(printed);
    assert.equal(wait.status, "stopped");
    assert.ok(calls(wait).includes("sous rerun run-stopped --json"), JSON.stringify(wait.next));
  });

  it("wait --json on a run whose worker died gives status interrupted, exit 2 and the resume call", async () => {
    const { paths, projectDir } = testHome();
    plantRecord(paths, projectDir, "run-dead", minutesAgo(10), { pid: deadPid() });
    plantState(paths, { ...base, runId: "run-dead", status: "running", startedAt: minutesAgo(10), updatedAt: minutesAgo(5) });
    const printed = await sous(paths, ["wait", "run-dead", "--json"]);
    assert.equal(printed.code, 2, printed.out);
    const wait = replyIn(printed);
    assert.equal(wait.status, "interrupted");
    assert.ok(calls(wait).includes("sous resume run-dead --json"), JSON.stringify(wait.next));
  });

  it("a run paused at a usage limit suggests wait and a note with the resume time, not resume", async () => {
    const { paths } = plantStatus();
    const show = replyIn(await sous(paths, ["show", "run-limit", "--json"]));
    assert.equal(typeof show.resumesAt, "string");
    assert.ok(calls(show).includes("sous wait run-limit --json"), JSON.stringify(show.next));
    assert.ok(!calls(show).some((call) => call.startsWith("sous resume")), JSON.stringify(show.next));
    assert.ok(show.notes.some((note) => note.includes(show.resumesAt as string)), JSON.stringify(show.notes));
  });

  it("a failed step's label goes in single quotes, and a run reason that is not the step's error names no step", async () => {
    const { paths, projectDir } = testHome();
    const agent = { id: 1, label: "it's done", prompt: "p", status: "error", error: "boom", startedAt: minutesAgo(9), endedAt: minutesAgo(8) };
    plantRecord(paths, projectDir, "run-step", minutesAgo(10));
    plantState(paths, { ...base, runId: "run-step", status: "failed", reason: "boom", agents: [agent] as never, startedAt: minutesAgo(10), updatedAt: minutesAgo(8), completedAt: minutesAgo(8) });
    const step = replyIn(await sous(paths, ["show", "run-step", "--json"]));
    assert.deepEqual(step.failure, { step: "it's done", message: "boom" });
    assert.ok(calls(step).includes(`sous step run-step 'it'\\''s done' --json`), JSON.stringify(step.next));
    assert.equal(step.seconds, 120, "an ended run with no duration counts to its last change");

    plantRecord(paths, projectDir, "run-script", minutesAgo(10));
    plantState(paths, { ...base, runId: "run-script", status: "failed", reason: "the script threw: x is not defined", agents: [agent] as never, startedAt: minutesAgo(10), updatedAt: minutesAgo(8), completedAt: minutesAgo(8) });
    const script = replyIn(await sous(paths, ["show", "run-script", "--json"]));
    assert.deepEqual(script.failure, { message: "the script threw: x is not defined" });
    assert.ok(!calls(script).some((call) => call.startsWith("sous step")), JSON.stringify(script.next));
  });

  it("a breakpoint gives approve and send-back, and every answer call has --json", async () => {
    const { paths, projectDir } = testHome();
    plantRecord(paths, projectDir, "run-break", minutesAgo(5), { pid: process.pid });
    plantState(paths, { ...base, runId: "run-break", status: "running", startedAt: minutesAgo(5), updatedAt: minutesAgo(4) }, "");
    const id = "run-break--0";
    writeJson(join(paths.inbox, `${id}.json`), { id, runId: "run-break", scope: "run-break", callIndex: 0, hash: "h0", workflow: "build", prompt: `Ship it?\n${"More detail. ".repeat(20)}`, kind: "confirm", breakpoint: true, askedAt: minutesAgo(4) });
    for (const argv of [["status", "--json"], ["show", "run-break", "--json"]]) {
      const reply = replyIn(await sous(paths, argv));
      assert.ok(calls(reply).includes(`sous approve ${id} --json`), JSON.stringify(reply.next));
      assert.ok(calls(reply).includes(`sous send-back ${id} "<note>" --json`), JSON.stringify(reply.next));
      for (const next of reply.next.filter((n) => /^sous (answer|approve|send-back) /.test(n.call))) assert.match(next.call, / --json$/);
      const approve = reply.next.find((n) => n.call.startsWith("sous approve"))!;
      assert.ok(approve.does.includes("Ship it?") && !approve.does.includes("More detail") && approve.does.length < 100, approve.does);
    }
  });

  it("show --json keeps the last 30 steps and says so", async () => {
    const { paths, projectDir } = testHome();
    const at = minutesAgo(1);
    plantRecord(paths, projectDir, "run-long", at);
    const agents = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, label: `step ${i + 1}`, prompt: "p", status: "done", startedAt: at, endedAt: at, usage: { total: 7 } }));
    plantState(paths, { ...base, runId: "run-long", status: "completed", result: "done", agents: agents as never, startedAt: at, updatedAt: at, completedAt: at });
    const show = replyIn(await sous(paths, ["show", "run-long", "--json"]));
    const steps = show.steps as Array<{ label: string; tokens?: number }>;
    assert.deepEqual([steps[0]!.label, steps.at(-1)!.label], ["step 11", "step 40"]);
    assert.equal(steps[0]!.tokens, 7, "a step's tokens come from its usage when it has no tokens");
    assert.ok(show.notes.some((note) => note.includes("last 30") && note.includes("--full")), JSON.stringify(show.notes));
  });

  it("sous status --line prints nothing on an empty home, and one line naming sous status when a run asks", async () => {
    const empty = await sous(testHome().paths, ["status", "--line"]);
    assert.equal(empty.code, 0, empty.out);
    assert.equal(empty.out.trim(), "");
    const { paths } = plantStatus();
    const printed = await sous(paths, ["status", "--line"]);
    assert.equal(printed.code, 0, printed.out);
    const lines = printed.out.trim().split("\n");
    assert.equal(lines.length, 1, printed.out);
    assert.match(lines[0]!, /sous status/);
  });

  it("sous status cuts a list at 20 with a note naming --all, and --all shows every run", async () => {
    const { paths, projectDir } = testHome();
    for (let i = 0; i < 25; i++) {
      const at = minutesAgo(30 + i);
      plantRecord(paths, projectDir, `run-${i}`, at);
      plantState(paths, { ...base, runId: `run-${i}`, status: "completed", result: "done", startedAt: at, updatedAt: at, completedAt: at });
    }
    const cut = replyIn(await sous(paths, ["status", "--json"]));
    assert.equal((cut.finished as unknown[]).length, 20);
    assert.ok(cut.notes.some((note) => note.includes("--all")), JSON.stringify(cut.notes));
    const all = replyIn(await sous(paths, ["status", "--all", "--json"]));
    assert.equal((all.finished as unknown[]).length, 25);
    assert.ok(!all.notes.some((note) => note.includes("--all")), JSON.stringify(all.notes));
  });

  it("the earlier note suggests a window longer than the --since given", async () => {
    const { paths, projectDir } = testHome();
    const at = new Date(Date.now() - 5 * 24 * 3600_000).toISOString();
    plantRecord(paths, projectDir, "run-old", at);
    plantState(paths, { ...base, runId: "run-old", status: "completed", result: "done", startedAt: at, updatedAt: at, completedAt: at });
    const status = replyIn(await sous(paths, ["status", "--since", "3d", "--json"]));
    assert.ok(status.notes.some((note) => note.includes("--since 6d")), JSON.stringify(status.notes));
  });
});

// Piece 5: sous step and sous log --after. The worker saves each step's activity, sous step shows
// one step with its activity, and log --json --after pages through the run's events in a small
// vocabulary. The runs go through workers in this process, so no program runs.

interface LogPage {
  runId: string;
  events: Array<{ seq: number; kind: string; [field: string]: unknown }>;
  after: number;
  more: boolean;
}

/** The JSON a log --json call printed, as one page. */
function logPage(printed: { code: number; out: string }): LogPage {
  assert.equal(printed.code, 0, printed.out);
  const page = replyIn(printed) as unknown as LogPage;
  assert.ok(Array.isArray(page.events), `events is an array: ${printed.out}`);
  assert.equal(typeof page.after, "number", printed.out);
  assert.equal(typeof page.more, "boolean", printed.out);
  return page;
}

/** The error JSON a refusal printed. */
function refusalIn(printed: { code: number; out: string }): { code: string; message: string; change: string; call: string | null } {
  const parsed = JSON.parse(printed.out) as { error: { code: string; message: string; change: string; call: string | null } };
  assert.ok(parsed.error, printed.out);
  return parsed.error;
}

/** Poll an async read until it holds, or 20 seconds pass. */
async function until(ready: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await ready()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** The slow run's one step shows as running in sous show. */
async function slowRuns(paths: HomePaths, runId: string): Promise<boolean> {
  const shown = await sous(paths, ["show", runId, "--json"]);
  if (shown.code !== 0) return false;
  const steps = (JSON.parse(shown.out) as { steps?: Array<{ label?: string; status?: string }> }).steps ?? [];
  return steps.some((step) => step.label === "slow" && step.status === "running");
}

describe("piece 5: sous step", () => {
  it("step boom --json on the fails run holds exit 3 in its failure, and next offers resume and wait", async () => {
    const { paths, projectDir } = testHome({ fails: fixture("fails") });
    const workers = inProcess({ inner: heldRunner().runner });
    const { runId } = await started(paths, projectDir, workers, ["fails"]);
    assert.equal((await workers.ended(runId))?.status, "paused");
    const printed = await sous(paths, ["step", runId, "boom", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    const step = replyIn(printed);
    assert.equal(step.runId, runId);
    assert.equal(step.step, "boom");
    assert.equal(step.kind, "exec");
    assert.deepEqual([step.call, step.calls], [1, 1]);
    assert.equal(step.command, "echo 'disk check failed' >&2; exit 3");
    const failure = typeof step.failure === "string" ? step.failure : JSON.stringify(step.failure ?? "");
    assert.match(failure, /code 3/, printed.out);
    assert.match(failure, /disk check failed/, printed.out);
    const activity = step.activity as Array<{ kind: string; text: string }>;
    assert.deepEqual(
      activity.map((line) => line.kind),
      ["command", "output"],
    );
    assert.ok(calls(step).includes(`sous resume ${runId} --json`), JSON.stringify(step.next));
    assert.ok(calls(step).some((call) => call.startsWith(`sous wait ${runId}`)), JSON.stringify(step.next));
    assert.ok(!calls(step).some((call) => call.startsWith("sous tell ")), "a failed step offers no tell");
  });

  it("step on a running step offers tell, stop and wait in next", async () => {
    const { paths, projectDir } = testHome({ slow: SLOW });
    const held = heldRunner();
    const workers = inProcess({ inner: held.runner });
    const { runId } = await started(paths, projectDir, workers, ["slow"]);
    const guard = setTimeout(held.release, 20_000);
    try {
      await until(() => slowRuns(paths, runId), "the slow step to run");
      const printed = await sous(paths, ["step", runId, "slow", "--json"]);
      assert.equal(printed.code, 0, printed.out);
      const step = replyIn(printed);
      assert.equal(step.kind, "agent");
      assert.equal(step.status, "running");
      assert.match(String(step.prompt ?? ""), /wait here/);
      // The tell call needs piece 12. Here it only has to be in the shape the design gives.
      assert.ok(calls(step).some((call) => new RegExp(`^sous tell ${runId} --step slow\\b`).test(call)), JSON.stringify(step.next));
      assert.ok(calls(step).some((call) => new RegExp(`^sous stop ${runId} --step slow\\b`).test(call)), JSON.stringify(step.next));
      assert.ok(calls(step).some((call) => call.startsWith(`sous wait ${runId}`)), JSON.stringify(step.next));
      assert.ok(!calls(step).some((call) => call.startsWith("sous resume ")), "a running step offers no resume");
    } finally {
      clearTimeout(guard);
      held.release();
    }
    assert.equal((await workers.ended(runId))?.status, "completed");
  });

  it("step with a label the run does not have exits 65 with no_such_step, a change and a call, and a missing run exits 65 too", async () => {
    const { paths, projectDir } = testHome({ fails: fixture("fails") });
    const workers = inProcess({ inner: heldRunner().runner });
    const { runId } = await started(paths, projectDir, workers, ["fails"]);
    await workers.ended(runId);
    const missing = await sous(paths, ["step", runId, "nosuch", "--json"]);
    assert.equal(missing.code, 65, missing.out);
    const error = refusalIn(missing);
    assert.equal(error.code, "no_such_step");
    assert.match(error.message, /nosuch/);
    assert.ok(error.change.length > 0, missing.out);
    assert.ok(error.call?.startsWith(`sous show ${runId}`), missing.out);

    const noRun = await sous(paths, ["step", "nosuch", "boom", "--json"]);
    assert.equal(noRun.code, 65, noRun.out);
    assert.equal(refusalIn(noRun).code, "no_such_run");
  });

  it("step without --json prints lines a person reads: the step, its failure and the next calls", async () => {
    const { paths, projectDir } = testHome({ fails: fixture("fails") });
    const workers = inProcess({ inner: heldRunner().runner });
    const { runId } = await started(paths, projectDir, workers, ["fails"]);
    await workers.ended(runId);
    const printed = await sous(paths, ["step", runId, "boom"]);
    assert.equal(printed.code, 0, printed.out);
    assert.throws(() => JSON.parse(printed.out), "the text form is not JSON");
    assert.match(printed.out, /boom/);
    assert.match(printed.out, /disk check failed/);
    assert.match(printed.out, /code 3/);
    assert.ok(printed.out.includes(`next: sous resume ${runId} --json`), printed.out);
  });

  it("step --tail 1 gives one activity entry and a note naming --tail", async () => {
    const { paths, projectDir } = testHome({ fails: fixture("fails") });
    const workers = inProcess({ inner: heldRunner().runner });
    const { runId } = await started(paths, projectDir, workers, ["fails"]);
    await workers.ended(runId);
    const step = replyIn(await sous(paths, ["step", runId, "boom", "--tail", "1", "--json"]));
    const activity = step.activity as Array<{ kind: string }>;
    assert.deepEqual(
      activity.map((line) => line.kind),
      ["output"],
    );
    assert.ok(step.notes.some((note) => note.includes("--tail")), JSON.stringify(step.notes));
  });
});

describe("piece 5: sous log --json --after", () => {
  it("log --json is one object with events and after, and after that seq it gives no event", async () => {
    const { paths, projectDir } = testHome({ fails: fixture("fails") });
    const workers = inProcess({ inner: heldRunner().runner });
    const { runId } = await started(paths, projectDir, workers, ["fails"]);
    await workers.ended(runId);
    const page = logPage(await sous(paths, ["log", runId, "--json", "--after", "0"]));
    assert.equal(page.runId, runId);
    assert.equal(page.more, false);
    const vocabulary = ["step-start", "step-end", "asks", "answered", "paused", "resumed", "ended", "tell", "note"];
    for (const event of page.events) assert.ok(vocabulary.includes(event.kind), `${event.kind} is not in the vocabulary`);
    const kinds = page.events.map((event) => event.kind);
    assert.ok(kinds.includes("step-start") && kinds.includes("step-end") && kinds.includes("paused"), kinds.join(" "));
    assert.equal(page.after, page.events.at(-1)?.seq);
    // Decision 6: log --json without --after is the same one object, from the start.
    assert.deepEqual(logPage(await sous(paths, ["log", runId, "--json"])).events, page.events);
    const next = logPage(await sous(paths, ["log", runId, "--json", "--after", String(page.after)]));
    assert.deepEqual(next.events, []);
    assert.equal(next.after, page.after);
  });

  it("a second call with the returned after gives only the newer events", async () => {
    const { paths, projectDir } = testHome({ slow: SLOW });
    const held = heldRunner();
    const workers = inProcess({ inner: held.runner });
    const { runId } = await started(paths, projectDir, workers, ["slow"]);
    const guard = setTimeout(held.release, 20_000);
    let first: LogPage;
    try {
      await until(() => slowRuns(paths, runId), "the slow step to run");
      first = logPage(await sous(paths, ["log", runId, "--json", "--after", "0"]));
      assert.ok(first.events.some((event) => event.kind === "step-start"), JSON.stringify(first.events));
      assert.ok(!first.events.some((event) => event.kind === "ended"), "the run has not ended yet");
    } finally {
      clearTimeout(guard);
      held.release();
    }
    assert.equal((await workers.ended(runId))?.status, "completed");
    const second = logPage(await sous(paths, ["log", runId, "--json", "--after", String(first.after)]));
    assert.ok(second.events.length > 0);
    assert.ok(second.events.every((event) => event.seq > first.after), JSON.stringify(second.events));
    const kinds = second.events.map((event) => event.kind);
    assert.ok(kinds.includes("step-end") && kinds.includes("ended"), kinds.join(" "));
    assert.ok(!kinds.includes("step-start"), "the step's start came in the first page");
  });

  it("pages a long run's log under 8,000 characters each, and the pages cover every step once", async () => {
    const many = `export const meta = { name: 'many', description: 'forty steps', place: 'none' }
for (let i = 0; i < 40; i++) await agent('Do part ' + i + '. ' + 'Take care. '.repeat(20), { label: 'part ' + i })
return 1`;
    const { paths, projectDir } = testHome({ many });
    const workers = inProcess({ inner: { run: async () => "ok" } as unknown as InnerRunner });
    const { runId } = await started(paths, projectDir, workers, ["many"]);
    assert.equal((await workers.ended(runId))?.status, "completed");
    const seen: LogPage["events"] = [];
    let after = 0;
    for (let page = 0; ; page++) {
      assert.ok(page < 100, "the pages end");
      const printed = await sous(paths, ["log", runId, "--json", "--after", String(after)]);
      assert.ok(printed.out.length < 8000, `a page is ${printed.out.length} characters`);
      const got = logPage(printed);
      seen.push(...got.events);
      if (!got.more) break;
      assert.ok(got.after > after, "after moves on");
      after = got.after;
    }
    const seqs = seen.map((event) => event.seq);
    assert.equal(new Set(seqs).size, seqs.length, "no event comes twice");
    const starts = seen.filter((event) => event.kind === "step-start");
    assert.equal(starts.length, 40);
    for (let i = 0; i < 40; i++) assert.ok(starts.some((event) => JSON.stringify(event).includes(`"part ${i}"`)), `part ${i} starts`);
  });
});

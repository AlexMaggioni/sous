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

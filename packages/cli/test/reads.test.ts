import assert from "node:assert/strict";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { ensureHome, homePaths, type HomePaths } from "@sous/engine";
import { readState, tick, workflowProjectPaths } from "@sous/engine/testing";
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

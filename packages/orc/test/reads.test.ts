import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { ensureHome, homePaths, type HomePaths } from "@orchestrator/engine";
// orc does not import these, so the engine entry does not export them. The tests load the
// engine's built modules by path.
import { workflowProjectPaths } from "../../engine/dist/runs/persistence/project-paths.js";
import { tick } from "../../engine/dist/runs/service.js";
import { readState } from "../../engine/dist/runs/store.js";
import { main } from "../src/cli.js";

// orc's reads write nothing. The home below is planted with raw writes, the way the worker and
// the engine leave it, so the test also shows that orc reads today's files.

const harnessHome = mkdtempSync(join(tmpdir(), "orc-reads-harness-"));
process.env.CLAUDE_CONFIG_DIR = join(harnessHome, ".claude");
process.env.CODEX_HOME = join(harnessHome, ".codex");
process.env.XDG_CONFIG_HOME = join(harnessHome, ".config");
delete process.env.ORC_RUN_ID;
delete process.env.CLAUDECODE;

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** A pid that no process has now: a child that already ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

interface Planted {
  root: string;
  paths: HomePaths;
  ids: { dead: string; limit: string; done: string; asking: string; live: string };
}

function plant(): Planted {
  const root = mkdtempSync(join(tmpdir(), "orc-reads-"));
  const paths = ensureHome(homePaths(join(root, "home")));
  writeJson(paths.config, { notify: false, defaultPlace: "folder" });
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".orchestrator", "workflows"), { recursive: true });
  // The engine's folder for orc's runs. No project.json: the engine writes it on a first save.
  const engine = workflowProjectPaths(paths.home, { persistenceRoot: paths.runs }).runsDir;
  mkdirSync(engine, { recursive: true });

  const now = new Date();
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const ids = { dead: "run-dead", limit: "run-limit", done: "run-done", asking: "run-asking", live: "run-live" };
  const record = (runId: string, minutesAgo: number, extra: Record<string, unknown> = {}) =>
    writeJson(join(paths.records, `${runId}.json`), {
      runId,
      workflow: "build",
      file: join(projectDir, ".orchestrator", "workflows", "build.js"),
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

async function orc(paths: HomePaths, argv: string[]): Promise<{ code: number; out: string }> {
  const before = process.env.ORC_HOME;
  process.env.ORC_HOME = paths.home;
  const printed: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => (printed.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv), out: printed.join("") };
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
    if (before === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = before;
  }
}

describe("orc's reads", () => {
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
      ["account", "list"],
      ["account", "list", "--json"],
    ];
    const printed = new Map<string, { code: number; out: string }>();
    for (const argv of commands) printed.set(argv.join(" "), await orc(paths, argv));
    assert.deepEqual(changes(before, walk(root)), []);

    // The reads still say what they said when they wrote: the dead run reads as interrupted.
    for (const [command, { code, out }] of printed) {
      const expected = command === `wait ${ids.dead}` ? 2 : 0;
      assert.equal(code, expected, `orc ${command} printed:\n${out}`);
    }
    assert.match(printed.get("list")!.out, new RegExp(`${ids.dead}\\s+build\\s+interrupted`));
    assert.match(printed.get(`show ${ids.dead}`)!.out, /status {4}interrupted/);
  });

  it("let orc stop on a paused run change only that run's files", async () => {
    const { root, paths, ids } = plant();
    // A stop saves, and the engine's first save writes project.json. Plant it, as a home where
    // the engine saved before has it.
    const engine = workflowProjectPaths(paths.home, { persistenceRoot: paths.runs });
    writeFileSync(join(engine.rootDir, "project.json"), `${JSON.stringify({ projectDir: paths.home })}\n`);
    const before = walk(root);
    const { code, out } = await orc(paths, ["stop", ids.limit]);
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
    tick(paths, "cli.js", { log: (line) => lines.push(line), spawn: (runId) => spawned.push(runId), notify: () => {} });
    assert.deepEqual(changes(before, walk(root, skip)), []);
    assert.deepEqual(spawned, []);
    assert.ok(lines.some((line) => line.includes(`run ${ids.dead} was cut off`)), lines.join("\n"));
  });
});

#!/usr/bin/env node
// Captures what today's sous prints, so a later change can show it kept the same behavior.
// sous runs with SOUS_HOME in a fresh temp folder, the fake claude and codex from test/fakes as
// its programs, and a temp git copy of examples/textkit with the scenario workflows added.
// Each command and each scenario becomes one normalized file in the output folder.
//
//   node test/baseline/capture.mjs <out dir> [--only name,name] [--keep] [--debug]
//
// --only    capture only the files whose name starts with one of these
// --keep    keep the temp folder and print where it is
// --debug   the fakes write what they read and write to fake/debug.log in each world

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const SOUS = join(repo, "packages", "cli", "dist", "cli.js");
const FAKES = join(repo, "test", "fakes");
const TEXTKIT = join(repo, "examples", "textkit");

// Every command sous knows. `sous <command> --help` prints the same text as `sous --help` today.
const COMMANDS = [
  "run", "wait", "list", "show", "log", "inbox", "answer", "approve", "send-back", "pause", "resume", "stop", "rerun",
  "workflows", "check", "schedule", "daemon", "gc", "discard", "prune", "account", "doctor",
];

// 2100-01-01T12:00:00Z, a Friday. Far enough that the limit is always in the future.
const RESETS_AT = 4102488000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── the temp folder ──

function setupRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sous-baseline-")));
  for (const dir of ["home", "bin", "tmp"]) mkdirSync(join(root, dir));
  // A PATH with node and the system folders only, so no real claude or codex is found.
  symlinkSync(process.execPath, join(root, "bin", "node"));
  return root;
}

function worldEnv(root, sousHome, fakeDir, debug) {
  const date = "2024-01-01T00:00:00Z";
  return {
    HOME: join(root, "home"),
    PATH: `${join(root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: join(root, "tmp"),
    TZ: "UTC",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    NO_COLOR: "1",
    SOUS_HOME: sousHome,
    CLAUDE_CODE_EXECUTABLE: join(FAKES, "claude"),
    CODEX_PATH: join(FAKES, "codex"),
    FAKE_LOG: join(fakeDir, "requests.jsonl"),
    FAKE_RULES: join(fakeDir, "rules.json"),
    ...(debug ? { FAKE_DEBUG: join(fakeDir, "debug.log") } : {}),
    GIT_AUTHOR_NAME: "Baseline",
    GIT_AUTHOR_EMAIL: "baseline@example.invalid",
    GIT_COMMITTER_NAME: "Baseline",
    GIT_COMMITTER_EMAIL: "baseline@example.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** One sous home, one project copy and one fake log, for a group of commands or a scenario. */
function makeWorld(root, name, { config = { notify: false }, rules = [], debug = false } = {}) {
  const base = join(root, name);
  const sousHome = join(base, "sous-home");
  const project = join(base, "project");
  const fakeDir = join(base, "fake");
  mkdirSync(fakeDir, { recursive: true });
  if (config) {
    mkdirSync(sousHome, { recursive: true });
    writeFileSync(join(sousHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  writeFileSync(join(fakeDir, "rules.json"), `${JSON.stringify(rules, null, 2)}\n`);
  const env = worldEnv(root, sousHome, fakeDir, debug);
  cpSync(TEXTKIT, project, { recursive: true });
  cpSync(join(here, "project"), project, { recursive: true });
  cpSync(join(here, "workflows"), join(project, ".sous", "workflows"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: project, env, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "textkit");
  return { name, root, sousHome, project, fakeDir, env, runIds: [], transcript: [] };
}

// ── running sous ──

function sous(world, args, { cwd = world.project, timeoutMs = 90_000 } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SOUS, ...args], { cwd, env: world.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ args, code: code ?? `killed by ${signal}`, stdout, stderr });
    });
  });
}

const quote = (arg) => (/^[\w./:=@-]+$/.test(arg) ? arg : JSON.stringify(arg));

function transcriptEntry(result) {
  const parts = [`$ sous ${result.args.map(quote).join(" ")}`, `exit ${result.code}`];
  if (result.stdout) parts.push(result.stdout.replace(/\n$/, ""));
  if (result.stderr) parts.push(`stderr:\n${result.stderr.replace(/\n$/, "")}`);
  return parts.join("\n");
}

/** Run sous and add the command, its exit code and its output to the world's transcript. */
async function step(world, args, options) {
  const result = await sous(world, args, options);
  world.transcript.push(transcriptEntry(result));
  return result;
}

async function start(world, workflow, extra = []) {
  const result = await sous(world, ["run", workflow, "--json", ...extra]);
  let runId;
  try {
    runId = JSON.parse(result.stdout).runId;
  } catch {
    throw new Error(`sous run ${workflow} printed no run id:\n${result.stdout}${result.stderr}`);
  }
  world.runIds.push(runId);
  // The run reply's lastRuns has the seconds of earlier runs, which change with each capture.
  world.transcript.push(transcriptEntry({ ...result, stdout: `${JSON.stringify(scrubJson(JSON.parse(result.stdout)), null, 2)}\n` }));
  return runId;
}

const wait = (world, runId) => step(world, ["wait", runId, "--json"]);

const fakeLines = (world) => {
  const file = world.env.FAKE_LOG;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

async function until(what, check, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const logged = (world, pattern) => until(`a request matching ${pattern}`, () => fakeLines(world).some((line) => pattern.test(line.prompt ?? "")));

const workerLogged = (world, runId, pattern) =>
  until(`the worker log to show ${pattern}`, () => {
    const file = join(world.sousHome, "logs", `${runId}.log`);
    return existsSync(file) && pattern.test(readFileSync(file, "utf8"));
  });

async function stepDone(world, runId, label) {
  await until(`step ${label} to end`, async () => {
    const shown = await sous(world, ["show", runId, "--json"]);
    const steps = JSON.parse(shown.stdout).steps ?? [];
    return steps.some((step) => step.label === label && step.status === "done");
  });
}

const gate = (world, name) => writeFileSync(join(world.fakeDir, name), "");

/** The world's runs as show and show --full --json print them, and the requests the fakes logged. */
async function snapshot(world) {
  const parts = [];
  for (const runId of world.runIds) {
    parts.push(transcriptEntry(await sous(world, ["show", runId])));
    const json = await sous(world, ["show", runId, "--full", "--json"]);
    try {
      json.stdout = `${JSON.stringify(scrubJson(JSON.parse(json.stdout)), null, 2)}\n`;
    } catch {
      // Kept as printed.
    }
    parts.push(transcriptEntry(json));
  }
  return parts;
}

/** Stop any worker a scenario left running. Only a process that is this run's sous worker. */
function cleanup(world) {
  const records = join(world.sousHome, "records");
  if (!existsSync(records)) return;
  for (const file of readdirSync(records)) {
    try {
      const record = JSON.parse(readFileSync(join(records, file), "utf8"));
      if (!record.pid) continue;
      const command = execFileSync("ps", ["-p", String(record.pid), "-o", "command="], { encoding: "utf8" });
      if (command.includes("_worker") && command.includes(record.runId)) process.kill(record.pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
}

// ── normalizing ──

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const TIME_KEY = /(?:At|Ms|^duration\w*|^pid|^heartbeat\w*|^lastSeen\w*|^timestamp|^seconds|^minutes)$/;
// Values that change with each run or each machine: a random stream id, the node and v8 versions.
const MACHINE_KEY = /^(?:eventStreamId|node|v8)$/;

/** Keys that hold a time, a duration, a pid or a machine detail get a placeholder. */
function scrubJson(value) {
  if (Array.isArray(value)) return value.map(scrubJson);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    const plain = typeof inner === "number" || typeof inner === "string";
    out[key] = plain && (TIME_KEY.test(key) || MACHINE_KEY.test(key)) ? `<${key}>` : scrubJson(inner);
  }
  return out;
}

/** The world's run ids: the ones it started first, then any other record, by name. */
function runIdsOf(world) {
  const records = join(world.sousHome, "records");
  const found = existsSync(records)
    ? readdirSync(records)
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -5))
        .sort()
    : [];
  return [...new Set([...world.runIds, ...found])];
}

/** Only known run ids are replaced: a pattern would also match words such as "scenario-places". */
function normalizer(root, runIds) {
  const roots = [root, root.replace(/^\/private\//, "/"), process.execPath, repo];
  const names = ["<tmp>", "<tmp>", "<node>", "<repo>"];
  const known = [...runIds];
  const ids = new Map();
  const now = Date.now();
  return (text) => {
    roots.forEach((path, i) => (text = text.split(path).join(names[i])));
    text = text.replace(UUID, (id) => {
      if (!ids.has(id.toLowerCase())) ids.set(id.toLowerCase(), `<id-${ids.size + 1}>`);
      return ids.get(id.toLowerCase());
    });
    // A dry run leaves no record, so its id is found where it names a folder.
    for (const match of text.matchAll(/\/(?:scratch|worktrees|runs|logs|records|projects)\/([0-9a-z]{8}-[0-9a-z]{6})\b/g)) {
      if (!known.includes(match[1])) known.push(match[1]);
    }
    known.forEach((id, i) => (text = text.split(id).join(`<run-${i + 1}>`)));
    // A project's log folder is named after its folder and a hash of its temp path.
    text = text.replace(/(project|sous-home|<run-\d+>)-[0-9a-f]{12}\b/g, "$1-<hash>");
    // Times near now change on every run; fixed times, such as a reset in 2100, stay.
    text = text.replace(ISO, (iso) => (Math.abs(Date.parse(iso) - now) < 7 * 86_400_000 ? "<time>" : iso));
    text = text.replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<hh:mm:ss>");
    text = text.replace(/\((\d+)s(?=[,)])/g, "(<n>s");
    text = text.replace(/\bin \d+s\b/g, "in <n>s");
    text = text.replace(/\b\d+[smhd] ago\b/g, "<n>s ago");
    text = text.replace(/\bpid \d+\b/g, "pid <n>");
    return text;
  };
}

/** The fake log, normalized, in an order that does not depend on timing. */
function fakeSection(world) {
  const ids = runIdsOf(world);
  const blank = (text) => ids.reduce((out, id) => out.split(id).join("<run>"), text.replace(UUID, "<id>"));
  return fakeLines(world)
    .map((line) => JSON.stringify(scrubJson(line)))
    .map((line, index) => ({ line, key: blank(line), index }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map((entry) => entry.line);
}

function writeWorld(out, file, world, extra = []) {
  const normalize = normalizer(world.root, runIdsOf(world));
  const parts = [...world.transcript, ...extra];
  const requests = fakeSection(world);
  if (requests.length) parts.push(`fake requests (sorted):\n${requests.join("\n")}`);
  writeFileSync(join(out, file), `${normalize(parts.join("\n\n"))}\n`);
}

// ── what is captured ──

async function captureHelp(root, out) {
  const world = makeWorld(root, "help");
  const main = await sous(world, ["--help"]);
  writeFileSync(join(out, "help.txt"), `${normalizer(root, [])(transcriptEntry(main))}\n`);
  const lines = [];
  for (const args of [[], ["help"], ["-h"], ...COMMANDS.map((command) => [command, "--help"])]) {
    const result = await sous(world, args);
    const same = result.code === main.code && result.stdout === main.stdout && result.stderr === main.stderr;
    lines.push(same ? `$ sous ${args.join(" ")}\nexit ${result.code}\nsame as sous --help` : transcriptEntry(result));
  }
  writeFileSync(join(out, "help-commands.txt"), `${normalizer(root, [])(lines.join("\n\n"))}\n`);
}

async function captureFresh(root, out) {
  // No config.json and no folder: sous makes its home on the first command.
  const world = makeWorld(root, "fresh", { config: null });
  for (const [file, args] of [
    ["fresh-list.txt", ["list"]],
    ["fresh-schedule-list.txt", ["schedule", "list"]],
    ["fresh-account.txt", ["account"]],
    ["fresh-doctor.txt", ["doctor"]],
  ]) {
    world.transcript = [];
    await step(world, args);
    writeWorld(out, file, world);
  }
}

const CHECKS = [
  ["emails", []],
  // The dot reporter prints no timings. A timing would change the verifier's token count.
  ["ticket", ["--ticket", "Add a shout option that upper-cases the text", "--test", "node --test --test-reporter=dot"]],
  ["factory", []],
  ...readdirSync(join(here, "workflows"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => [file.slice(0, -3), []]),
];

async function captureChecks(root, out, wanted) {
  const world = makeWorld(root, "check");
  if (wanted("workflows")) {
    await step(world, ["workflows"]);
    writeWorld(out, "workflows.txt", world);
  }
  // Each dry run gets its own world, so no two share a git folder.
  await pool(
    CHECKS.filter(([name]) => wanted(`check-${name}`)),
    4,
    async ([name, inputs]) => {
      const own = makeWorld(root, `check-${name}`);
      const result = await sous(own, ["check", name, "--dry-run", ...inputs]);
      const text = sortDryRunLog(normalizer(root, [])(transcriptEntry(result)));
      writeFileSync(join(out, `check-${name}.txt`), `${text}\n`);
    },
  );
}

/**
 * Steps that run at once log in any order, so the dry run's log lines are sorted. A line that
 * goes on under the one before it, such as "answered", stays with it.
 */
function sortDryRunLog(text) {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.startsWith("  <hh:mm:ss> "));
  if (first < 0) return text;
  let end = first;
  while (end < lines.length && (lines[end].startsWith("  <hh:mm:ss> ") || /^ {11}\S/.test(lines[end]))) end++;
  const groups = [];
  for (const line of lines.slice(first, end)) {
    if (line.startsWith("  <hh:mm:ss> ")) groups.push([line]);
    else groups[groups.length - 1].push(line);
  }
  groups.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [...lines.slice(0, first), "  (log lines sorted)", ...groups.flat(), ...lines.slice(end)].join("\n");
}

/** Each scenario gets its own world, runs its commands, then shows each run it started. */
const SCENARIOS = {
  "agent-session": {
    async drive(world) {
      await wait(world, await start(world, "agent-session"));
    },
  },
  fanout: {
    async drive(world) {
      await wait(world, await start(world, "fanout"));
    },
  },
  questions: {
    rules: [{ match: "ASKER", times: 1, answer: "QUESTION: Which file should I edit?" }],
    async drive(world) {
      const run = await start(world, "questions");
      await wait(world, run);
      await step(world, ["inbox"]);
      await step(world, ["answer", run, "blue"]);
      await wait(world, run);
      await step(world, ["inbox", run]);
      await step(world, ["answer", run, "src/textkit.js"]);
      await wait(world, run);
      await step(world, ["send-back", run, "Make it shorter"]);
      await wait(world, run);
      await step(world, ["approve", run]);
      await wait(world, run);
    },
  },
  places: {
    async drive(world) {
      for (const place of ["none", "folder", "worktree"]) await wait(world, await start(world, "places", ["--place", place]));
    },
  },
  harnesses: {
    async drive(world) {
      await wait(world, await start(world, "harnesses"));
    },
  },
  "rulesync-mcp": {
    async drive(world) {
      await wait(world, await start(world, "rulesync-mcp"));
    },
  },
  tools: {
    async drive(world) {
      await wait(world, await start(world, "tools"));
    },
  },
  "stop-step": {
    rules: [{ match: "STOP-SLOW", hold: "gate-never", times: 1 }],
    async drive(world) {
      const run = await start(world, "stop-step");
      await logged(world, /STOP-SLOW/);
      await stepDone(world, run, "quick");
      await step(world, ["stop", run, "--step", "slow"]);
      await wait(world, run);
      await step(world, ["resume", run]);
      await wait(world, run);
    },
  },
  pause: {
    rules: [{ match: "PAUSE-FIRST", hold: "gate-pause", times: 1 }],
    async drive(world) {
      const run = await start(world, "pause");
      await logged(world, /PAUSE-FIRST/);
      await step(world, ["pause", run]);
      await workerLogged(world, run, /\bpausing\b/);
      gate(world, "gate-pause");
      await wait(world, run);
      await step(world, ["resume", run]);
      await wait(world, run);
    },
  },
  retry: {
    rules: [
      { match: "RETRY-AUTO", fail: "Overloaded", times: 1 },
      { match: "RETRY-NONE", fail: "Overloaded", times: 1 },
    ],
    async drive(world) {
      const run = await start(world, "retry");
      await wait(world, run);
      await step(world, ["resume", run]);
      await wait(world, run);
    },
  },
  "limit-claude": {
    rules: [{ match: "LIMIT", limit: { resetsAt: RESETS_AT }, times: 1 }],
    async drive(world) {
      const run = await start(world, "limit");
      await wait(world, run);
      await step(world, ["inbox"]);
      await step(world, ["resume", run]);
      await wait(world, run);
    },
  },
  "limit-codex": {
    rules: [{ match: "LIMIT", limit: { resetsAt: RESETS_AT }, times: 1 }],
    async drive(world) {
      const run = await start(world, "limit", ["--", "--model", "codex"]);
      await wait(world, run);
      await step(world, ["resume", run]);
      await wait(world, run);
    },
  },
};

async function captureScenario(root, out, name, debug) {
  const scenario = SCENARIOS[name];
  const world = makeWorld(root, `scenario-${name}`, { rules: scenario.rules ?? [], debug });
  try {
    await scenario.drive(world);
  } catch (error) {
    world.transcript.push(`capture error: ${error.message}`);
  }
  const shown = await snapshot(world);
  cleanup(world);
  writeWorld(out, `scenario-${name}.txt`, world, shown);
}

async function pool(items, size, work) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await work(queue.shift());
  });
  await Promise.all(workers);
}

/** Capture everything into `out`. Returns the temp folder when `keep` is set. */
export async function capture(out, { only, keep = false, debug = false } = {}) {
  if (!existsSync(SOUS)) throw new Error(`${SOUS} is missing. Build the packages first.`);
  mkdirSync(out, { recursive: true });
  const wanted = (name) => !only?.length || only.some((prefix) => name.startsWith(prefix));
  const root = setupRoot();
  try {
    const jobs = [];
    if (wanted("help")) jobs.push(() => captureHelp(root, out));
    if (wanted("fresh")) jobs.push(() => captureFresh(root, out));
    if (wanted("check") || wanted("workflows")) jobs.push(() => captureChecks(root, out, wanted));
    for (const name of Object.keys(SCENARIOS)) {
      if (wanted(`scenario-${name}`)) jobs.push(() => captureScenario(root, out, name, debug));
    }
    await pool(jobs, 6, (job) => job());
    return keep ? root : undefined;
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outDir = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--only");
  if (!outDir) {
    process.stderr.write("usage: node test/baseline/capture.mjs <out dir> [--only name,name] [--keep] [--debug]\n");
    process.exit(2);
  }
  const onlyAt = args.indexOf("--only");
  const only = onlyAt >= 0 ? (args[onlyAt + 1] ?? "").split(",").filter(Boolean) : undefined;
  const started = Date.now();
  const kept = await capture(resolve(outDir), { only, keep: args.includes("--keep"), debug: args.includes("--debug") });
  process.stdout.write(`captured into ${resolve(outDir)} in ${Math.round((Date.now() - started) / 1000)}s\n`);
  if (kept) process.stdout.write(`temp folder kept: ${kept}\n`);
}

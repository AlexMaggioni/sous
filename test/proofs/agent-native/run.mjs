#!/usr/bin/env node
// Runs real Claude Code or Codex sessions against a sous build, on the scenarios of the Proof
// table in docs/agent-native.md, and checks what they did. See README.md in this folder.
//
// node test/proofs/agent-native/run.mjs --sous base --driver claude --scenarios 1,2 --reps 2

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { CLAUDE_BIN, CODEX_BIN, DEFAULTS, runTurn } from "./drivers.mjs";
import { readCalls, readHomeEvents, readOpenQuestions, readRuns, readWorkflowFiles, sousInCommands, waiting } from "./records.mjs";
import { refusalsOf, SCENARIOS, verdict } from "./scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const FIXTURES = join(HERE, "fixtures", "workflows");
const WRAPPER = join(HERE, "sous-wrapper.mjs");
const BUILDS = {
  base: resolve(REPO, "../orchestrator-agent-native-base/packages/cli/dist/cli.js"),
  feature: join(REPO, "packages/cli/dist/cli.js"),
};
// Claude Code refuses every write under ~/.claude, so the repetitions run in /tmp. Their
// results are copied out to RESULTS.
const SCRATCH = process.env.PROOF_SCRATCH ?? "/tmp/sous-proofs";
const RESULTS = process.env.PROOF_RESULTS ?? join(tmpdir(), "sous-proof-results");
const ALL = ["1", "2", "3", "4", "5", "5b", "6", "7", "9"];
const HINT = "This project's workflows run with the `sous` command line. `sous help` lists its commands.\n";
const FINISHED = new Set(["completed", "failed", "stopped"]);

const USAGE = `usage: node test/proofs/agent-native/run.mjs [options]
  --sous base|feature|<cli.js>   the sous build (default base)
  --driver claude|codex          the program that drives sous (default claude)
  --skill <SKILL.md>             copy this skill into the project (default none)
  --scenarios 1,2,5b|all         which scenarios (default all: ${ALL.join(",")})
  --reps N                       repetitions of each (default 1)
  --out <dir>                    where the results go (default ${RESULTS}/<batch>)
  --scratch <dir>                where repetitions run (default ${SCRATCH})
  --model <name>                 the driver's model (claude: sonnet, codex: gpt-6.1-sol)
  --effort low|medium|high       codex reasoning effort (default medium)
  --turn-minutes N               a turn is killed after this (default 10)
  --setup-only                   build the repetitions and run setups, start no session`;

function parseArgs(argv) {
  const o = { sous: "base", driver: "claude", scenarios: "all", reps: 1, turnMinutes: 10, scratch: SCRATCH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--sous") o.sous = next();
    else if (a === "--driver") o.driver = next();
    else if (a === "--skill") o.skill = resolve(next());
    else if (a === "--scenarios") o.scenarios = next();
    else if (a === "--reps") o.reps = Number(next());
    else if (a === "--out") o.out = resolve(next());
    else if (a === "--scratch") o.scratch = resolve(next());
    else if (a === "--model") o.model = next();
    else if (a === "--effort") o.effort = next();
    else if (a === "--turn-minutes") o.turnMinutes = Number(next());
    else if (a === "--setup-only") o.setupOnly = true;
    else if (a === "--help" || a === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  if (!["claude", "codex"].includes(o.driver)) throw new Error("--driver is claude or codex");
  o.cli = BUILDS[o.sous] ?? resolve(o.sous);
  if (!existsSync(o.cli)) throw new Error(`no sous build at ${o.cli}. Run pnpm build in its worktree.`);
  if (o.skill && !existsSync(o.skill)) throw new Error(`no skill at ${o.skill}`);
  o.list = o.scenarios === "all" ? ALL : o.scenarios.split(",").map((s) => s.trim());
  for (const s of o.list) if (!SCENARIOS[s]) throw new Error(`no scenario ${s}. They are ${ALL.join(", ")}.`);
  if (!(o.reps >= 1)) throw new Error("--reps is a number from 1");
  const d = DEFAULTS[o.driver];
  o.opts = { model: o.model ?? d.model, effort: o.effort ?? d.effort };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d\dZ$/, "Z");
  o.batch = `${o.sous in BUILDS ? o.sous : "custom"}-${o.driver}-${o.skill ? "skill" : "noskill"}-${stamp}`;
  o.batchDir = join(o.scratch, o.batch);
  o.out = o.out ?? join(RESULTS, o.batch);
  if (o.driver === "claude" && /\/\.claude(\/|$)/.test(o.batchDir)) throw new Error("--scratch is under a .claude folder, where Claude Code refuses every write. Pick another.");
  return o;
}

// ── a repetition's folders ──

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=proof", "-c", "user.email=proof@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "pipe" });

function makeRep(o, dir) {
  const rep = { dir, project: join(dir, "project"), bin: join(dir, "bin"), state: join(dir, "state") };
  rep.home = join(rep.state, "home");
  rep.calls = join(rep.state, "calls.jsonl");
  for (const d of [rep.project, rep.bin, rep.home]) mkdirSync(d, { recursive: true });
  const workflows = join(rep.project, ".sous", "workflows");
  mkdirSync(workflows, { recursive: true });
  for (const name of readdirSync(FIXTURES)) cpSync(join(FIXTURES, name), join(workflows, name));
  if (o.skill) {
    for (const d of [".claude", ".agents"]) {
      mkdirSync(join(rep.project, d, "skills", "sous"), { recursive: true });
      cpSync(o.skill, join(rep.project, d, "skills", "sous", "SKILL.md"));
    }
  }
  writeFileSync(join(rep.project, "README.md"), "# proof project\n");
  // With no skill, a session does not know sous exists. This one line is the same with or
  // without the skill, so the skill is the only difference between two batches.
  for (const f of ["CLAUDE.md", "AGENTS.md"]) writeFileSync(join(rep.project, f), HINT);
  git(rep.project, "init", "-q", "-b", "main");
  git(rep.project, "add", "-A");
  git(rep.project, "commit", "-q", "-m", "fixtures");
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  writeFileSync(
    join(rep.bin, "sous"),
    `#!/bin/sh\nexport SOUS_HOME=${q(rep.home)} SOUS_NOTIFY=0\nexec ${q(process.execPath)} ${q(WRAPPER)} ${q(o.cli)} ${q(rep.calls)} "$@"\n`,
    { mode: 0o755 },
  );
  return rep;
}

/** sous called by the harness itself, never logged as the agent's. */
function sous(o, rep, args) {
  const r = spawnSync(process.execPath, [o.cli, ...args], {
    cwd: rep.project,
    env: { ...cleanEnv(), SOUS_HOME: rep.home, SOUS_NOTIFY: "0" },
    encoding: "utf8",
    timeout: 120000,
  });
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
}

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_THREAD_ID|CODEX_SESSION_ID|CODEX_SANDBOX.*|SOUS_.*)$/.test(k)) env[k] = v;
  return env;
}

function setupEnv(o, rep) {
  return {
    async runUntil(workflow, exit) {
      const started = sous(o, rep, ["run", workflow, "--json"]);
      if (started.exit !== 0) throw new Error(`setup: sous run ${workflow} exited ${started.exit}: ${started.stderr}`);
      const { runId } = JSON.parse(started.stdout);
      const waited = sous(o, rep, ["wait", runId, "--json"]);
      if (waited.exit !== exit) throw new Error(`setup: sous wait ${runId} exited ${waited.exit}, not ${exit}: ${waited.stdout}${waited.stderr}`);
      return runId;
    },
    edit(file, change) {
      const path = join(rep.project, ".sous", "workflows", file);
      writeFileSync(path, change(readFileSync(path, "utf8")));
    },
  };
}

function snapshot(rep) {
  return {
    at: new Date().toISOString(),
    questions: readOpenQuestions(rep.home).map((q) => ({ id: q.id, runId: q.runId, prompt: q.prompt })),
    runs: readRuns(rep.home).map((r) => ({ runId: r.runId, workflow: r.workflow, status: r.status, pauseReason: r.pauseReason })),
    workflows: workflowsOf(rep),
  };
}

/** The project's workflows and the home's, which an agent may also write. */
function workflowsOf(rep) {
  const out = {};
  for (const [k, v] of Object.entries(readWorkflowFiles(rep.project))) out[`project/${k}`] = v;
  const home = join(rep.home, "workflows");
  if (existsSync(home)) for (const name of readdirSync(home)) if (lstatSync(join(home, name)).isFile()) out[`home/${name}`] = readFileSync(join(home, name), "utf8");
  return out;
}

/** Stop what the repetition left running: its runs, their workers, the daemon. */
function cleanup(o, rep) {
  const runs = readRuns(rep.home);
  for (const r of runs) if (!FINISHED.has(r.status)) sous(o, rep, ["stop", r.runId]);
  for (const r of runs) spawnSync("pkill", ["-f", `_worker ${r.runId}`]);
  sous(o, rep, ["daemon", "stop"]);
  // A wait the agent left in the background still runs through this repetition's wrapper.
  spawnSync("pkill", ["-f", rep.calls]);
}

function copyTree(from, to) {
  if (!existsSync(from)) return;
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const s = lstatSync(src);
      return s.isDirectory() || s.isFile();
    },
  });
}

// ── one repetition ──

async function runRep(o, id, k) {
  const scenario = SCENARIOS[id];
  const name = `${id}-r${k}`;
  const rep = makeRep(o, join(o.batchDir, name));
  const out = join(o.out, name);
  mkdirSync(out, { recursive: true });
  const result = { scenario: id, title: scenario.title, rep: k, dir: rep.dir, turns: [], error: undefined };
  let setupRunIds = [];
  try {
    if (scenario.setup) setupRunIds = (await scenario.setup(setupEnv(o, rep))) ?? [];
    if (setupRunIds.length) git(rep.project, "commit", "-q", "-am", "setup", "--allow-empty");
  } catch (err) {
    result.error = String(err.message ?? err);
  }
  const setupStatus = Object.fromEntries(readRuns(rep.home).map((r) => [r.runId, r.status]));
  const workflowsAtStart = workflowsOf(rep);
  const snapshots = [];
  const turns = [];
  if (!result.error && !o.setupOnly) {
    let sessionId;
    for (let t = 0; t < scenario.turns.length; t++) {
      const turn = await runTurn(o.driver, rep, {
        prompt: scenario.turns[t],
        sessionId,
        turn: t,
        limitMs: o.turnMinutes * 60000,
        opts: o.opts,
        streamFile: join(out, `turn${t}.jsonl`),
        stderrFile: join(out, `turn${t}.stderr.txt`),
      });
      turns.push(turn);
      snapshots.push(snapshot(rep));
      sessionId = turn.sessionId;
      process.stdout.write(`  ${name} turn ${t}: ${(turn.ms / 1000).toFixed(0)}s, exit ${turn.exit}${turn.timedOut ? ", timed out" : ""}\n`);
      if (!sessionId) {
        result.error = `turn ${t} gave no session id, exit ${turn.exit}. See turn${t}.stderr.txt.`;
        break;
      }
    }
  }

  const calls = readCalls(rep.calls, turns);
  const commands = turns.flatMap((t) => t.commands);
  const wait = waiting(commands, calls);
  const sum = (f) => turns.reduce((n, t) => n + (f(t) ?? 0), 0);
  const metrics = {
    sousCalls: calls.length,
    sousInCommands: sousInCommands(commands),
    commands: commands.length,
    denied: commands.filter((c) => c.denied).length,
    background: commands.filter((c) => c.background).length,
    ...wait,
    seconds: Math.round(sum((t) => t.ms) / 1000),
    tokens: sum((t) => t.tokens?.total),
    inputTokens: sum((t) => t.tokens?.input),
    cachedInputTokens: sum((t) => t.tokens?.cachedInput),
    outputTokens: sum((t) => t.tokens?.output),
    costUsd: turns.some((t) => t.costUsd !== undefined) ? Number(sum((t) => t.costUsd).toFixed(4)) : undefined,
    skillListed: turns.some((t) => (t.skills ?? []).some((s) => /sous/.test(typeof s === "string" ? s : s.name ?? ""))),
    timedOut: turns.some((t) => t.timedOut),
  };
  const ctx = {
    scenario,
    runs: readRuns(rep.home),
    homeEvents: readHomeEvents(rep.home),
    calls,
    commands,
    turns,
    snapshots,
    setupRunIds,
    setupStatus,
    workflowsAtStart,
    metrics,
  };
  let checks = [];
  if (!result.error && !o.setupOnly) {
    try {
      checks = scenario.checks(ctx);
    } catch (err) {
      result.error = `checks threw: ${err.stack ?? err}`;
    }
  }
  cleanup(o, rep);

  copyTree(rep.home, join(out, "home"));
  copyTree(join(rep.project, ".sous", "workflows"), join(out, "workflows"));
  if (existsSync(rep.calls)) cpSync(rep.calls, join(out, "calls.jsonl"));
  writeFileSync(join(out, "commands.json"), `${JSON.stringify(commands, null, 2)}\n`);

  Object.assign(result, {
    verdict: result.error ? "error" : o.setupOnly ? "setup" : verdict(checks),
    checks,
    metrics,
    refusals: refusalsOf(ctx),
    calls: calls.map((c) => ({ turn: c.turn, args: c.args, exit: c.exit, markers: c.markers })),
    runs: ctx.runs,
    homeEvents: ctx.homeEvents,
    setupRunIds,
    snapshots,
    turns: turns.map(({ commands: _c, ...t }) => t),
  });
  writeFileSync(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

// ── the fixtures on this build ──

function checkFixtures(o) {
  const rep = makeRep({ ...o, skill: undefined }, join(o.batchDir, "fixtures"));
  const out = {};
  for (const file of readdirSync(FIXTURES)) {
    const name = basename(file, ".js");
    const inputs = name === "hello" ? ["--name", "Ada"] : [];
    const c = sous(o, rep, ["check", name, ...inputs]);
    const d = sous(o, rep, ["check", name, ...inputs, "--dry-run"]);
    out[name] = { check: { exit: c.exit, output: `${c.stdout}${c.stderr}`.trim() }, dryRun: { exit: d.exit, output: `${d.stdout}${d.stderr}`.trim() } };
  }
  out.fails.dryRun.expected = "fails on purpose with exit 3";
  const anyone = readFileSync(join(FIXTURES, "asks-anyone.js"), "utf8").includes("answeredBy");
  out["asks-anyone"].answeredBy = anyone ? `the fixture sets answeredBy, and sous check exits ${out["asks-anyone"].check.exit}` : "the fixture lacks answeredBy";
  return out;
}

// ── the summary ──

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return undefined;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

function aggregate(results) {
  // A Map keeps the run order. An object would put "5b" after "9".
  const by = new Map();
  for (const r of results) by.set(r.scenario, [...(by.get(r.scenario) ?? []), r]);
  return [...by].map(([scenario, rs]) => ({
    scenario,
    title: rs[0].title,
    reps: rs.length,
    passed: rs.filter((r) => r.verdict === "pass").length,
    na: rs.filter((r) => r.verdict === "na").length,
    errors: rs.filter((r) => r.verdict === "error").length,
    medianSousCalls: median(rs.map((r) => r.metrics.sousCalls)),
    sleeps: rs.reduce((n, r) => n + r.metrics.sleeps, 0),
    polled: rs.filter((r) => r.metrics.polled).length,
    medianSeconds: median(rs.map((r) => r.metrics.seconds)),
    medianTokens: median(rs.map((r) => r.metrics.tokens)),
    checks: Object.fromEntries(
      [...new Set(rs.flatMap((r) => r.checks.map((c) => c.name)))].map((n) => [n, rs.map((r) => r.checks.find((c) => c.name === n)?.result ?? "-").join(" ")]),
    ),
  }));
}

function markdown(summary) {
  const L = [];
  const fmt = (n) => (n === undefined ? "-" : n >= 10000 ? `${Math.round(n / 1000)}k` : String(n));
  L.push(`# ${summary.batch}`, "");
  L.push(`sous ${summary.sous} (${summary.cli}), driver ${summary.driver} ${summary.driverVersion ?? ""}, model ${summary.model}${summary.effort ? ` at ${summary.effort}` : ""}, skill ${summary.skill ?? "none"}.`, "");
  L.push("## By scenario", "");
  L.push("| Scenario | Passed | Median sous calls | Sleeps | Polled | Median time (s) | Median tokens |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const a of summary.aggregate) {
    const extra = [a.na ? `${a.na} na` : "", a.errors ? `${a.errors} errors` : ""].filter(Boolean).join(", ");
    L.push(`| ${a.scenario} ${a.title} | ${a.passed}/${a.reps}${extra ? ` (${extra})` : ""} | ${fmt(a.medianSousCalls)} | ${a.sleeps} | ${a.polled} | ${fmt(a.medianSeconds)} | ${fmt(a.medianTokens)} |`);
  }
  L.push("", "## By repetition", "");
  L.push("| Scenario | Rep | Verdict | Checks | Sous calls | Sleeps | Time (s) | Tokens |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of summary.reps) {
    const checks = r.error ? r.error.replace(/\|/g, "/").slice(0, 160) : r.checks.filter((c) => c.result !== "note").map((c) => `${c.name}: ${c.result}`).join("; ");
    L.push(`| ${r.scenario} | ${r.rep} | ${r.verdict} | ${checks} | ${r.metrics.sousCalls} | ${r.metrics.sleeps} | ${r.metrics.seconds} | ${fmt(r.metrics.tokens)} |`);
  }
  L.push("", "## Failed checks", "");
  for (const r of summary.reps) for (const c of r.checks.filter((c) => c.result === "fail")) L.push(`- ${r.scenario} r${r.rep}, ${c.name} (${c.source}): ${c.reason}`);
  return `${L.join("\n")}\n`;
}

function version(bin) {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", env: cleanEnv(), timeout: 30000 }).trim();
  } catch {
    return undefined;
  }
}

// ── main ──

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(64);
  }
  mkdirSync(o.out, { recursive: true });
  console.log(`batch ${o.batch}\n  repetitions in ${o.batchDir}\n  results in ${o.out}`);
  const fixtures = checkFixtures(o);
  writeFileSync(join(o.out, "fixtures.json"), `${JSON.stringify(fixtures, null, 2)}\n`);
  const bad = Object.entries(fixtures).filter(([, f]) => f.check.exit !== 0);
  if (bad.length) console.log(`  fixtures that sous check refuses on this build: ${bad.map(([n]) => n).join(", ")}`);

  const summary = {
    batch: o.batch,
    sous: o.sous,
    cli: o.cli,
    driver: o.driver,
    driverBin: o.driver === "claude" ? CLAUDE_BIN : CODEX_BIN,
    driverVersion: version(o.driver === "claude" ? CLAUDE_BIN : CODEX_BIN),
    model: o.opts.model,
    effort: o.driver === "codex" ? o.opts.effort : undefined,
    skill: o.skill,
    scenarios: o.list,
    repsEach: o.reps,
    startedAt: new Date().toISOString(),
    reps: [],
  };
  const save = () => {
    summary.aggregate = aggregate(summary.reps);
    writeFileSync(join(o.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(join(o.out, "summary.md"), markdown(summary));
  };
  // One session at a time.
  for (const id of o.list) {
    for (let k = 1; k <= o.reps; k++) {
      console.log(`${id} r${k}: ${SCENARIOS[id].title}`);
      const r = await runRep(o, id, k);
      summary.reps.push({ scenario: r.scenario, title: r.title, rep: r.rep, verdict: r.verdict, error: r.error, checks: r.checks, metrics: r.metrics, refusals: r.refusals });
      console.log(`  ${r.verdict}${r.error ? `: ${r.error}` : ""}, ${r.metrics.sousCalls} sous calls, ${r.metrics.seconds}s, ${r.metrics.tokens} tokens`);
      for (const c of r.checks) if (c.result === "fail") console.log(`    fail: ${c.name}: ${c.reason}`);
      save();
    }
  }
  summary.endedAt = new Date().toISOString();
  save();
  console.log(`\n${join(o.out, "summary.md")}`);
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});

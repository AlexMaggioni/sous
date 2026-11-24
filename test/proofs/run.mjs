#!/usr/bin/env node
// Reruns the proofs in docs/proof/ on the real Claude Code and Codex, each proof in a fresh scratch
// SOUS_HOME, and writes one normalized JSON file per proof to <outdir>. The files keep the shape of
// each run: its steps, programs, models, places, statuses, branches, questions and check outputs.
// They leave out the agents' text, and replace run ids, paths, times and token counts.
//
// Usage: node test/proofs/run.mjs <outdir> [proof...]
// PROOFS_SCRATCH names the folder for the scratch homes and projects (default: the system temp).
// compare.mjs compares two output folders.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const SOUS = join(REPO, "packages/cli/dist/cli.js");
const WORDSRV = join(HERE, "wordsrv.mjs");
const NODE = process.execPath;
const HOME = homedir();

// The models the proofs ran on. Claude Code steps take haiku from the config or the agent files.
const CLAUDE = "claude/haiku";
const CODEX_MODEL = "gpt-6.1-sol";
const CODEX_EFFORT = "low";

const PROOFS = ["tools", "accounts", "installed", "ticket", "emails", "factory", "shared", "schedule"];

// Time limits, in seconds.
const QUICK = 60;
const DOCTOR = 180;
const SMALL_RUN = 360;
const TICKET_RUN = 900;
const EMAILS_WAIT = 600;
const FACTORY_RUN = 1500;

// The variables a run must not inherit: session markers, login tokens, API keys and program paths.
const DROP_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CLAUDE_CODE_EXECUTABLE",
  "CODEX_PATH",
  "LINEAR_API_KEY",
];

// ── small helpers ──

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const firstLine = (text) => String(text ?? "").trim().split("\n")[0] ?? "";
const clock = () => new Date().toISOString().slice(11, 19);

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function progress(ctx, line) {
  process.stdout.write(`${clock()} ${ctx.proof}: ${line}\n`);
}

function trace(ctx, text) {
  appendFileSync(ctx.trace, `${text}\n`);
}

function context(proof, root) {
  const dir = join(root, proof);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const ctx = { proof, root, dir, home, trace: join(dir, "trace.log"), out: { proof }, ids: new Map(), runs: 0 };
  writeConfig(ctx, {});
  return ctx;
}

function writeConfig(ctx, extra) {
  write(join(ctx.home, "config.json"), `${JSON.stringify({ notify: false, maxAgents: 2, defaultModel: CLAUDE, ...extra }, null, 2)}\n`);
}

/** The environment of one sous call. `extra` sets variables, and an undefined value removes one. */
function envFor(ctx, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("SOUS_") || DROP_ENV.includes(key)) delete env[key];
  env.SOUS_HOME = ctx.home;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** One sous call with a time limit. A call that runs out of time is killed. */
function sous(ctx, args, { cwd = ctx.dir, env = envFor(ctx), limit = QUICK } = {}) {
  const started = Date.now();
  const r = spawnSync(NODE, [SOUS, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: limit * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timedOut = r.error?.code === "ETIMEDOUT";
  const result = { code: timedOut ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut };
  const shown = args.map((a) => (a.length > 60 || a.includes("\n") ? "<text>" : a)).join(" ");
  const clip = (text) => (text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text);
  trace(ctx, `$ sous ${shown}  (exit ${result.code}${timedOut ? ", timed out" : ""}, ${Math.round((Date.now() - started) / 1000)}s)\n${clip(result.stdout)}${clip(result.stderr)}`);
  return result;
}

/** Copy the textkit example with examples/setup-textkit.sh. */
function textkit(ctx, name) {
  const target = join(ctx.dir, name);
  const r = spawnSync("sh", [join(REPO, "examples/setup-textkit.sh"), target], { encoding: "utf8", timeout: QUICK * 1000, killSignal: "SIGKILL" });
  if (r.status !== 0) throw new Error(`setup-textkit.sh failed: ${firstLine(r.stderr || r.stdout)}`);
  return target;
}

const ticketText = (tk, id) => readFileSync(join(tk, "tickets", `${id}.md`), "utf8").replace(/\n+$/, "");

// ── runs ──

/** Give a run id its placeholder, run1, run2, ..., in the order the runs started. */
function alias(ctx, runId, name) {
  if (!ctx.ids.has(runId)) ctx.ids.set(runId, name ?? `run${++ctx.runs}`);
  return ctx.ids.get(runId);
}

function start(ctx, workflow, inputs = [], opts = {}) {
  const r = sous(ctx, ["run", workflow, ...inputs, "--json"], opts);
  const started = parseJson(r.stdout);
  if (!started?.runId) throw new Error(`sous run ${workflow} exited with ${r.code}: ${firstLine(r.stderr || r.stdout)}`);
  alias(ctx, started.runId);
  progress(ctx, `started ${workflow} ${started.runId}`);
  return started.runId;
}

/** Wait for a run to end, pause or ask. A run that outlasts the limit is stopped. */
function wait(ctx, runId, limit, opts = {}) {
  const r = sous(ctx, ["wait", runId, "--json"], { ...opts, limit });
  if (r.timedOut) {
    progress(ctx, `${runId} ran out of time after ${limit}s, stopping it`);
    sous(ctx, ["stop", runId], opts);
    return { code: null, timedOut: true };
  }
  const summary = parseJson(r.stdout);
  progress(ctx, `${runId} ${summary?.status ?? "?"} (exit ${r.code})`);
  return { code: r.code, summary };
}

/** Wait again after an answer, until the run moves past the questions already answered. */
function waitPast(ctx, runId, answered, limit, opts = {}) {
  const deadline = Date.now() + limit * 1000;
  for (;;) {
    const left = Math.max(5, Math.round((deadline - Date.now()) / 1000));
    const w = wait(ctx, runId, left, opts);
    const open = w.summary?.questions ?? [];
    const stale = w.code === 4 && open.length > 0 && open.every((q) => answered.has(q.id));
    if (!stale || Date.now() > deadline) return w;
    sleepSync(2000);
  }
}

function waitOut(w) {
  return {
    exit: w.code,
    ...(w.timedOut ? { timedOut: true } : {}),
    status: w.summary?.status,
    pauseReason: w.summary?.pauseReason,
    reason: w.summary?.reason,
    questions: w.summary?.questions?.length ?? 0,
  };
}

function cmdOut(r) {
  return { exit: r.code, ...(r.timedOut ? { timedOut: true } : {}), stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function jsonOut(r) {
  const value = parseJson(r.stdout);
  return { exit: r.code, ...(r.timedOut ? { timedOut: true } : {}), ...(value === undefined ? { stdout: r.stdout.trim(), stderr: r.stderr.trim() } : { value }) };
}

/** The engine state file, which keeps the calls and the journal that `sous show` leaves out. */
function readState(home, runId) {
  const base = join(home, "runs", "projects");
  if (!existsSync(base)) return undefined;
  for (const folder of readdirSync(base)) {
    const file = join(base, folder, "runs", `${runId}.json`);
    if (existsSync(file)) return parseJson(readFileSync(file, "utf8"));
  }
  return undefined;
}

function journalOf(state) {
  const entries = [...(state.journal ?? [])];
  const nested = state.nestedJournal;
  if (Array.isArray(nested)) entries.push(...nested);
  else if (isObj(nested)) for (const list of Object.values(nested)) if (Array.isArray(list)) entries.push(...list);
  return entries;
}

/** The words or patterns a proof looks for in agent text, as [name, regex]. */
const word = (w) => [w, new RegExp(`(^|[^A-Za-z0-9-])${w.replace(/[-]/g, "\\-")}($|[^A-Za-z0-9-])`)];

function markersIn(value, markers = []) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return markers.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** The shape of a result: booleans, numbers and short ids stay, text becomes a placeholder. */
function shape(value, markers) {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[0-9a-f]{7,40}$/.test(trimmed) && /\d/.test(trimmed)) return "<commit>";
    const found = markersIn(value, markers);
    if (found.length) return `<text: ${found.join(", ")}>`;
    if (/^[A-Za-z0-9][\w./-]{0,39}$/.test(trimmed)) return trimmed;
    return "<text>";
  }
  if (Array.isArray(value)) return value.map((item) => shape(item, markers));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, markers)]));
}

function inputsShape(args) {
  if (!isObj(args)) return args;
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === "string" && (value.length > 60 || value.includes("\n")) ? "<text>" : value]));
}

/** The steps of one scope (the run or one nested run), in call order. */
function stepsOf(state, scope, spec, runCwd) {
  const key = (s, index) => `${s}#${index}`;
  const calls = new Map((state.calls ?? []).map((c) => [key(c.scope ?? state.runId, c.index), c]));
  const journal = new Map(journalOf(state).map((j) => [key(j.scope ?? state.runId, j.index), j]));
  const agents = (state.agents ?? [])
    .filter((a) => (a.scope ?? state.runId) === scope)
    .sort((a, b) => (a.callIndex ?? 1e9) - (b.callIndex ?? 1e9) || (a.id ?? 0) - (b.id ?? 0));
  const sessions = new Set();
  // Breakpoints and questions have a journal entry but no agent entry.
  const asked = journalOf(state)
    .filter((j) => (j.scope ?? state.runId) === scope && j.kind !== "agent" && !agents.some((a) => a.callIndex === j.index))
    .map((j) => {
      const call = calls.get(key(scope, j.index));
      const answer = JSON.stringify(j.result ?? null);
      return {
        index: j.index,
        step: { label: j.call?.label ?? j.kind, program: "question", kind: j.kind, ...(call?.origin ? { origin: call.origin } : {}), answer: answer.length <= 200 ? j.result : "<text>" },
      };
    });
  const steps = agents.map((a) => {
    const call = calls.get(key(scope, a.callIndex));
    const entry = journal.get(key(scope, a.callIndex));
    const model = a.model ?? call?.modelResolved ?? call?.modelRequested;
    const code = model === "exec";
    const sessionId = a.session?.sessionId;
    const continued = Boolean(entry?.call?.continuation) || Boolean(sessionId && sessions.has(sessionId));
    if (sessionId) sessions.add(sessionId);
    const value = entry && "result" in entry ? entry.result : a.result;
    const agentType = a.agentType ?? call?.agentType ?? entry?.call?.agentType;
    const effort = a.effort ?? call?.effort ?? entry?.call?.effort ?? a.session?.effort;
    const schema = (spec.schemas ?? []).find(([re]) => re.test(a.label ?? ""));
    const step = {
      label: a.label,
      ...(a.phase ? { phase: a.phase } : {}),
      program: code ? "code" : (model?.split("/")[0] ?? call?.backendId ?? "unknown"),
      model,
      ...(call?.modelRequested && call.modelRequested !== model ? { requested: call.modelRequested } : {}),
      ...(agentType !== undefined ? { agent: agentType } : {}),
      ...(effort !== undefined ? { effort } : {}),
      // A nested code step records no folder, so it gets its nested run's folder.
      place: a.session?.cwd ?? call?.resolvedCwd ?? runCwd,
      status: a.status,
      ...(code ? {} : { continuedSession: continued }),
      ...(a.session?.keptOpen ? { keptOpen: true } : {}),
      ...(call?.attempts > 1 ? { attempts: call.attempts } : {}),
      ...(a.errorCode ? { errorCode: a.errorCode } : {}),
      ...(a.error ? { error: typeof a.error === "string" ? a.error : (a.error.message ?? JSON.stringify(a.error)) } : {}),
      ...(code && isObj(value) && typeof value.code === "number" ? { exit: value.code } : {}),
      ...(schema ? { schema: schema[1](value) ? "matched" : "not matched" } : {}),
      ...(!code && spec.markers?.length ? { words: markersIn(value ?? a.resultPreview, spec.markers) } : {}),
    };
    return { index: a.callIndex ?? 1e9, step };
  });
  return [...steps, ...asked].sort((a, b) => a.index - b.index).map(({ step }) => step);
}

/** One run, from its record and its engine state. */
function collect(ctx, runId, spec = {}) {
  const shown = parseJson(sous(ctx, ["show", runId, "--json"]).stdout);
  if (!shown?.record) return { error: "sous show printed no run" };
  const { record } = shown;
  const state = readState(ctx.home, runId) ?? shown.state ?? {};
  const nested = Object.entries(record.nested ?? {}).map(([childId, child]) => {
    alias(ctx, childId, `${alias(ctx, runId)}-${child.label}`);
    return { label: child.label, workflow: child.workflow, cwd: child.cwd, branch: child.branch, steps: stepsOf(state, childId, spec, child.cwd) };
  });
  const accounts = isObj(record.accounts)
    ? Object.fromEntries(Object.entries(record.accounts).map(([program, account]) => [program, { ...account, ...(account?.kept !== undefined ? { kept: "<kept>" } : {}) }]))
    : record.accounts;
  return {
    workflow: record.workflow,
    origin: record.origin,
    ...(record.schedule ? { schedule: record.schedule } : {}),
    place: record.place,
    cwd: record.cwd,
    ...(record.worktree ? { worktree: record.worktree } : {}),
    ...(record.branch ? { branch: record.branch } : {}),
    inputs: inputsShape(record.args),
    status: state.status,
    ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
    ...(state.reason && state.status !== "completed" ? { reason: state.reason } : {}),
    phases: (state.phases ?? []).map((p) => (isObj(p) ? (p.name ?? p.title ?? p) : p)),
    programs: record.programs,
    accounts,
    logs: (state.logs ?? []).map((l) => (typeof l === "string" ? l : (l.message ?? l.text ?? l))),
    steps: stepsOf(state, runId, spec),
    ...(nested.length ? { nested } : {}),
    openQuestions: (shown.questions ?? []).length,
    result: shape(state.result, spec.markers),
  };
}

function checkOut(r) {
  const value = parseJson(r.stdout);
  if (!value) return { exit: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  const { dryRun, ...rest } = value;
  const out = { exit: r.code, ...rest };
  if (dryRun) {
    const agents = dryRun.agents ?? [];
    out.dryRun = {
      status: dryRun.status,
      ...(dryRun.reason ? { reason: dryRun.reason } : {}),
      agentSteps: agents.length,
      labels: agents.map((a) => (isObj(a) ? a.label : a)),
      result: shape(dryRun.result),
    };
  }
  return out;
}

function doctorOut(r) {
  const value = parseJson(r.stdout);
  if (!Array.isArray(value)) return { exit: r.code, ...(r.timedOut ? { timedOut: true } : {}), stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  return { exit: r.code, programs: value.map(({ models, ...report }) => ({ ...report, models: Array.isArray(models) ? models.length > 0 : models })) };
}

function inboxOf(ctx, runId, opts) {
  const list = parseJson(sous(ctx, ["inbox", "--json"], opts).stdout);
  return (Array.isArray(list) ? list : []).filter((q) => q.runId === runId);
}

function questionOut(q) {
  return {
    id: q.id,
    kind: q.kind,
    breakpoint: q.breakpoint,
    callIndex: q.callIndex,
    prompt: firstLine(q.prompt),
    draftsShown: (String(q.prompt).match(/^To: /gm) ?? []).length,
    ...(q.choices ? { choices: q.choices } : {}),
  };
}

function gitOut(repo) {
  const git = (...args) => (spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: QUICK * 1000, killSignal: "SIGKILL" }).stdout ?? "").trim();
  const lines = (text) => text.split("\n").filter(Boolean);
  const branches = lines(git("for-each-ref", "--format=%(refname:short)", "refs/heads/")).map((name) => ({
    name,
    commits: Number(git("rev-list", "--count", name === "main" ? "main" : `main..${name}`)),
    ...(name === "main" ? {} : { files: lines(git("diff", "--name-only", `main...${name}`)).sort() }),
  }));
  const worktrees = [];
  for (const block of git("worktree", "list", "--porcelain").split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (path) worktrees.push({ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null });
  }
  return { branches, worktrees, projectChanges: lines(git("status", "--porcelain")) };
}

// ── the proofs ──

const REFUSAL = `export const meta = { name: "refusal", description: "Two agents with tool lists try to run Bash", place: "none" }
const task = "Run the shell command \`ls -la\` with the Bash tool and report its first line. If the Bash tool is refused or not available, say so plainly and stop."
const denied = await agent(task, { agentType: "nobash", label: "deny list" })
const allowed = await agent(task, {
  agentType: "readonly",
  label: "allow list",
  schema: { type: "object", properties: { ranBash: { type: "boolean" }, note: { type: "string" } }, required: ["ranBash", "note"] },
})
return { denied, allowed }
`;

const HELLO = `export const meta = { name: 'hello', description: 'one tiny step on Claude Code' }
return await agent("Answer with the single word OK.", { label: "claude code on haiku", model: "claude/haiku" })
`;

const INSTALLED = `export const meta = { name: "installed", description: "One step on each installed program", place: "folder" }
const ask = "Answer with the single word OK."
const [claude, codex, codexLow] = await parallel([
  () => agent(ask, { label: "claude code on haiku", model: "claude/haiku" }),
  () => agent(ask, { label: "codex on ${CODEX_MODEL}", model: "codex/${CODEX_MODEL}" }),
  () => agent(ask, { label: "codex on ${CODEX_MODEL}, low effort", model: "codex/${CODEX_MODEL}", effort: "low" }),
])
return { claude, codex, codexLow }
`;

const TICKET_SPEC = {
  schemas: [
    [/^reviewer \d+$/, (v) => isObj(v) && typeof v.approved === "boolean" && typeof v.review === "string"],
    [/^verifier$/, (v) => isObj(v) && typeof v.passed === "boolean" && typeof v.evidence === "string"],
    [/^triage /, (v) => isObj(v) && typeof v.choice === "string" && typeof v.reason === "string"],
  ],
};

const EMAILS_SPEC = {
  schemas: [[/^sort$/, (v) => isObj(v) && Array.isArray(v.emails) && v.emails.every((e) => isObj(e) && typeof e.id === "string" && typeof e.reply === "boolean" && typeof e.why === "string")]],
};

const TICK = `export const meta = { name: "tick", description: "One code step every minute", schedule: "* * * * *" }
const done = await js("return 'tick'", null, { label: "tick" })
return done.result
`;

const codexAgent = (name, instructions) =>
  `name = "${name}"\ndescription = "Gives its word"\ndeveloper_instructions = "${instructions}"\nmodel = "${CODEX_MODEL}"\nmodel_reasoning_effort = "${CODEX_EFFORT}"\n`;

const giveWord = (w) => `When you are asked for your word, answer with the single word ${w} and nothing else. Do not change any file.`;

const flow = (name, body, extra = "") => `export const meta = { name: "${name}", description: "${name}", place: "folder"${extra} }\n${body}\n`;

const proofs = {
  async tools(ctx) {
    const p = join(ctx.dir, "p1");
    write(join(p, ".claude/agents/nobash.md"), "---\nname: nobash\nmodel: claude/haiku\ndisallowedTools: [Bash]\n---\n");
    write(join(p, ".claude/agents/readonly.md"), "---\nname: readonly\nmodel: claude/haiku\ntools: [Read, Grep, Glob]\n---\n");
    write(join(p, ".sous/workflows/refusal.js"), REFUSAL);
    const spec = {
      schemas: [[/^allow list$/, (v) => isObj(v) && typeof v.ranBash === "boolean" && typeof v.note === "string"]],
      markers: [["ls output", /total \d+/]],
    };
    ctx.out.check = checkOut(sous(ctx, ["check", "refusal", "--json"], { cwd: p }));
    const id = start(ctx, "refusal", [], { cwd: p });
    ctx.out.wait = waitOut(wait(ctx, id, SMALL_RUN, { cwd: p }));
    ctx.out.run = collect(ctx, id, spec);
  },

  async accounts(ctx) {
    const p = join(ctx.dir, "p1");
    write(join(p, ".sous/workflows/hello.js"), HELLO);
    const session = envFor(ctx, { CLAUDECODE: "1" });
    const spec = { markers: [word("OK")] };
    ctx.out.list = {
      fromSession: jsonOut(sous(ctx, ["account", "--json"], { cwd: p, env: session })),
      fromPlainShell: jsonOut(sous(ctx, ["account", "--json"], { cwd: p })),
    };
    ctx.out.useNobody = cmdOut(sous(ctx, ["account", "use", "nobody"], { cwd: p }));
    const a = start(ctx, "hello", ["--place", "none"], { cwd: p, env: session });
    ctx.out.fromSession = { wait: waitOut(wait(ctx, a, SMALL_RUN, { cwd: p, env: session })), run: collect(ctx, a, spec) };
    const b = start(ctx, "hello", ["--place", "none"], { cwd: p });
    ctx.out.fromPlainShell = { wait: waitOut(wait(ctx, b, SMALL_RUN, { cwd: p })), run: collect(ctx, b, spec) };
    ctx.out.accountsFileMade = existsSync(join(ctx.home, "accounts.json"));
  },

  async installed(ctx) {
    const p = join(ctx.dir, "p1");
    write(join(p, ".sous/workflows/installed.js"), INSTALLED);
    ctx.out.check = checkOut(sous(ctx, ["check", "installed", "--json"], { cwd: p }));
    const id = start(ctx, "installed", [], { cwd: p });
    ctx.out.wait = waitOut(wait(ctx, id, SMALL_RUN, { cwd: p }));
    ctx.out.run = collect(ctx, id, { markers: [word("OK")] });
    progress(ctx, "sous doctor");
    ctx.out.doctor = doctorOut(sous(ctx, ["doctor", "--json"], { cwd: p, limit: DOCTOR }));
    ctx.out.doctorWithWrongCodexPath = doctorOut(sous(ctx, ["doctor", "--json"], { cwd: p, limit: DOCTOR, env: envFor(ctx, { CODEX_PATH: "/nope/codex" }) }));
    // Dry runs with neither program on PATH. node is called by its full path.
    const tk = textkit(ctx, "tk");
    const bare = { cwd: tk, env: envFor(ctx, { PATH: "/usr/bin:/bin" }), limit: 120 };
    ctx.out.dryRuns = {
      ticket: checkOut(sous(ctx, ["check", "ticket", "--ticket", ticketText(tk, "TK-1"), "--dry-run", "--json"], bare)),
      factory: checkOut(sous(ctx, ["check", "factory", "--dry-run", "--json"], bare)),
      emails: checkOut(sous(ctx, ["check", "emails", "--dry-run", "--json"], bare)),
    };
  },

  async ticket(ctx) {
    const tk = textkit(ctx, "tk");
    const one = start(ctx, "ticket", ["--ticket", ticketText(tk, "TK-1"), "--rounds", "3"], { cwd: tk });
    ctx.out.tk1 = { wait: waitOut(wait(ctx, one, TICKET_RUN, { cwd: tk })), run: collect(ctx, one, TICKET_SPEC) };
    const two = start(ctx, "ticket", ["--ticket", ticketText(tk, "TK-2"), "--rounds", "3", "--reviewer", "strict-reviewer"], { cwd: tk });
    ctx.out.tk2 = { wait: waitOut(wait(ctx, two, TICKET_RUN, { cwd: tk })), run: collect(ctx, two, TICKET_SPEC) };
    ctx.out.git = gitOut(tk);
  },

  async emails(ctx) {
    const tk = textkit(ctx, "tk");
    const opts = { cwd: tk };
    const id = start(ctx, "emails", [], opts);
    const answered = new Set();
    ctx.out.answers = [];
    ctx.out.stops = [waitOut(wait(ctx, id, EMAILS_WAIT, opts))];
    const answer = (verb, note) => {
      const open = inboxOf(ctx, id, opts).filter((q) => !answered.has(q.id));
      const q = open[0];
      if (!q) {
        ctx.out.answers.push({ answer: verb, error: "no open question" });
        return false;
      }
      const r = sous(ctx, note ? [verb, q.id, note] : [verb, q.id], opts);
      answered.add(q.id);
      ctx.out.answers.push({ question: questionOut(q), openQuestions: open.length, answer: verb, ...(note ? { note } : {}), exit: r.code });
      progress(ctx, `${verb} ${q.id}`);
      return r.code === 0;
    };
    if (answer("send-back", "Shorter, two sentences at most")) {
      ctx.out.stops.push(waitOut(waitPast(ctx, id, answered, EMAILS_WAIT, opts)));
      if (answer("approve")) ctx.out.stops.push(waitOut(waitPast(ctx, id, answered, EMAILS_WAIT, opts)));
    }
    ctx.out.run = collect(ctx, id, EMAILS_SPEC);
    const cwd = parseJson(sous(ctx, ["show", id, "--json"], opts).stdout)?.record?.cwd;
    const drafts = cwd && join(cwd, "drafts.md");
    ctx.out.draftsFile = drafts && existsSync(drafts) ? { replies: (readFileSync(drafts, "utf8").match(/^To: /gm) ?? []).length } : null;
  },

  async factory(ctx) {
    const tk = textkit(ctx, "tk");
    const id = start(ctx, "factory", [], { cwd: tk });
    ctx.out.wait = waitOut(wait(ctx, id, FACTORY_RUN, { cwd: tk }));
    ctx.out.run = collect(ctx, id, TICKET_SPEC);
    ctx.out.git = gitOut(tk);
  },

  async shared(ctx) {
    const global = join(ctx.dir, "aiglobal");
    write(join(global, "rulesync.jsonc"), '{ "global": true }\n');
    write(
      join(global, ".rulesync/subagents/reviewer.md"),
      `---
name: reviewer
description: Reviews one change and approves it or asks for changes
targets: ["*"]
claudecode:
  model: haiku
codexcli:
  model: ${CODEX_MODEL}
  model_reasoning_effort: ${CODEX_EFFORT}
---
You review one change. The diff is in the prompt. Do not change any file. Say in two sentences at
most whether the change is correct, then end with one line: APPROVED or CHANGES.
`,
    );
    writeConfig(ctx, { rulesyncGlobal: global });

    // A Codex home of its own, logged in through a link to the real one's auth.json.
    const codexHome = join(ctx.dir, "codex-home");
    mkdirSync(join(codexHome, "agents"), { recursive: true });
    symlinkSync(join(HOME, ".codex/auth.json"), join(codexHome, "auth.json"));
    write(
      join(codexHome, "config.toml"),
      `model = "${CODEX_MODEL}"\nmodel_reasoning_effort = "${CODEX_EFFORT}"\n\n[mcp_servers.wordsrv]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(WORDSRV)}, "DECOY"]\n`,
    );
    write(join(codexHome, "agents/stylist.toml"), codexAgent("stylist", giveWord("CODEX-HOME")));
    const withCodexHome = envFor(ctx, { CODEX_HOME: codexHome });

    // Workflows that can't run, and one that picks its harness while running.
    const g4 = join(ctx.dir, "g4");
    write(join(g4, ".codex/agents/fixer.toml"), codexAgent("fixer", "Fix what you are asked to fix."));
    write(join(g4, ".codex/agents/dual.toml"), codexAgent("dual", "Say hello."));
    write(join(g4, ".opencode/agents/dual.md"), "---\ndescription: Says hello\n---\nSay hello.\n");
    write(join(ctx.home, "agents/oldie.md"), "---\nname: oldie\nmodel: claude/haiku\n---\nSay OLD.\n");
    const wf = (name, text) => write(join(g4, `.sous/workflows/${name}.js`), text);
    wf("wrong-harness", flow("wrong-harness", 'return await agent("Fix it.", { agentType: "fixer", label: "fixer", model: "claude/haiku" })'));
    wf("two-folders", flow("two-folders", 'return await agent("Say hello.", { agentType: "dual", label: "dual" })'));
    wf(
      "pick-later",
      flow("pick-later", 'return await agent("Fix it.", { agentType: "fixer", label: "fixer", model: args.harness })', ', inputs: { harness: { type: "string", description: "the harness", default: "codex" } }'),
    );
    wf("ghost", flow("ghost", 'return await agent("Hello.", { agentType: "ghost", label: "ghost" })'));
    wf("old-home", flow("old-home", 'return await agent("Hello.", { agentType: "oldie", label: "oldie" })'));
    ctx.out.checks = {};
    for (const name of ["wrong-harness", "two-folders", "pick-later", "ghost", "old-home"]) ctx.out.checks[name] = checkOut(sous(ctx, ["check", name, "--json"], { cwd: g4 }));
    const pick = start(ctx, "pick-later", ["--harness", "claude"], { cwd: g4 });
    ctx.out.pickLaterOnClaude = { wait: waitOut(wait(ctx, pick, QUICK, { cwd: g4 })), run: collect(ctx, pick) };

    // One agent in the global rulesync folder, on both harnesses.
    const g1 = join(ctx.dir, "g1");
    write(join(g1, "change.diff"), "--- a/math.js\n+++ b/math.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b\n+  return a + b\n }\n");
    write(
      join(g1, ".sous/workflows/review-both.js"),
      flow(
        "review-both",
        `const diff = await sh("cat change.diff", { label: "diff" })
const prompt = "Review this change to add(), which should return the sum of its arguments.\\n\\n" + diff.stdout
const [claude, codex] = await parallel([
  () => agent(prompt, { agentType: "reviewer", label: "review on claude code" }),
  () => agent(prompt, { agentType: "reviewer", label: "review on codex", model: "codex" }),
])
return { claude, codex }`,
      ),
    );
    const verdicts = { markers: [word("APPROVED"), word("CHANGES")] };
    ctx.out.reviewBothCheck = checkOut(sous(ctx, ["check", "review-both", "--json"], { cwd: g1 }));
    const review = start(ctx, "review-both", [], { cwd: g1 });
    ctx.out.reviewBoth = { wait: waitOut(wait(ctx, review, SMALL_RUN, { cwd: g1 })), run: collect(ctx, review, verdicts) };

    // Agents from a harness's own folders.
    const fo = join(ctx.dir, "folders");
    write(join(fo, ".claude/agents/pair-reviewer.md"), `---\nname: pair-reviewer\ndescription: Gives its word\nmodel: haiku\n---\n${giveWord("CLAUDE-COPY")}\n`);
    write(join(fo, ".codex/agents/pair-reviewer.toml"), codexAgent("pair-reviewer", giveWord("CODEX-COPY")));
    write(
      join(fo, ".sous/workflows/folders.js"),
      flow(
        "folders",
        `const [stylist, pair] = await parallel([
  () => agent("Give your word.", { agentType: "stylist", label: "stylist" }),
  () => agent("Give your word.", { agentType: "pair-reviewer", label: "pair-reviewer" }),
])
return { stylist, pair }`,
      ),
    );
    const copies = { markers: ["CLAUDE-COPY", "CODEX-COPY", "CODEX-HOME"].map(word) };
    const folders = { cwd: fo, env: withCodexHome };
    ctx.out.foldersCheck = checkOut(sous(ctx, ["check", "folders", "--json"], folders));
    const f1 = start(ctx, "folders", [], folders);
    ctx.out.foldersClaudeDefault = { wait: waitOut(wait(ctx, f1, SMALL_RUN, folders)), run: collect(ctx, f1, copies) };
    writeConfig(ctx, { rulesyncGlobal: global, defaultHarness: "codex" });
    const f2 = start(ctx, "folders", [], folders);
    ctx.out.foldersCodexDefault = { wait: waitOut(wait(ctx, f2, SMALL_RUN, folders)), run: collect(ctx, f2, copies) };
    writeConfig(ctx, { rulesyncGlobal: global });

    // An agent's own skill and MCP server, with a decoy server in each harness's own config.
    const tk = textkit(ctx, "textkit");
    write(
      join(tk, ".rulesync/subagents/word-teller.md"),
      `---
name: word-teller
description: Reports its MCP server's word and signs off with its skill
targets: ["*"]
skills: [textkit-style]
mcpServers: [wordsrv]
claudecode:
  model: haiku
codexcli:
  model: ${CODEX_MODEL}
  model_reasoning_effort: ${CODEX_EFFORT}
---
Call the get_word tool of the wordsrv MCP server. Report the word it returns on a line of its own,
as WORD: <word>. Then sign off as the textkit-style skill says. Do not change any file.
`,
    );
    const server = (w) => ({ command: NODE, args: [WORDSRV, w] });
    write(join(tk, ".rulesync/mcp.jsonc"), `${JSON.stringify({ mcpServers: { wordsrv: server("ORCHID") } }, null, 2)}\n`);
    write(join(tk, ".mcp.json"), `${JSON.stringify({ mcpServers: { wordsrv: server("DECOY") } }, null, 2)}\n`);
    const skill = "---\nname: textkit-style\ndescription: How textkit signs off an answer\n---\nEnd your answer with this line, on its own: Signed off in the textkit house style, mark PLUM-HARBOR.\n";
    for (const folder of [".rulesync/skills", ".claude/skills", ".agents/skills"]) write(join(tk, folder, "textkit-style/SKILL.md"), skill);
    write(
      join(tk, ".sous/workflows/word.js"),
      flow(
        "word",
        `const ask = "Do your task."
const own = "Call the get_word tool of the wordsrv MCP server and report the word it returns on a line of its own, as WORD: <word>. If you have no such tool, answer NO TOOL. Do not change any file."
const [claude, codex] = await parallel([
  () => agent(ask, { agentType: "word-teller", label: "word-teller on claude code" }),
  () => agent(ask, { agentType: "word-teller", label: "word-teller on codex", model: "codex" }),
])
const [claudeOwn, codexOwn] = await parallel([
  () => agent(own, { label: "own server on claude code", model: "claude/haiku" }),
  () => agent(own, { label: "own server on codex", model: "codex" }),
])
return { claude, codex, claudeOwn, codexOwn }`,
      ),
    );
    const words = { markers: ["ORCHID", "DECOY", "PLUM-HARBOR", "NO TOOL"].map(word) };
    const wordOpts = { cwd: tk, env: withCodexHome };
    ctx.out.wordCheck = checkOut(sous(ctx, ["check", "word", "--json"], wordOpts));
    const w = start(ctx, "word", [], wordOpts);
    ctx.out.word = { wait: waitOut(wait(ctx, w, SMALL_RUN, wordOpts)), run: collect(ctx, w, words) };
  },

  async schedule(ctx) {
    write(join(ctx.home, "workflows/tick.js"), TICK);
    const p = join(ctx.dir, "p0");
    mkdirSync(p, { recursive: true });
    const opts = { cwd: p };
    ctx.out.check = checkOut(sous(ctx, ["check", "tick", "--json"], opts));
    ctx.out.schedules = jsonOut(sous(ctx, ["schedule", "list", "--json"], opts));
    // Start at second 5 of a minute, so 150 seconds cover the same three minutes each time.
    const now = new Date();
    let ms = ((65 - now.getSeconds()) % 60) * 1000 - now.getMilliseconds();
    if (ms < 0) ms += 60_000;
    progress(ctx, `the service starts in ${Math.round(ms / 1000)}s`);
    await sleep(ms);
    const logFile = join(ctx.dir, "daemon.log");
    const fd = openSync(logFile, "w");
    const daemon = spawn(NODE, [SOUS, "daemon", "run"], { cwd: p, env: envFor(ctx), stdio: ["ignore", fd, fd] });
    closeSync(fd);
    const exited = new Promise((done) => daemon.on("exit", (code, signal) => done({ code, signal })));
    progress(ctx, `sous daemon run, pid ${daemon.pid}, for 150s`);
    await sleep(150_000);
    daemon.kill("SIGTERM");
    let end = await Promise.race([exited, sleep(20_000).then(() => null)]);
    let killed = false;
    if (!end) {
      daemon.kill("SIGKILL");
      killed = true;
      end = await exited;
    }
    const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    ctx.out.daemon = {
      exit: end.code,
      signal: end.signal,
      ...(killed ? { killedAfterTermFailed: true } : {}),
      pidFileLeft: existsSync(join(ctx.home, "daemon.pid")),
      log: lines.map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, "")),
    };
    const runs = (parseJson(sous(ctx, ["list", "--all", "--json"], opts).stdout) ?? []).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const r of runs) alias(ctx, r.runId);
    ctx.out.runs = runs.map((r) => ({ wait: waitOut(wait(ctx, r.runId, QUICK, opts)), run: collect(ctx, r.runId) }));
  },
};

// ── normalizing ──

const DROP_KEYS = new Set(["startedAt", "endedAt", "completedAt", "updatedAt", "createdAt", "askedAt", "since", "durationMs", "tokens", "usage", "tokenUsage", "cost", "costGauge", "pid", "sessionId"]);

function normalizer(ctx) {
  const pairs = [];
  const add = (from, to) => {
    if (!from) return;
    pairs.push([from, to]);
    try {
      const real = realpathSync(from);
      if (real !== from) pairs.push([real, to]);
    } catch {
      // not a path on disk
    }
  };
  add(ctx.home, "$SOUS_HOME");
  add(ctx.root, "$S");
  add(REPO, "$REPO");
  add(tmpdir(), "$TMP");
  add(HOME, "~");
  for (const [id, name] of ctx.ids) pairs.push([id, name]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  const text = (s) => {
    for (const [from, to] of pairs) s = s.split(from).join(to);
    return s
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>")
      // Local times, such as the next start that sous check prints for a schedule.
      .replace(/\d{1,2}\/\d{1,2}\/\d{4},? \d{1,2}:\d\d(:\d\d)?\s?[AP]M/g, "<time>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
      .replace(/runs\/projects\/[^/\s"]+/g, "runs/projects/<folder>")
      .replace(/\b\d+ tokens\b/g, "<n> tokens");
  };
  const deep = (value) => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(deep);
    if (!isObj(value)) return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) if (!DROP_KEYS.has(key) && item !== undefined) out[text(key)] = deep(item);
    return out;
  };
  return deep;
}

/** Sort the lists whose order depends on timing, after the ids got their placeholders. */
function sortLists(value) {
  if (Array.isArray(value)) return value.map(sortLists);
  if (!isObj(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    let next = sortLists(item);
    if (Array.isArray(next) && ["branches", "worktrees", "nested"].includes(key)) {
      next = [...next].sort((a, b) => String(a.name ?? a.path ?? a.label).localeCompare(String(b.name ?? b.path ?? b.label)));
    }
    out[key] = next;
  }
  return out;
}

/** The step fields no step recorded, so a reader knows they are missing rather than empty. */
function gaps(out) {
  const steps = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      if (typeof v.label === "string" && "program" in v && !["code", "question"].includes(v.program)) steps.push(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(out);
  if (!steps.length) return [];
  return ["agent", "effort"].filter((field) => !steps.some((s) => field in s)).map((field) => `no agent step records its ${field}`);
}

function finish(ctx) {
  // Runs that this script did not start, such as nested ones, get a placeholder too.
  const listed = parseJson(sous(ctx, ["list", "--all", "--json"]).stdout) ?? [];
  for (const r of [...listed].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) alias(ctx, r.runId);
  const out = { ...ctx.out, models: { claude: CLAUDE, codex: `${CODEX_MODEL}, ${CODEX_EFFORT} effort where a step or agent sets it` } };
  const missing = gaps(out);
  if (missing.length) out.gaps = missing;
  return sortLists(normalizer(ctx)(out));
}

// ── main ──

function leftovers(root, ids) {
  const r = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: QUICK * 1000, killSignal: "SIGKILL" });
  return (r.stdout ?? "")
    .split("\n")
    .filter((line) => line.includes(root) || line.includes(`${SOUS} daemon`) || [...ids].some((id) => line.includes(id)))
    .filter((line) => !line.includes(" ps -axo"));
}

async function main() {
  const [outArg, ...wanted] = process.argv.slice(2);
  if (!outArg) {
    process.stderr.write(`usage: node test/proofs/run.mjs <outdir> [proof...]\nproofs: ${PROOFS.join(", ")}\n`);
    process.exit(2);
  }
  const unknown = wanted.filter((p) => !PROOFS.includes(p));
  if (unknown.length) {
    process.stderr.write(`no proof ${unknown.join(", ")}. The proofs: ${PROOFS.join(", ")}\n`);
    process.exit(2);
  }
  if (!existsSync(SOUS)) {
    process.stderr.write(`${SOUS} is missing. Build sous first.\n`);
    process.exit(2);
  }
  const outdir = resolve(outArg);
  mkdirSync(outdir, { recursive: true });
  const base = process.env.PROOFS_SCRATCH ? resolve(process.env.PROOFS_SCRATCH) : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = realpathSync(mkdtempSync(join(base, "sous-proofs-")));
  process.stdout.write(`${clock()} scratch folder ${root}\n`);

  const summaryFile = join(outdir, "summary.json");
  const summary = parseJson(existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "") ?? {};
  summary.proofs ??= {};
  const allIds = new Set();
  for (const proof of wanted.length ? wanted : PROOFS) {
    const ctx = context(proof, root);
    const t0 = Date.now();
    let error;
    progress(ctx, "begins");
    try {
      await proofs[proof](ctx);
    } catch (e) {
      error = e;
      ctx.out.error = e.message;
      progress(ctx, `failed: ${e.message}`);
    }
    let result;
    try {
      result = finish(ctx);
    } catch (e) {
      error ??= e;
      result = { proof, error: `could not normalize: ${e.message}` };
    }
    for (const id of ctx.ids.keys()) allIds.add(id);
    write(join(outdir, `${proof}.json`), `${JSON.stringify(result, null, 2)}\n`);
    const seconds = Math.round((Date.now() - t0) / 1000);
    summary.proofs[proof] = { seconds, finished: !error, ...(error ? { error: error.message } : {}) };
    progress(ctx, `done in ${seconds}s`);
  }
  summary.leftoverProcesses = leftovers(root, allIds).length;
  write(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${clock()} wrote ${outdir}. Processes left that name a run or the scratch folder: ${summary.leftoverProcesses}\n`);
}

await main();

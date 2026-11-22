import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { WorkflowError } from "@orchestrator/shared-types";
import { lookupAgents, lookupMcpServers, planStep, registryOf, type LookupSettings } from "../src/agents.js";
import { parseArgs, parseSets } from "../src/cli.js";
import { cronMatches, nextRun, parseCron } from "../src/cron.js";
import { resumeTime } from "../src/daemon.js";
import { runExecSpec } from "../src/exec.js";
import { normalizeAnswer, type Question } from "../src/inbox.js";
import { checkInputs, workflowExtras } from "../src/inputs.js";
import { claudeMeta, createOrcRunner } from "../src/runner.js";
import { SlotPool } from "../src/slots.js";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `orc-${name}-`));

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A project, a global rulesync folder and harness homes of its own, so no real home is read. */
function lookupPlace(defaultHarness: LookupSettings["defaultHarness"] = "claude"): LookupSettings & { home: string; global: string } {
  const root = temp("lookup");
  const home = join(root, "home");
  const settings = {
    projectDir: join(root, "project"),
    rulesyncGlobal: join(root, "aiglobal"),
    defaultHarness,
    env: { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config") },
    home,
  };
  mkdirSync(settings.projectDir, { recursive: true });
  return { ...settings, global: join(root, "aiglobal") };
}

const rulesyncAgent = (word: string, extra = "") =>
  `---\nname: reviewer\ndescription: reviews\ntargets: ["*"]\n${extra}---\nAnswer ${word}.\n`;

describe("cron", () => {
  it("matches minutes, ranges, steps and weekdays in local time", () => {
    const weekdays9 = parseCron("0 9 * * 1-5");
    assert.equal(cronMatches(weekdays9, new Date(2026, 10, 23, 9, 0)), true, "Monday 9:00");
    assert.equal(cronMatches(weekdays9, new Date(2026, 10, 22, 9, 0)), false, "Sunday");
    assert.equal(cronMatches(weekdays9, new Date(2026, 10, 23, 9, 1)), false);
    const every15 = parseCron("*/15 * * * *");
    assert.equal(cronMatches(every15, new Date(2026, 0, 1, 3, 45)), true);
    assert.equal(cronMatches(every15, new Date(2026, 0, 1, 3, 46)), false);
    assert.equal(cronMatches(parseCron("0 0 * * 7"), new Date(2026, 10, 22, 0, 0)), true, "7 is Sunday");
  });

  it("takes either day field when both are set, and the short forms", () => {
    const either = parseCron("0 0 1 * 1");
    assert.equal(cronMatches(either, new Date(2026, 10, 1, 0, 0)), true, "the 1st, a Sunday");
    assert.equal(cronMatches(either, new Date(2026, 10, 2, 0, 0)), true, "a Monday");
    assert.equal(cronMatches(either, new Date(2026, 10, 3, 0, 0)), false);
    assert.deepEqual(parseCron("@daily").fields, parseCron("0 0 * * *").fields);
  });

  it("finds the next run and refuses bad fields", () => {
    assert.deepEqual(nextRun(parseCron("30 14 * * *"), new Date(2026, 10, 21, 15, 0)), new Date(2026, 10, 22, 14, 30));
    assert.throws(() => parseCron("61 * * * *"), /minute/);
    assert.throws(() => parseCron("* * *"), /five fields/);
  });
});

describe("inputs", () => {
  it("fill defaults, convert types and list every problem at once", () => {
    const extras = workflowExtras({
      description: "d",
      inputs: { ticket: "What to build", tries: { type: "number", default: 3 }, dry: { type: "boolean", required: false } },
      place: "folder",
    });
    assert.equal(extras.place, "folder");
    assert.deepEqual(checkInputs(extras, { ticket: "add --json", tries: "5", dry: "yes" }), {
      args: { ticket: "add --json", tries: 5, dry: true },
      problems: [],
    });
    const bad = checkInputs(extras, { tries: "many", nope: 1 });
    assert.equal(bad.problems.length, 3);
    assert.match(bad.problems.join("\n"), /unknown input --nope/);
    assert.match(bad.problems.join("\n"), /--tries must be a number/);
    assert.match(bad.problems.join("\n"), /missing input --ticket \(What to build\)/);
  });

  it("take anything when the workflow declares none", () => {
    assert.deepEqual(checkInputs(workflowExtras({}), { a: "1" }), { args: { a: "1" }, problems: [] });
  });
});

describe("command line", () => {
  it("keeps orc's flags apart from the workflow's inputs", () => {
    const parsed = parseArgs(["ticket", "--place", "none", "--ticket", "add a flag", "--wait", "--set", "reviewer.model=claude/opus", "--", "--place", "x"]);
    assert.deepEqual(parsed.positionals, ["ticket"]);
    assert.deepEqual(parsed.flags, { place: "none", wait: true });
    assert.deepEqual(parsed.inputs, { ticket: "add a flag", place: "x" });
    assert.deepEqual(parseSets(parsed.sets), { reviewer: { model: "claude/opus" } });
    assert.deepEqual(parseSets(["a.b.retries=2", "x.schema={\"type\":\"object\"}"]), { "a.b": { retries: 2 }, x: { schema: { type: "object" } } });
    assert.throws(() => parseSets(["nokey=1"]), /label\.key=value/);
  });

  it("turns an answer into the question's kind", () => {
    const base: Question = { id: "q", runId: "r", scope: "r", callIndex: 1, hash: "h", workflow: "w", prompt: "?", kind: "confirm", breakpoint: false, askedAt: "" };
    assert.equal(normalizeAnswer(base, "yes"), true);
    assert.equal(normalizeAnswer(base, "no"), false);
    assert.equal(normalizeAnswer({ ...base, kind: "input" }, "blue"), "blue");
  });
});

describe("code steps", () => {
  it("run sh, js, py and a script file, and return code, output and result", async () => {
    const cwd = temp("exec");
    writeFileSync(join(cwd, "step.py"), "import json, os, sys\nd = json.load(sys.stdin)\nopen(os.environ['ORC_RESULT'], 'w').write(json.dumps(d['n'] * 2))\n");
    const sh = await runExecSpec({ kind: "sh", command: "echo hi; pwd" }, { cwd });
    assert.equal(sh.code, 0);
    assert.match(sh.stdout, /^hi\n/);
    assert.ok(sh.stdout.trim().endsWith(cwd.split("/").pop()!));
    assert.equal((await runExecSpec({ kind: "js", source: "return input.a + input.b", input: { a: 2, b: 3 } }, { cwd })).result, 5);
    assert.deepEqual((await runExecSpec({ kind: "py", source: "return [x * 2 for x in input]", input: [1, 2] }, { cwd })).result, [2, 4]);
    assert.equal((await runExecSpec({ kind: "file", file: "step.py", input: { n: 21 } }, { cwd })).result, 42);
  });

  it("fail on a non-zero exit unless allowed, and on the time limit", async () => {
    const cwd = temp("exec-fail");
    await assert.rejects(runExecSpec({ kind: "sh", command: "echo broken >&2; exit 3" }, { cwd }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.match(error.message, /exited with code 3: broken/);
      assert.equal(error.recoverable, true);
      return true;
    });
    assert.equal((await runExecSpec({ kind: "sh", command: "exit 3", allowFail: true }, { cwd })).code, 3);
    await assert.rejects(runExecSpec({ kind: "sh", command: "sleep 5" }, { cwd, timeoutMs: 200 }), /timed out/);
  });

  it("wait until a command succeeds, checking again and again", async () => {
    const cwd = temp("exec-wait");
    setTimeout(() => writeFileSync(join(cwd, "done"), ""), 1200);
    const result = await runExecSpec({ kind: "wait", command: "test -f done", everySeconds: 1, timeoutSeconds: 10 }, { cwd });
    assert.ok((result.checks ?? 0) >= 2);
    await assert.rejects(runExecSpec({ kind: "wait", command: "false", everySeconds: 1, timeoutSeconds: 1 }, { cwd }), /still not true/);
  });
});

describe("agents", () => {
  it("looks each agent up in the project's rulesync, the global one, then the harnesses' folders", () => {
    const place = lookupPlace();
    const project = join(place.projectDir, ".rulesync", "subagents", "reviewer.md");
    const global = join(place.global, ".rulesync", "subagents", "reviewer.md");
    const folder = join(place.projectDir, ".claude", "agents", "reviewer.md");
    const home = join(place.home, ".claude", "agents", "reviewer.md");
    write(home, "---\nname: reviewer\ndescription: reviews\n---\nAnswer HOME.\n");
    write(folder, "---\nname: reviewer\ndescription: reviews\n---\nAnswer FOLDER.\n");
    write(global, rulesyncAgent("GLOBAL"));
    write(project, rulesyncAgent("PROJECT"));
    const prompt = () => lookupAgents(place).agents.get("reviewer")?.prompt;
    assert.equal(prompt(), "Answer PROJECT.");
    writeFileSync(project, rulesyncAgent("PROJECT").replace("name: reviewer", "name: someone"));
    assert.equal(prompt(), "Answer GLOBAL.", "a file is found by the name inside it");
    writeFileSync(global, rulesyncAgent("GLOBAL").replace("name: reviewer", "name: someone-else"));
    assert.equal(prompt(), "Answer FOLDER.");
    writeFileSync(folder, "---\nname: not-reviewer\n---\nx\n");
    assert.equal(prompt(), "Answer HOME.");
  });

  it("runs a rulesync agent on the default harness or the step's, with that harness's block", () => {
    const place = lookupPlace();
    write(
      join(place.global, ".rulesync", "subagents", "reviewer.md"),
      rulesyncAgent("X", "claudecode:\n  model: haiku\n  tools: [Read, Grep]\ncodexcli:\n  model: gpt-test\n  model_reasoning_effort: low\n"),
    );
    const lookup = lookupAgents(place);
    assert.equal(registryOf(lookup).get("reviewer")?.model, "claude/haiku");
    const onClaude = planStep(lookup, "reviewer");
    assert.ok("plan" in onClaude);
    assert.deepEqual([onClaude.plan.harness, onClaude.plan.model, onClaude.plan.tools], ["claude", "claude/haiku", ["Read", "Grep"]]);
    const onCodex = planStep(lookup, "reviewer", { model: "codex" });
    assert.ok("plan" in onCodex);
    assert.deepEqual([onCodex.plan.harness, onCodex.plan.model, onCodex.plan.effort, onCodex.plan.tools], ["codex", "codex/gpt-test", "low", undefined]);
    const pinned = planStep(lookup, "reviewer", { model: "codex/gpt-other" });
    assert.ok("plan" in pinned);
    assert.equal(pinned.plan.model, "codex/gpt-other", "a full model spec in the step wins over the block");
  });

  it("keeps an agent from a harness's own folder on that harness", () => {
    const place = lookupPlace();
    const file = join(place.home, ".codex", "agents", "fixer.toml");
    write(file, 'name = "fixer"\ndescription = "fixes"\nmodel = "gpt-test"\ndeveloper_instructions = "Fix it."\n');
    const lookup = lookupAgents(place);
    const plain = planStep(lookup, "fixer");
    assert.ok("plan" in plain);
    assert.deepEqual([plain.plan.harness, plain.plan.model, plain.plan.agent.prompt], ["codex", "codex/gpt-test", "Fix it."]);
    const sent = planStep(lookup, "fixer", { model: "claude/haiku" });
    assert.ok("problem" in sent);
    assert.equal(
      sent.problem,
      `agent "fixer" comes from ${file}, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code. Move it to rulesync, as .rulesync/subagents/fixer.md in the project or in the global rulesync folder, so one file serves every harness.`,
    );
  });

  it("gives the default harness's copy of an agent in both harnesses' folders", () => {
    const place = lookupPlace();
    const claude = join(place.projectDir, ".claude", "agents", "reviewer.md");
    const codex = join(place.projectDir, ".codex", "agents", "reviewer.toml");
    write(claude, "---\nname: reviewer\ndescription: reviews\n---\nAnswer CLAUDE.\n");
    write(codex, 'name = "reviewer"\ndescription = "reviews"\ndeveloper_instructions = "Answer CODEX."\n');
    assert.equal(lookupAgents(place).agents.get("reviewer")?.prompt, "Answer CLAUDE.");
    assert.equal(lookupAgents({ ...place, defaultHarness: "codex" }).agents.get("reviewer")?.prompt, "Answer CODEX.");
    const missing = planStep(lookupAgents(place), "nobody");
    assert.ok("problem" in missing);
    assert.match(missing.problem, /^no agent "nobody"\. orc looks in \.rulesync\/subagents\/, then the global rulesync folder/);
  });

  it("refuses a broken rulesync file instead of falling back to another copy", () => {
    const place = lookupPlace();
    write(join(place.projectDir, ".rulesync", "subagents", "reviewer.md"), "---\nname: reviewer\norc:\n  harness: gemini\n---\nx\n");
    write(join(place.projectDir, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\n---\nAnswer FOLDER.\n");
    const planned = planStep(lookupAgents(place), "reviewer");
    assert.ok("problem" in planned);
    assert.match(planned.problem, /orc\.harness is "gemini"\. Use one of claude, codex\./);
  });

  it("finds an MCP server in rulesync before the harness's own config", () => {
    const place = lookupPlace();
    write(join(place.projectDir, ".rulesync", "mcp.jsonc"), `{\n  // ours\n  "mcpServers": { "word": { "command": "node", "args": ["rulesync.js"], }, },\n}`);
    write(join(place.projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { word: { command: "node", args: ["claude.js"] }, docs: { url: "http://localhost:9/mcp" } } }));
    write(join(place.home, ".codex", "config.toml"), '[mcp_servers.word]\ncommand = "node"\nargs = ["codex.js"]\n\n[mcp_servers.tickets]\ncommand = "tickets"\nenv = { TOKEN = "${TOKEN}" }\n');
    const mcp = lookupMcpServers(place, { TOKEN: "t1" });
    const args = (found: ReturnType<typeof mcp.find>) => (found?.server as { args?: string[] } | undefined)?.args;
    assert.deepEqual(args(mcp.find("word", "claude")), ["rulesync.js"]);
    assert.deepEqual(args(mcp.find("word", "codex")), ["rulesync.js"]);
    assert.equal(mcp.find("docs", "claude")?.server.name, "docs");
    assert.equal(mcp.find("docs", "codex"), undefined, "Claude Code's config is not Codex's");
    assert.deepEqual((mcp.find("tickets", "codex")?.server as { env?: unknown }).env, [{ name: "TOKEN", value: "t1" }]);
  });
});

describe("runner", () => {
  it("runs code steps itself and passes agent steps on with effort, skills and listed MCP servers", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const place = lookupPlace();
    write(join(place.projectDir, ".rulesync", "mcp.jsonc"), `{ "mcpServers": { "linear": { "command": "npx", "args": [] } } }`);
    const runner = createOrcRunner({
      cwd: temp("runner"),
      inner: { run: async (_prompt: string, options: unknown) => { seen.push(options as Record<string, unknown>); return "ok"; } } as never,
      mcp: lookupMcpServers(place, {}),
    });
    const code = (await runner.run(JSON.stringify({ kind: "js", source: "return 1" }), { model: "exec" } as never)) as { result: unknown };
    assert.equal(code.result, 1);
    assert.equal(seen.length, 0, "code steps never reach the agent runner");
    assert.equal(await runner.run("go", { label: "a", effort: "high", skills: ["tdd"], mcpNames: ["linear"] } as never), "ok");
    assert.deepEqual(seen[0]!.meta, { claudeCode: { options: { effort: "high", skills: ["tdd"] } } });
    assert.equal((seen[0]!.mcpServers as Array<{ name: string }>)[0]!.name, "linear");
    assert.equal(seen[0]!.effort, undefined);
    await assert.rejects(runner.run("go", { label: "b", mcpNames: ["gmail"] } as never), /step "b": no MCP server "gmail" for Claude Code\. orc looks in .*Add it to \.rulesync\/mcp\.jsonc\./);
  });

  it("times out an agent step as a failure a retry can fix", async () => {
    const runner = createOrcRunner({
      cwd: temp("runner-timeout"),
      inner: {
        run: (_prompt: string, options: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      } as never,
    });
    await assert.rejects(runner.run("slow", { label: "slow", timeoutMs: 100 } as never), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.match(error.message, /timed out after 0s/);
      assert.equal(error.recoverable, true);
      return true;
    });
  });

  it("refuses a step whose model names Pi or OpenCode instead of running it on Claude Code", async () => {
    let calls = 0;
    const runner = createOrcRunner({ cwd: temp("runner-removed"), inner: { run: async () => { calls += 1; return "ok"; } } as never });
    for (const model of ["pi/gpt-test", "opencode/big", "OpenCode"]) {
      await assert.rejects(runner.run("go", { label: "old", model } as never), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.match(error.message, /^step "old": model "[^"]+" names the harness "(pi|opencode)", which orc no longer runs\. Use one of claude, codex\.$/);
        assert.equal(error.recoverable, false);
        return true;
      });
    }
    assert.equal(calls, 0, "no agent session starts");
  });

  it("keeps the meta it was given when there is no effort or skill", () => {
    const meta = { other: 1 };
    assert.equal(claudeMeta(meta), meta);
    assert.deepEqual(claudeMeta({ claudeCode: { options: { model: "x" } } }, { effort: "low" }), { claudeCode: { options: { model: "x", effort: "low" } } });
    // The agent's tool lists reach the Claude adapter, which applies them in every permission mode.
    assert.deepEqual(claudeMeta(undefined, { tools: ["Read", "Bash(npm test)", "mcp__linear__list_issues"], disallowedTools: ["Edit", "Write"] }), {
      claudeCode: { options: { tools: ["Read", "Bash"], allowedTools: ["Read", "Bash(npm test)", "mcp__linear__list_issues"], disallowedTools: ["Edit", "Write"] } },
    });
  });
});

describe("agent slots", () => {
  it("cap the agents running at once, and a person's run goes before a scheduled one", async () => {
    const dir = temp("slots");
    const user = new SlotPool(join(dir, "slots"), join(dir, "queue"), () => 1, "user", 20);
    const schedule = new SlotPool(join(dir, "slots"), join(dir, "queue"), () => 1, "schedule", 20);
    const first = await user.acquire({ label: "first" });
    const order: string[] = [];
    const scheduled = schedule.acquire({ label: "scheduled" }).then((release) => { order.push("scheduled"); release(); });
    await new Promise((r) => setTimeout(r, 60));
    const person = user.acquire({ label: "person" }).then((release) => { order.push("person"); release(); });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(order, [], "both wait while the one slot is taken");
    first();
    await Promise.all([scheduled, person]);
    assert.deepEqual(order, ["person", "scheduled"]);
  });
});

describe("usage limit", () => {
  it("resumes after the reset time, or 30 minutes after the pause when no time is known", () => {
    const pausedAt = "2026-11-21T10:00:00.000Z";
    assert.equal(resumeTime("Resets at 2026-11-21T12:00:00.000Z", pausedAt), Date.parse("2026-11-21T12:00:30.000Z"));
    assert.equal(resumeTime("Resets in ~2h", pausedAt), Date.parse("2026-11-21T12:00:30.000Z"));
    assert.equal(resumeTime(undefined, pausedAt), Date.parse("2026-11-21T10:30:00.000Z"));
  });
});

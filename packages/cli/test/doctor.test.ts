import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { HomePaths } from "@sous-run/engine";
import { fakeRunner, inProcess, testHome } from "@sous-run/engine/testing";
import { callProblem } from "./helpers/calls.js";
import { sous } from "./sous.js";

// sous doctor on the fake programs in test/fakes: what it prints when a check fails, and what
// --live sends. The home's config points at the fakes, so no real Claude Code or Codex runs.

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
for (const name of ["CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];

/** A home whose config names the programs, the rules the fakes follow, and what they were asked. */
function fakeHome(options: { claudePath?: string; rules?: unknown[] } = {}) {
  const { paths } = testHome({}, { claudePath: options.claudePath ?? join(FAKES, "claude"), codexPath: join(FAKES, "codex") });
  const dir = mkdtempSync(join(tmpdir(), "sous-doctor-"));
  const log = join(dir, "fake.log");
  const rules = join(dir, "rules.json");
  writeFileSync(rules, JSON.stringify(options.rules ?? []));
  process.env.FAKE_LOG = log;
  process.env.FAKE_RULES = rules;
  const asked = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []).map((line) => JSON.parse(line) as { program: string; model: string | null; prompt: string });
  return { paths, dir, asked };
}

describe("sous doctor", () => {
  it("names the program it cannot find, still checks the other, and exits 1", async () => {
    const { paths } = fakeHome({ claudePath: "/nonexistent/claude" });
    const run = await sous(paths, ["doctor"]);
    assert.equal(run.code, 1);
    const lines = run.out.split("\n");
    assert.deepEqual(lines.slice(0, 3), [
      "Claude Code",
      "  missing   claudePath in ~/.sous/config.json is /nonexistent/claude, which is not a program file. Point it at Claude Code, or remove it.",
      "Codex 0.169.0",
    ]);
    assert.ok(lines.includes("  talks     yes"), "Codex is checked all the same");
  });

  it("names a program that prints no version, and exits 1", async () => {
    const odd = join(mkdtempSync(join(tmpdir(), "sous-doctor-odd-")), "claude");
    writeFileSync(odd, "#!/bin/sh\necho garbage\n");
    chmodSync(odd, 0o755);
    const { paths } = fakeHome({ claudePath: odd });
    const run = await sous(paths, ["doctor"]);
    assert.equal(run.code, 1);
    assert.deepEqual(run.out.split("\n").slice(0, 3), [
      "Claude Code",
      `  program   ${odd}, from config.json`,
      `  version   ${odd} --version printed no version. Check that it is Claude Code.`,
    ]);
  });

  it("prints each program's report as JSON, and exits 1 when one has a problem", async () => {
    const reports = async (claudePath?: string) => {
      const { paths } = fakeHome(claudePath ? { claudePath } : {});
      const run = await sous(paths, ["doctor", "--json"]);
      return { code: run.code, reports: (JSON.parse(run.out) as { programs: Array<Record<string, unknown>> }).programs };
    };
    const healthy = await reports();
    assert.equal(healthy.code, 0);
    assert.deepEqual(
      healthy.reports.map((report) => [report.program, report.version, report.source, report.talks, report.problem]),
      [
        ["claude", "2.1.330", "config", true, undefined],
        ["codex", "0.169.0", "config", true, undefined],
      ],
    );
    assert.deepEqual(healthy.reports[1]!.models, ["gpt-fake"]);

    const missing = await reports("/nonexistent/claude");
    assert.equal(missing.code, 1);
    assert.match(String(missing.reports[0]!.problem), /claudePath in ~\/\.sous\/config\.json is \/nonexistent\/claude, which is not a program file/);
    assert.equal(missing.reports[0]!.path, undefined);
    assert.equal(missing.reports[1]!.talks, true);
  });

  it("with --live, runs one step on each program and prints what it answered", async () => {
    const { paths, asked } = fakeHome();
    const run = await sous(paths, ["doctor", "--live"]);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /^ {2}live {6}claude\/claude-sonnet-fake answered "Fake claude answer."$/m);
    assert.match(run.out, /^ {2}live {6}codex\/gpt-fake answered "Fake codex answer."$/m);
    assert.deepEqual(
      asked().map(({ program, prompt }) => [program, prompt]),
      [
        ["claude", "Answer with the single word OK."],
        ["codex", "Answer with the single word OK."],
      ],
    );
  });

  it("without --live, sends no step", async () => {
    const { paths, asked } = fakeHome();
    const run = await sous(paths, ["doctor"]);
    assert.equal(run.code, 0);
    assert.doesNotMatch(run.out, /live {6}/);
    assert.deepEqual(asked(), []);
  });

  it("with --live --model, runs that model on its program alone", async () => {
    const { paths, asked } = fakeHome();
    const run = await sous(paths, ["doctor", "--live", "--model", "haiku"]);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /^ {2}live {6}haiku answered "Fake claude answer."$/m);
    assert.doesNotMatch(run.out, /live {6}codex/);
    assert.deepEqual(
      asked().map(({ program, model }) => [program, model]),
      [["claude", "haiku"]],
    );
  });

  it("with --live, prints the failure of a step, still runs the other program, and exits 1", async () => {
    const { paths } = fakeHome({ rules: [{ match: "OK", program: "claude", fail: "boom" }] });
    const run = await sous(paths, ["doctor", "--live"]);
    assert.equal(run.code, 1);
    assert.match(run.out, /^ {2}live {6}claude\/default failed: .*boom$/m);
    assert.match(run.out, /^ {2}live {6}codex\/gpt-fake answered "Fake codex answer."$/m);
  });
});

// Piece 15. Doctor also checks the sous skill for each program, as `sous skill check` does. Under
// Codex, whose workspace-write sandbox blocks writes outside the project, doctor probes a write to
// the sous home and says how to allow it. A write that fails under the home is the error
// home_not_writable, with the same advice.

const REAL_HOME = userInfo().homedir;
const HELLO = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/workflows/hello.js"), "utf8");

type Parsed = Record<string, unknown> & { notes: string[]; next: Array<{ call: string; does: string }> };

/** A JSON reply: its data, with notes and next arrays whose calls parse. */
function replyOf(printed: { code: number; out: string }): Parsed {
  let parsed: Parsed | undefined;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out) as Parsed), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  assert.ok(!("error" in parsed!), printed.out);
  assert.ok(Array.isArray(parsed!.notes), `no notes array: ${printed.out}`);
  assert.ok(Array.isArray(parsed!.next), `no next array: ${printed.out}`);
  for (const next of parsed!.next) assert.equal(callProblem(next.call), undefined);
  return parsed!;
}

/** A fake-program home with HOME and CLAUDE_CONFIG_DIR of its own, so the skill places are in it. */
function placesHome() {
  const { paths } = fakeHome();
  const home = mkdtempSync(join(tmpdir(), "sous-doctor-home-"));
  assert.ok(!home.startsWith(`${REAL_HOME}/.`), "the test home is inside a dot folder of the real home");
  return { paths, home, claude: join(home, "claude-config", "skills", "sous"), codex: join(home, ".agents", "skills", "sous") };
}

/** Run sous with HOME and CLAUDE_CONFIG_DIR on the test's home, and `extra` in the env main reads
 *  only, then put process.env back. */
async function within(h: { paths: HomePaths; home: string }, argv: string[], extra: Record<string, string> = {}, options: Parameters<typeof sous>[2] = {}) {
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const moved = { HOME: h.home, CLAUDE_CONFIG_DIR: join(h.home, "claude-config") };
  Object.assign(process.env, moved);
  try {
    return await sous(h.paths, argv, { ...options, env: { ...process.env, ...moved, ...extra } });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Make every folder and file under root read-only, and give a function that puts them back. */
function readOnly(root: string): () => void {
  const walk = (path: string, mode: (dir: boolean) => number) => {
    const dir = lstatSync(path).isDirectory();
    if (dir) for (const name of readdirSync(path)) walk(join(path, name), mode);
    if (!lstatSync(path).isSymbolicLink()) chmodSync(path, mode(dir));
  };
  walk(root, (dir) => (dir ? 0o555 : 0o444));
  return () => walk(root, (dir) => (dir ? 0o755 : 0o644));
}

/** Root ignores file modes, so a read-only home proves nothing there. */
const asRoot = process.getuid?.() === 0;

/** The advice for a Codex sandbox that blocks the sous home. */
function assertSandboxAdvice(text: string, home: string): void {
  assert.ok(text.includes("sandbox_workspace_write.writable_roots"), `no writable_roots in: ${text}`);
  assert.ok(text.includes(`--add-dir ${home}`), `no --add-dir ${home} in: ${text}`);
}

describe("sous doctor, the skill", () => {
  it("reports the missing skill for each program, as sous skill check does, and gives the install call", async () => {
    const h = placesHome();
    const printed = await within(h, ["doctor", "--json"]);
    assert.equal(printed.code, 0, `a missing skill is not a failed check: ${printed.out}`);
    const reply = replyOf(printed);
    const checked = replyOf(await within(h, ["skill", "check", "--json"]));
    assert.deepEqual(reply.skills, checked.programs, printed.out);
    assert.deepEqual(reply.skills, [
      { program: "claude", place: h.claude, installed: false, ours: false },
      { program: "codex", place: h.codex, installed: false, ours: false },
    ]);
    assert.ok(reply.next.some((next) => next.call === "sous skill install --json"), JSON.stringify(reply.next));
  });

  it("prints a skill line under each program in text", async () => {
    const h = placesHome();
    const printed = await within(h, ["doctor"]);
    assert.equal(printed.code, 0, printed.out);
    const blocks = printed.out.split(/^(?=Codex)/m);
    assert.equal(blocks.length, 2, printed.out);
    assert.match(blocks[0]!, new RegExp(`^ {2}skill {5}.*${h.claude.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
    assert.match(blocks[1]!, new RegExp(`^ {2}skill {5}.*${h.codex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  });

  it("reports the skill as ours for both programs after sous skill install, with no install call", async () => {
    const h = placesHome();
    assert.equal((await within(h, ["skill", "install"])).code, 0);
    const printed = await within(h, ["doctor", "--json"]);
    const reply = replyOf(printed);
    assert.ok(Array.isArray(reply.skills), `doctor gives no skills list: ${printed.out}`);
    assert.deepEqual(
      (reply.skills as Array<{ program: string; installed: boolean; ours: boolean }>).map(({ program, installed, ours }) => [program, installed, ours]),
      [
        ["claude", true, true],
        ["codex", true, true],
      ],
    );
    assert.ok(!reply.next.some((next) => next.call.startsWith("sous skill install")), JSON.stringify(reply.next));
  });
});

describe("sous doctor, the home", () => {
  it("gives the home's path and says it is writable", async () => {
    const h = placesHome();
    const printed = await within(h, ["doctor", "--json"]);
    assert.deepEqual(replyOf(printed).home, { path: h.paths.home, writable: true }, printed.out);
  });

  it("says a read-only home is not writable, and why", { skip: asRoot && "root writes anywhere" }, async () => {
    const h = placesHome();
    const restore = readOnly(h.paths.home);
    try {
      const printed = await within(h, ["doctor", "--json"]);
      assert.equal(printed.code, 1, printed.out);
      const home = replyOf(printed).home as { path: string; writable: boolean; problem?: unknown };
      assert.equal(home.path, h.paths.home);
      assert.equal(home.writable, false, printed.out);
      assert.equal(typeof home.problem, "string", printed.out);
    } finally {
      restore();
    }
  });

  it("a refused write outside the home stays internal", { skip: asRoot && "root writes anywhere" }, async () => {
    const h = placesHome();
    const config = join(h.home, "claude-config");
    mkdirSync(config, { recursive: true });
    chmodSync(config, 0o555);
    try {
      const printed = await within(h, ["hook", "install", "--json"], { CODEX_THREAD_ID: "thread-1" });
      assert.equal(printed.code, 1, printed.out);
      assert.equal((JSON.parse(printed.out) as { error: { code: string } }).error.code, "internal", printed.out);
    } finally {
      chmodSync(config, 0o755);
    }
  });
});

describe("sous doctor and runs, a sous home the Codex sandbox blocks", () => {
  it("under Codex with a read-only home, doctor notes writable_roots and --add-dir, and exits 1", { skip: asRoot && "root writes anywhere" }, async () => {
    const h = placesHome();
    const restore = readOnly(h.paths.home);
    try {
      const printed = await within(h, ["doctor", "--json"], { CODEX_THREAD_ID: "thread-1" });
      assert.equal(printed.code, 1, printed.out);
      const reply = replyOf(printed);
      const note = reply.notes.find((line) => line.includes("writable_roots"));
      assert.ok(note, `no writable_roots note: ${printed.out}`);
      assertSandboxAdvice(note, h.paths.home);
    } finally {
      restore();
    }
  });

  it("gives the writable_roots note only under Codex, and only when the home is read-only", { skip: asRoot && "root writes anywhere" }, async () => {
    const h = placesHome();
    const writable = replyOf(await within(h, ["doctor", "--json"], { CODEX_THREAD_ID: "thread-1" }));
    assert.ok(!writable.notes.some((line) => line.includes("writable_roots")), `a writable home got the note: ${JSON.stringify(writable.notes)}`);
    const restore = readOnly(h.paths.home);
    try {
      const person = replyOf(await within(h, ["doctor", "--json"]));
      assert.ok(!person.notes.some((line) => line.includes("writable_roots")), `a person outside Codex got the note: ${JSON.stringify(person.notes)}`);
      const codex = replyOf(await within(h, ["doctor", "--json"], { CODEX_THREAD_ID: "thread-1" }));
      assert.ok(codex.notes.some((line) => line.includes("writable_roots")), JSON.stringify(codex.notes));
    } finally {
      restore();
    }
  });

  it("a run in a read-only home under Codex fails with home_not_writable, exit 1, and the same advice", { skip: asRoot && "root writes anywhere" }, async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const home = mkdtempSync(join(tmpdir(), "sous-doctor-home-"));
    const workers = inProcess({ inner: fakeRunner(() => "unused").runner });
    const restore = readOnly(paths.home);
    try {
      const printed = await within({ paths, home }, ["run", "hello", "--name", "Ada", "--json", "--project", projectDir], { CODEX_THREAD_ID: "thread-1" }, { launch: workers.launch });
      assert.equal(printed.code, 1, printed.out);
      const { error } = JSON.parse(printed.out) as { error: { code: string; message: string; change: string; call: string | null } };
      assert.equal(error.code, "home_not_writable", printed.out);
      assertSandboxAdvice(error.change, paths.home);
      assert.equal(error.call, "sous doctor --json");
      assert.deepEqual(workers.launched, [], "a worker started although the run could not be saved");
    } finally {
      restore();
    }
  });

  it("prints home_not_writable with its change and call in text", { skip: asRoot && "root writes anywhere" }, async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const home = mkdtempSync(join(tmpdir(), "sous-doctor-home-"));
    const workers = inProcess({ inner: fakeRunner(() => "unused").runner });
    const restore = readOnly(paths.home);
    try {
      const printed = await within({ paths, home }, ["run", "hello", "--name", "Ada", "--project", projectDir], { CODEX_THREAD_ID: "thread-1" }, { launch: workers.launch });
      assert.equal(printed.code, 1, printed.out);
      assert.match(printed.out, /^ {2}change: .*sandbox_workspace_write\.writable_roots/m);
      assert.match(printed.out, /^ {2}try: sous doctor --json$/m);
    } finally {
      restore();
    }
  });

  it("a write error under the home is home_not_writable for a person too", { skip: asRoot && "root writes anywhere" }, async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const home = mkdtempSync(join(tmpdir(), "sous-doctor-home-"));
    const workers = inProcess({ inner: fakeRunner(() => "unused").runner });
    const restore = readOnly(paths.home);
    try {
      const printed = await within({ paths, home }, ["run", "hello", "--name", "Ada", "--json", "--project", projectDir], {}, { launch: workers.launch });
      assert.equal(printed.code, 1, printed.out);
      assert.equal((JSON.parse(printed.out) as { error: { code: string } }).error.code, "home_not_writable", printed.out);
    } finally {
      restore();
    }
  });
});

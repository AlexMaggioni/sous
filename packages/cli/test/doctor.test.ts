import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { testHome } from "@sous/engine/testing";
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

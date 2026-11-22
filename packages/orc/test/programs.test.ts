import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { WorkflowError } from "@orchestrator/shared-types";
import { findProgram, programVersion, type FoundProgram, type Program, type ProgramLookup } from "../src/programs.js";
import { createOrcRunner } from "../src/runner.js";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `orc-${name}-`));

/** A file the lookup reads as a native program: it does not start with #!. */
function native(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00]));
  chmodSync(file, 0o755);
  return file;
}

function script(file: string, body: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

const found = (lookup: ProgramLookup): FoundProgram => {
  assert.ok(!("problem" in lookup), "problem" in lookup ? lookup.problem : "");
  return lookup;
};

describe("installed programs", () => {
  it("take the first program on PATH, passing over wrapper scripts, and name the other copies", () => {
    const root = temp("programs");
    const wrapper = script(join(root, "wrap", "claude"), "#!/bin/bash\nexec claude-launch \"$@\"\n");
    const first = native(join(root, "a", "claude"));
    const second = native(join(root, "b", "claude"));
    const result = found(findProgram("claude", { env: { PATH: [join(root, "wrap"), join(root, "a"), join(root, "b")].join(":") }, usualDirs: [] }));
    assert.equal(result.path, first);
    assert.equal(result.source, "path");
    assert.deepEqual(result.skipped, [wrapper]);
    assert.deepEqual(result.others, [second]);
  });

  it("count the official npm launcher as the program, and keep the path as found", () => {
    const root = temp("programs-npm");
    const launcher = script(join(root, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"), "#!/usr/bin/env node\n");
    mkdirSync(join(root, "bin"));
    symlinkSync(launcher, join(root, "bin", "codex"));
    const result = found(findProgram("codex", { env: { PATH: join(root, "bin") }, usualDirs: [] }));
    assert.equal(result.path, join(root, "bin", "codex"));
  });

  it("skip files that can't run, and look in the usual install folders after PATH", () => {
    const root = temp("programs-usual");
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "codex"), Buffer.from([0xcf, 0xfa]));
    chmodSync(join(root, "a", "codex"), 0o644);
    const usual = native(join(root, "usual", "codex"));
    const result = found(findProgram("codex", { env: { PATH: join(root, "a") }, usualDirs: [join(root, "usual")] }));
    assert.equal(result.path, usual);
    assert.equal(result.source, "usual folder");
  });

  it("take the adapter's variable first, then config.json, and refuse a given path that is not a program", () => {
    const root = temp("programs-given");
    const onPath = native(join(root, "path", "claude"));
    const fromVariable = native(join(root, "variable", "claude"));
    const fromConfig = script(join(root, "config", "claude"), "#!/bin/sh\n");
    const env = { PATH: join(root, "path"), CLAUDE_CODE_EXECUTABLE: fromVariable };
    assert.equal(found(findProgram("claude", { env, config: { claudePath: fromConfig }, usualDirs: [] })).source, "variable");
    const configured = found(findProgram("claude", { env: { PATH: join(root, "path") }, config: { claudePath: fromConfig }, usualDirs: [] }));
    assert.equal(configured.path, fromConfig, "a path the user gave may be a script");
    assert.equal(found(findProgram("claude", { env: { PATH: join(root, "path") }, usualDirs: [] })).path, onPath);
    const wrong = findProgram("codex", { env: { PATH: join(root, "path"), CODEX_PATH: join(root, "nope") }, usualDirs: [] });
    assert.ok("problem" in wrong);
    assert.match(wrong.problem, /^CODEX_PATH is .*nope, which is not a program file\. Point it at Codex, or remove it\.$/);
  });

  it("say how to install the program when none is found, and which wrappers they passed over", () => {
    const root = temp("programs-none");
    const wrapper = script(join(root, "wrap", "codex"), "#!/bin/bash\n");
    const missing = findProgram("codex", { env: { PATH: join(root, "wrap") }, usualDirs: [join(root, "usual")] });
    assert.ok("problem" in missing);
    assert.match(missing.problem, /^Codex is not installed: no codex program on PATH or in .*usual\./);
    assert.ok(missing.problem.includes(`It passed over ${wrapper}, a wrapper script`));
    assert.ok(missing.problem.includes("Install it with `npm install -g @openai/codex`, or set codexPath in ~/.orchestrator/config.json."));
  });

  it("read the version a program prints", () => {
    const root = temp("programs-version");
    const program = script(join(root, "claude"), "#!/bin/sh\necho '2.1.329 (Claude Code)'\n");
    assert.equal(programVersion(program), "2.1.329");
    assert.equal(programVersion(script(join(root, "codex"), "#!/bin/sh\necho 'codex-cli 0.169.0'\n")), "0.169.0");
    assert.equal(programVersion(join(root, "missing")), undefined);
  });
});

describe("runner and the installed programs", () => {
  it("stops a step whose program is missing, before the agent runner sees it", async () => {
    let calls = 0;
    const runner = createOrcRunner({
      cwd: temp("runner-missing"),
      inner: { run: async () => { calls++; return "ok"; } } as never,
      programs: (program) => ({ program, skipped: [], problem: `${program} is not installed` }),
    });
    await assert.rejects(runner.run("go", { label: "writer", model: "codex/gpt-6.1-sol" } as never), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.message, 'step "writer": codex is not installed');
      assert.equal(error.recoverable, false);
      return true;
    });
    assert.equal(calls, 0);
    // Code steps need none. A Claude Code step needs Claude Code.
    await runner.run(JSON.stringify({ kind: "js", source: "return 1" }), { model: "exec" } as never);
    await assert.rejects(runner.run("go", { label: "other", model: "claude/some-model" } as never), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.message, 'step "other": claude is not installed');
      return true;
    });
    assert.equal(calls, 0);
  });

  it("point the adapter at the program once per run, and report it", async () => {
    const saved = { claude: process.env.CLAUDE_CODE_EXECUTABLE, codex: process.env.CODEX_PATH };
    const looked: Program[] = [];
    const reported: string[] = [];
    try {
      const runner = createOrcRunner({
        cwd: temp("runner-programs"),
        inner: { run: async () => "ok" } as never,
        programs: (program) => {
          looked.push(program);
          return { program, path: `/installed/${program}`, source: "path", skipped: [], others: [] };
        },
        onProgram: ({ program, path }) => reported.push(`${program} ${path}`),
      });
      await runner.run("one", { label: "a", model: "claude/haiku" } as never);
      await runner.run("two", { label: "b", model: "claude/opus" } as never);
      await runner.run("three", { label: "c", model: "codex/gpt-6.1-sol" } as never);
      assert.deepEqual(looked, ["claude", "codex"]);
      assert.deepEqual(reported, ["claude /installed/claude", "codex /installed/codex"]);
      assert.equal(process.env.CLAUDE_CODE_EXECUTABLE, "/installed/claude");
      assert.equal(process.env.CODEX_PATH, "/installed/codex");
    } finally {
      for (const [name, value] of [["CLAUDE_CODE_EXECUTABLE", saved.claude], ["CODEX_PATH", saved.codex]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("look for no program when the caller brings its own runner", async () => {
    const runner = createOrcRunner({ cwd: temp("runner-own"), inner: { run: async () => "ok" } as never });
    assert.equal(await runner.run("go", { label: "a", model: "codex/gpt-6.1-sol" } as never), "ok");
  });
});

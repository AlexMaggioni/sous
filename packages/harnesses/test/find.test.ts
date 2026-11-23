// How each adapter finds its installed program and reads its version. Ported from orc's
// programs test, which tested the same lookup before it moved here.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { createHarness, type Found } from "../src/index.js";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `harness-${name}-`));

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

const found = (lookup: Found): Extract<Found, { path: string }> => {
  assert.ok(!("problem" in lookup), "problem" in lookup ? lookup.problem : "");
  return lookup;
};

describe("installed programs", () => {
  it("take the first program on PATH, passing over wrapper scripts, and name the other copies", () => {
    const root = temp("programs");
    const wrapper = script(join(root, "wrap", "claude"), "#!/bin/bash\nexec claude-launch \"$@\"\n");
    const first = native(join(root, "a", "claude"));
    const second = native(join(root, "b", "claude"));
    const result = found(createHarness("claude", { env: { PATH: [join(root, "wrap"), join(root, "a"), join(root, "b")].join(":") }, usualDirs: [] }).find());
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
    const result = found(createHarness("codex", { env: { PATH: join(root, "bin") }, usualDirs: [] }).find());
    assert.equal(result.path, join(root, "bin", "codex"));
  });

  it("skip files that can't run, and look in the usual install folders after PATH", () => {
    const root = temp("programs-usual");
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "codex"), Buffer.from([0xcf, 0xfa]));
    chmodSync(join(root, "a", "codex"), 0o644);
    const usual = native(join(root, "usual", "codex"));
    const result = found(createHarness("codex", { env: { PATH: join(root, "a") }, usualDirs: [join(root, "usual")] }).find());
    assert.equal(result.path, usual);
    assert.equal(result.source, "usual folder");
  });

  it("take the adapter's variable first, then the configured path, and refuse a given path that is not a program", () => {
    const root = temp("programs-given");
    const onPath = native(join(root, "path", "claude"));
    const fromVariable = native(join(root, "variable", "claude"));
    const fromConfig = script(join(root, "config", "claude"), "#!/bin/sh\n");
    const env = { PATH: join(root, "path"), CLAUDE_CODE_EXECUTABLE: fromVariable };
    assert.equal(found(createHarness("claude", { env, path: fromConfig, usualDirs: [] }).find()).source, "variable");
    const configured = found(createHarness("claude", { env: { PATH: join(root, "path") }, path: fromConfig, usualDirs: [] }).find());
    assert.equal(configured.path, fromConfig, "a path the user gave may be a script");
    assert.equal(configured.source, "config");
    assert.equal(found(createHarness("claude", { env: { PATH: join(root, "path") }, usualDirs: [] }).find()).path, onPath);
    const wrong = createHarness("codex", { env: { PATH: join(root, "path"), CODEX_PATH: join(root, "nope") }, usualDirs: [] }).find();
    assert.ok("problem" in wrong);
    assert.match(wrong.problem, /^CODEX_PATH is .*nope, which is not a program file\. Point it at Codex, or remove it\.$/);
    const badConfig = createHarness("codex", { env: { PATH: join(root, "path") }, path: join(root, "nope"), usualDirs: [] }).find();
    assert.ok("problem" in badConfig);
    assert.match(badConfig.problem, /^The configured path is .*nope, which is not a program file\. Point it at Codex, or remove it\.$/);
    const named = createHarness("codex", { env: { PATH: join(root, "path") }, path: join(root, "nope"), setting: "codexPath in config.json", usualDirs: [] }).find();
    assert.ok("problem" in named);
    assert.match(named.problem, /^codexPath in config\.json is .*nope, which is not a program file\./);
  });

  it("say how to install the program when none is found, and which wrappers they passed over", () => {
    const root = temp("programs-none");
    const wrapper = script(join(root, "wrap", "codex"), "#!/bin/bash\n");
    const missing = createHarness("codex", { env: { PATH: join(root, "wrap") }, usualDirs: [join(root, "usual")] }).find();
    assert.ok("problem" in missing);
    assert.match(missing.problem, /^Codex is not installed: no codex program on PATH or in .*usual\./);
    assert.ok(missing.problem.includes(`It passed over ${wrapper}, a wrapper script`));
    assert.ok(missing.problem.includes("Install it with `npm install -g @openai/codex`, or give its path."));
    const named = createHarness("codex", { env: { PATH: join(root, "wrap") }, setting: "codexPath in config.json", usualDirs: [join(root, "usual")] }).find();
    assert.ok("problem" in named);
    assert.ok(named.problem.endsWith("Install it with `npm install -g @openai/codex`, or set codexPath in config.json."));
  });

  it("read the version a program prints", async () => {
    const root = temp("programs-version");
    const claude = createHarness("claude", { env: {}, usualDirs: [] });
    assert.equal((await claude.version(script(join(root, "claude"), "#!/bin/sh\necho '2.1.329 (Claude Code)'\n"))).version, "2.1.329");
    const codex = createHarness("codex", { env: {}, usualDirs: [] });
    assert.deepEqual(await codex.version(script(join(root, "codex"), "#!/bin/sh\necho 'codex-cli 0.169.0'\n")), { version: "0.169.0" });
    const missing = await claude.version(join(root, "missing"));
    assert.equal(missing.version, undefined);
    assert.match(missing.problem ?? "", /--version printed no version\. Check that it is Claude Code\.$/);
  });
});

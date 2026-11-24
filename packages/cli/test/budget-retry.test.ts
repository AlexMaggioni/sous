// Piece 14, budget, review fix. A step's failed attempts count toward the budget as soon as each
// one ends, so a retry cannot spend the budget again. The fake claude runs in a worker process of
// its own. Its first attempt at "Build" spends 900 tokens in one message and fails with a server
// error, which the run retries. The second attempt writes its tool call, which spent 150 tokens,
// then holds until the file "release" exists. Under --budget 1000 that call brings the go to 1,050
// tokens, so the second attempt is stopped while it runs, the run pauses on it, and the next step
// never starts. Only a cancel during the attempt pauses the run before the test releases it.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readState, testHome } from "@sous/engine/testing";
import { sous } from "./sous.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "SOUS_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];

const TWO = `export const meta = { name: 'two', description: 'two agent steps', place: 'none' }
const built = await agent('Build it.', { label: 'impl', model: 'claude/haiku' })
const checked = await agent('Check it.', { label: 'check', model: 'claude/haiku' })
return [built, checked]`;

describe("piece 14: budget and retries", () => {
  it("a step that spends 900 and fails once, under --budget 1000, pauses on its second attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sous-budget-retry-"));
    process.env.FAKE_LOG = join(dir, "fake.log");
    process.env.FAKE_RULES = join(dir, "rules.json");
    writeFileSync(
      process.env.FAKE_RULES,
      JSON.stringify([
        { match: "Build", times: 1, fail: "overloaded", usage: { input: 700, output: 200 } },
        { match: "Build", tool: "echo working", hold: "release", answer: "Done." },
        { match: "Check", answer: "Checked." },
      ]),
    );
    const { paths, projectDir } = testHome({ two: TWO }, { claudePath: join(FAKES, "claude"), codexPath: join(FAKES, "codex"), retries: 2 });
    const started = await sous(paths, ["run", "two", "--budget", "1000", "--json", "--project", projectDir], { env: {} });
    try {
      assert.equal(started.code, 0, started.out);
      const runId = JSON.parse(started.out).runId as string;
      const waited = await sous(paths, ["wait", runId, "--timeout", "20", "--json"], { env: {} });
      assert.equal(waited.code, 2, `the run paused while the second attempt held: ${waited.out}`);
      const state = readState(paths, runId);
      assert.equal(state?.pauseReason, "budget", waited.out);
      assert.match(state?.reason ?? "", /step "impl" was stopped/, "the run paused on impl, not before check");
      const log = existsSync(process.env.FAKE_LOG) ? readFileSync(process.env.FAKE_LOG, "utf8").split("\n").filter(Boolean) : [];
      const prompts = log.map((line) => (JSON.parse(line) as { prompt?: string }).prompt ?? "");
      assert.equal(prompts.length, 2, `impl ran twice and check never: ${JSON.stringify(prompts)}`);
      assert.ok(
        prompts.every((prompt) => prompt.includes("Build")),
        JSON.stringify(prompts),
      );
    } finally {
      // Let a held attempt end, so a failure leaves no fake waiting.
      writeFileSync(join(dir, "release"), "");
    }
  });
});

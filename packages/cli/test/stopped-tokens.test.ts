// Piece 16. A step stopped while its turn runs keeps the tokens the turn reported. The fake claude
// runs in a worker process of its own. Its turn writes a tool call, whose message spent 150 tokens
// (120 in, 30 out), then holds until the file "release" exists. The step is stopped during the
// hold, once by the budget and once by `sous stop --step`. sous show then gives the step and the
// run those 150 tokens, the same count the budget saw, not a guess from the prompt's length.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HomePaths } from "@sous/engine";
import { readState } from "@sous/engine/testing";
import { heldHome, inToolCall, json, until } from "./helpers/held.js";
import { sous } from "./sous.js";

for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "SOUS_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];

const LONG = "export const meta = { name: 'long', description: 'one long step', place: 'none' }\nreturn await agent('Build it.', { label: 'impl', model: 'claude/haiku' })";
// The tool call's message in the fake claude: 120 input tokens and 30 output tokens.
const TOOL_MESSAGE = 120 + 30;

/** A home whose fake claude holds the step "impl" inside its tool call, and the folder of its gate. */
function holdingHome(): { paths: HomePaths; projectDir: string; dir: string } {
  return heldHome({ long: LONG }, [{ match: "Build", tool: "echo working", hold: "release", answer: "Done." }]);
}

/** The tokens sous show gives the run and its step "impl". */
async function shownTokens(paths: HomePaths, runId: string): Promise<{ run: unknown; step: unknown; shown: string }> {
  const printed = await sous(paths, ["show", runId, "--json"], { env: {} });
  const shown = json(printed);
  const step = (shown.steps as Array<{ label?: string; tokens?: unknown }>).find((entry) => entry.label === "impl");
  return { run: shown.tokens, step: step?.tokens, shown: printed.out };
}

describe("piece 16: a stopped step keeps its tokens", () => {
  it("a step the budget stops mid-turn records the tokens its turn reported, in show for the step and the run", async () => {
    const { paths, projectDir, dir } = holdingHome();
    const started = await sous(paths, ["run", "long", "--budget", "100", "--json", "--project", projectDir], { env: {} });
    try {
      assert.equal(started.code, 0, started.out);
      const runId = json(started).runId as string;
      const waited = await sous(paths, ["wait", runId, "--timeout", "20", "--json"], { env: {} });
      assert.equal(waited.code, 2, waited.out);
      assert.equal(readState(paths, runId)?.pauseReason, "budget", waited.out);
      const { run, step, shown } = await shownTokens(paths, runId);
      assert.equal(step, TOOL_MESSAGE, `the step keeps what its turn spent: ${shown}`);
      assert.equal(run, TOOL_MESSAGE, `the run counts the stopped step's tokens: ${shown}`);
    } finally {
      // Let a held step end, so a failure leaves no fake waiting.
      writeFileSync(join(dir, "release"), "");
    }
  });

  it("a step stopped with sous stop --step mid-turn records the tokens its turn reported", async () => {
    const { paths, projectDir, dir } = holdingHome();
    const started = await sous(paths, ["run", "long", "--json", "--project", projectDir], { env: {} });
    try {
      assert.equal(started.code, 0, started.out);
      const runId = json(started).runId as string;
      // The activity shows the tool call once the turn has reported the message's tokens.
      await until(() => inToolCall(paths, runId, "impl"), "impl to run its tool call");
      const stopped = await sous(paths, ["stop", runId, "--step", "impl", "--json"], { env: {} });
      assert.equal(stopped.code, 0, stopped.out);
      const waited = await sous(paths, ["wait", runId, "--timeout", "20", "--json"], { env: {} });
      assert.equal(waited.code, 2, waited.out);
      const { run, step, shown } = await shownTokens(paths, runId);
      assert.equal(step, TOOL_MESSAGE, `the step keeps what its turn spent: ${shown}`);
      assert.equal(run, TOOL_MESSAGE, `the run counts the stopped step's tokens: ${shown}`);
    } finally {
      writeFileSync(join(dir, "release"), "");
    }
  });
});

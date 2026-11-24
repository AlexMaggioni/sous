// Piece 16, review. A step stopped with `sous stop --step` counts once in the budget, the same
// tokens sous show gives it, while a step beside it still runs. Steps a and b run at once in the
// fake claude, and hold. a holds inside a tool call, whose message spent 150 tokens. a is stopped
// and its program ends. b then answers in one message of 150 tokens. sous show gives the run 300
// tokens. A budget of 301 lets b finish: the run pauses on the stopped a, not on the budget.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readState } from "@sous/engine/testing";
import { heldHome, holdsSlot, inToolCall, json, stepView, until } from "./helpers/held.js";
import { sous } from "./sous.js";

for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "SOUS_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];

const TWO =
  "export const meta = { name: 'two', description: 'two steps at once', place: 'none' }\n" +
  "return await parallel([() => agent('Build A.', { label: 'a', model: 'claude/haiku' }), () => agent('Build B.', { label: 'b', model: 'claude/haiku' })])";
// Each message of the fake claude: 120 input tokens and 30 output tokens.
const MESSAGE = 120 + 30;
// a spent its tool call's message, and b its answer's.
const A = MESSAGE;
const B = MESSAGE;

describe("piece 16: a step stopped beside a running one counts once in the budget", () => {
  it("the budget counts the stopped step as sous show does, so a budget one token above the run's total lets the other step finish", async () => {
    const { paths, projectDir, dir } = heldHome({ two: TWO }, [
      { match: "Build A", tool: "echo a", hold: "releaseA", answer: "A done." },
      { match: "Build B", hold: "releaseB", answer: "B done." },
    ]);
    const budget = A + B + 1;
    const started = await sous(paths, ["run", "two", "--budget", String(budget), "--json", "--project", projectDir], { env: {} });
    try {
      assert.equal(started.code, 0, started.out);
      const runId = json(started).runId as string;
      await until(() => inToolCall(paths, runId, "a"), "a to run its tool call");
      await until(async () => (await stepView(paths, runId, "b"))?.status === "running", "b to run");
      const stopped = await sous(paths, ["stop", runId, "--step", "a", "--json"], { env: {} });
      assert.equal(stopped.code, 0, stopped.out);
      // a's runner reports its last count as its program ends, then gives its slot back.
      await until(async () => !holdsSlot(paths, "a"), "a's program to end");
      writeFileSync(join(dir, "releaseB"), "");
      const waited = await sous(paths, ["wait", runId, "--timeout", "20", "--json"], { env: {} });
      const shown = await sous(paths, ["show", runId, "--json"], { env: {} });
      const view = json(shown);
      const steps = view.steps as Array<{ label?: string; status?: string; tokens?: unknown }>;
      const step = (label: string) => steps.find((entry) => entry.label === label);
      assert.equal(step("a")?.tokens, A, `a keeps what its turn spent: ${shown.out}`);
      assert.equal(step("b")?.status, "done", `the budget never cut b: ${shown.out}`);
      assert.equal(step("b")?.tokens, B, `b ran to its answer: ${shown.out}`);
      assert.equal(view.tokens, A + B, `sous show counts each step once: ${shown.out}`);
      assert.equal(readState(paths, runId)?.pauseReason, "step_stopped", `the run pauses on the stopped step, not on the budget: ${waited.out}`);
    } finally {
      // Let a held step end, so a failure leaves no fake waiting.
      writeFileSync(join(dir, "releaseA"), "");
      writeFileSync(join(dir, "releaseB"), "");
    }
  });
});

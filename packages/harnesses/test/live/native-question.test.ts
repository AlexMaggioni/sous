// Live test of the native question on a step with ask. Each program's agent asks the person a
// question through its own question tool. The adapter refuses the tool, ends the turn and gives
// the question in asked. A resume with the person's answer then goes on.
//
// It is off by default. It needs Claude Code, Codex and your own logins, so run it from
// packages/harnesses without test/with-temp-home.mjs:
//
//   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID SOUS_LIVE_QUESTION=1 ../../node_modules/.bin/tsx --test test/live/native-question.test.ts
//
// Claude Code runs on haiku at low effort, Codex on gpt-6-luna at low effort. Each project is a
// new temporary folder. The programs keep their session files in their own folders, as a session
// opened by hand does.
//
// What the real programs emitted on 2026-11-27.
// Claude Code 2.1.332, after canUseTool denied AskUserQuestion with interrupt true: a user frame
// with an is_error tool_result whose content is Claude Code's own text, "The user doesn't want to
// proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string
// was NOT written to the file). STOP what you are doing and wait for the user to tell you how to
// proceed.", so the model never reads the deny's message. Then a user frame with the text
// "[Request interrupted by user for tool use]", and a result with subtype error_during_execution,
// is_error true, stop_reason tool_use, errors ["[ede_diagnostic] result_type=user
// last_content_type=n/a stop_reason=tool_use"] and the call in permission_denials. The model's
// input held one question with a header and four options. A resume of the session answered.
// Codex 0.169.0, with features.default_mode_request_user_input on: gpt-6-luna sent
// item/tool/requestUserInput with one question and two options. After the adapter answered with
// the refusal and sent turn/interrupt, the turn completed as interrupted with no agent message.
// A resume of the thread answered. With the feature off, the model wrote the question as its
// answer and never called the tool.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { createHarness } from "../../src/index.js";
import type { HarnessId, HistoryEntry, Step, StepResult } from "../../src/index.js";

const ON = process.env.SOUS_LIVE_QUESTION === "1";
const ASK = "Before you do anything, use your tool for asking the user a question to ask me which color I want. Do nothing else.";
const ANSWER = "The person answered: blue. Reply with only the color they chose.";
const MODELS: Record<HarnessId, { model: string; effort: string }> = {
  claude: { model: "haiku", effort: "low" },
  codex: { model: "gpt-6-luna", effort: "low" },
};

/** Runs one step on the program's smallest model, and says what it cost and how long it ran. */
async function step(t: TestContext, id: HarnessId, what: string, fields: Omit<Step, "model" | "effort">): Promise<StepResult> {
  const harness = createHarness(id);
  const start = Date.now();
  const seen: HistoryEntry[] = [];
  const result = await harness.run({ ...fields, ...MODELS[id] }, { history: (entry) => seen.push(entry) });
  t.diagnostic(`${id} ${what}: text ${JSON.stringify(result.text.slice(0, 200))}, asked ${JSON.stringify(result.asked)}, ${result.usage.total} tokens, $${result.usage.costUsd ?? "?"}, ${Date.now() - start} ms`);
  for (const entry of seen.filter((entry) => entry.role !== "user")) t.diagnostic(`  ${entry.role} ${entry.kind} ${entry.toolName ?? ""} ${JSON.stringify(entry.text.slice(0, 300))}`);
  return result;
}

describe("the native question, live", { skip: !ON && "set SOUS_LIVE_QUESTION=1 to run" }, () => {
  for (const id of ["claude", "codex"] as const) {
    test(`${id}: the agent asks through its own tool, the turn ends with asked, and a resume goes on`, async (t) => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), `sous-live-question-${id}-`)));
      const asked = await step(t, id, "ask", { prompt: ASK, cwd, ask: true });
      assert.ok(asked.asked, "the agent did not call its question tool");
      assert.match(asked.asked, /colou?r/i);
      const answered = await step(t, id, "answer", { prompt: ANSWER, cwd, resume: asked.sessionId });
      assert.match(answered.text, /blue/i);
    });
  }
});

// A step's prompt reaches the program as the same bytes a person types in a session opened by
// hand. The step's label goes in the system text, which stays the same on every turn of one
// session. A resume's note follows a plain prompt after a blank line, and goes apart from a slash
// prompt, as the step's note.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { PlannedRequest } from "../src/steps/agent-run.js";
import { createSteps } from "../src/steps/steps.js";
import { runWorkflow } from "../src/workflow.js";
import { fakePlace, onFakes, routed, systemOf } from "./helpers/fake-steps.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const NOTE = "Use the v2 API this time.";
const SCHEMA = Type.Object({ ok: Type.Boolean() });

for (const [harness, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-6.1-sol"],
] as const) {
  describe(`prompts as written on ${harness}`, () => {
    it("sends the prompt bytes exactly, with and without a schema", async () => {
      const place = fakePlace();
      const steps = createSteps(onFakes(place));
      const plain = "  Build part A.\n\nKeep the tests green.\n";
      const shaped = "/canary check the build";
      try {
        await steps.run(plain, routed(steps, { label: "builder", model }));
        await steps.run(shaped, routed(steps, { label: "reporter", model }, { schema: SCHEMA }));
        await steps.run("Say ok.", routed(steps, { label: "checker", model }, { schema: SCHEMA }));
      } finally {
        await steps.dispose();
      }
      const prompts = place.lines().map((line) => line.prompt);
      assert.equal(prompts[0], plain);
      assert.equal(prompts[1], shaped);
      assert.equal(prompts.at(-1), "Say ok.");
    });

    it("puts the label in the system text, the same on two turns of one kept session", async () => {
      const place = fakePlace();
      const agent = createSteps(onFakes(place));
      const script = `export const meta = { name: 'kept', description: 'two turns of one session' }
const impl = session({ label: 'impl', model: '${model}' })
phase('Build')
await impl.send('Build it.')
phase('Review')
await impl.send('Address the review.')
return 'done'`;
      try {
        const result = await runWorkflow(script, { agent, persistLogs: false });
        assert.equal(result.result, "done");
      } finally {
        await agent.dispose();
      }
      const [first, second] = place.lines();
      assert.equal(second?.sessionId, first?.sessionId, "the second step goes on in the first one's session");
      assert.equal(second?.resume, true);
      assert.equal(systemOf(first), "Task label: impl");
      assert.equal(systemOf(second), systemOf(first));
      assert.deepEqual([first?.prompt, second?.prompt], ["Build it.", "Address the review."]);
    });

    it("puts a note on a plain prompt after a blank line", async () => {
      const place = fakePlace();
      const steps = createSteps(onFakes(place, { note: { text: NOTE } }));
      try {
        await steps.run("Build part A.", routed(steps, { label: "a", model }, { runId: "run-note", callIndex: 0, schema: SCHEMA }));
      } finally {
        await steps.dispose();
      }
      const [line] = place.lines();
      assert.equal(line?.prompt, `Build part A.\n\n${NOTE}`);
      assert.equal(line?.texts, undefined, "the note is in the one text block");
    });

    it("sends a note on a slash prompt as a text before it, in the same message", async () => {
      const place = fakePlace();
      const steps = createSteps(onFakes(place, { note: { text: NOTE } }));
      try {
        await steps.run("/x run the check", routed(steps, { label: "a", model }, { runId: "run-note", callIndex: 0 }));
      } finally {
        await steps.dispose();
      }
      const lines = place.lines();
      assert.equal(lines.length, 1, "the note is no turn of its own");
      assert.deepEqual(lines[0]?.texts, [NOTE, "/x run the check"]);
      // Claude Code reads a slash command only from the message's last text block.
      assert.equal(lines[0]?.texts?.at(-1), "/x run the check", "the command is the message's last text, as written");
    });
  });
}

describe("prompts as written on a runner of its own", () => {
  it("gives the runner a slash prompt as written and its note apart", async () => {
    const seen: Array<{ prompt: string; request: PlannedRequest }> = [];
    const steps = createSteps({ cwd: process.cwd(), inner: { run: async (prompt, request) => (seen.push({ prompt, request }), "ok") }, note: { text: NOTE } });
    try {
      await steps.run("/x run the check", routed(steps, { label: "a" }, { runId: "run-note", callIndex: 0 }));
    } finally {
      await steps.dispose();
    }
    assert.equal(seen[0]?.prompt, "/x run the check");
    assert.equal(seen[0]?.request.note, NOTE);
  });
});

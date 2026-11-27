// A slash prompt runs its turn with no schema, since a schema cuts a command such as /goal short.
// A step with a schema then sends a report turn in the same session, with the schema. A plain
// prompt keeps the schema on its own turn.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { AgentSessionRef } from "../src/workflow-result.js";
import { CONTINUATION_INSTRUCTION } from "../src/steps/answer.js";
import { createSteps } from "../src/steps/steps.js";
import { fakePlace, onFakes, routed, wentOn, type FakeLine } from "./helpers/fake-steps.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const REPORT = "Report on the task you were given.";
const SCHEMA = Type.Object({ ok: Type.Boolean(), summary: Type.String() });
/** The property names of the schema a turn got, or null when it got none. */
const fields = (line: FakeLine | undefined) => (line?.schema ? Object.keys((line.schema as { properties: object }).properties).sort() : null);

for (const [harness, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-6.1-sol"],
] as const) {
  describe(`a slash prompt on ${harness}`, () => {
    it("with a schema runs its turn with none, then a report turn with the schema in the same session", async () => {
      const place = fakePlace();
      const steps = createSteps(onFakes(place));
      let value: unknown;
      try {
        value = await steps.run("/canary", routed(steps, { label: "canary", model }, { schema: SCHEMA }));
      } finally {
        await steps.dispose();
      }
      const lines = place.lines();
      assert.equal(lines.length, 2, `two turns: ${JSON.stringify(lines.map((line) => line.prompt))}`);
      const [work, report] = lines;
      assert.deepEqual([work?.prompt, fields(work), work?.resume], ["/canary", null, false]);
      // Claude Code takes a schema once per program, so its report turn resumes the session in a new one.
      assert.deepEqual([report?.prompt, fields(report), wentOn(work, report)], [REPORT, ["ok", "summary"], harness === "claude" ? "resumed" : "held"]);
      assert.equal(report?.sessionId, work?.sessionId);
      assert.deepEqual(value, { ok: true, summary: "fake-summary" });
    });

    it("with no schema runs one turn", async () => {
      const place = fakePlace();
      const steps = createSteps(onFakes(place));
      try {
        assert.equal(await steps.run("/canary", routed(steps, { label: "canary", model })), `Fake ${harness} answer.`);
      } finally {
        await steps.dispose();
      }
      const lines = place.lines();
      assert.deepEqual(
        lines.map((line) => [line.prompt, fields(line)]),
        [["/canary", null]],
      );
    });

    it("continued from its recorded session sends the continuation with no schema, then the report turn", async () => {
      const place = fakePlace();
      let first: AgentSessionRef | undefined;
      const steps = createSteps(onFakes(place));
      try {
        await steps.run("/canary", routed(steps, { label: "canary", model }, { onSessionOpen: (ref: AgentSessionRef) => (first ??= ref) }));
        assert.ok(first);
        await steps.run("/canary", routed(steps, { label: "canary", model }, { schema: SCHEMA, continueFromSession: first }));
      } finally {
        await steps.dispose();
      }
      const [, continued, report] = place.lines();
      assert.deepEqual([continued?.prompt, fields(continued), continued?.sessionId], [CONTINUATION_INSTRUCTION, null, first!.sessionId]);
      assert.deepEqual([report?.prompt, fields(report), report?.sessionId], [REPORT, ["ok", "summary"], first!.sessionId]);
    });
  });

  describe(`a plain prompt on ${harness}`, () => {
    it("with a schema runs one turn with the schema", async () => {
      const place = fakePlace();
      const steps = createSteps(onFakes(place));
      try {
        assert.deepEqual(await steps.run("Say ok.", routed(steps, { label: "plain", model }, { schema: SCHEMA })), { ok: true, summary: "fake-summary" });
      } finally {
        await steps.dispose();
      }
      assert.deepEqual(
        place.lines().map((line) => [line.prompt, fields(line)]),
        [["Say ok.", ["ok", "summary"]]],
      );
    });
  });
}

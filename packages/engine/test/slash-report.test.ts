// A slash prompt runs its turn with no schema, since a schema cuts a command such as /goal short.
// A step with a schema then sends a report turn in the same session, with the schema. A plain
// prompt keeps the schema on its own turn. On Codex a skill's command goes as the skill's $ name.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { AgentSessionRef } from "../src/workflow-result.js";
import { CONTINUE_PROMPT } from "../src/turns/status.js";
import { createSteps } from "../src/steps/steps.js";
import { askedSchema, fakePlace, onFakes, plantSkill, promptOf, routed, said, wentOn, type FakeLine } from "./helpers/fake-steps.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const REPORT = "Report on the task you were given.";
const SCHEMA = Type.Object({ ok: Type.Boolean(), summary: Type.String() });
const keys = (schema: unknown) => (schema ? Object.keys((schema as { properties: object }).properties).sort() : null);
/** The property names of the schema the program got for a turn, or null when it got none. */
const fields = (line: FakeLine | undefined) => keys(line?.schema ?? null);
/** The same for a report turn, which on Claude Code may ask for it in its text. */
const reportFields = (line: FakeLine | undefined) => keys(askedSchema(line));

for (const [harness, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-6.1-sol"],
] as const) {
  describe(`a slash prompt on ${harness}`, () => {
    it("with a schema runs its turn with none, then a report turn with the schema in the same session", async () => {
      const place = fakePlace();
      plantSkill(place, "canary");
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
      assert.deepEqual([work?.prompt, fields(work), work?.resume], [said(harness, "/canary"), null, false]);
      // On Claude Code the report turn asks for its value as JSON in its text, in the same program.
      assert.deepEqual([promptOf(report), reportFields(report), wentOn(work, report)], [REPORT, ["ok", "summary"], "held"]);
      assert.equal(report?.sessionId, work?.sessionId);
      assert.deepEqual(value, { ok: true, summary: "fake-summary" });
    });

    it("with no schema runs one turn", async () => {
      const place = fakePlace();
      plantSkill(place, "canary");
      const steps = createSteps(onFakes(place));
      try {
        assert.equal(await steps.run("/canary", routed(steps, { label: "canary", model })), `Fake ${harness} answer.`);
      } finally {
        await steps.dispose();
      }
      const lines = place.lines();
      assert.deepEqual(
        lines.map((line) => [promptOf(line), fields(line)]),
        [[said(harness, "/canary"), null]],
      );
    });

    // The one rule for a turn that stopped early: a slash step sends its slash prompt again, since
    // a command such as /goal may not outlive the program. The note goes apart, as on a first turn.
    it("continued from its recorded session sends its slash prompt again with no schema, then the report turn", async () => {
      const place = fakePlace();
      plantSkill(place, "canary");
      let first: AgentSessionRef | undefined;
      const steps = createSteps(onFakes(place));
      try {
        await steps.run("/canary", routed(steps, { label: "canary", model }, { onSessionOpen: (ref: AgentSessionRef) => (first ??= ref) }));
      } finally {
        await steps.dispose();
      }
      assert.ok(first);
      const resumed = createSteps(onFakes(place, { note: { text: "Use the main branch." } }));
      try {
        await resumed.run("/canary", routed(resumed, { label: "canary", model }, { schema: SCHEMA, continueFromSession: first }));
      } finally {
        await resumed.dispose();
      }
      const [, continued, report] = place.lines();
      assert.deepEqual([continued?.texts, fields(continued), continued?.sessionId], [["Use the main branch.", said(harness, "/canary")], null, first!.sessionId]);
      assert.ok(!place.lines().some((line) => line.prompt.startsWith(CONTINUE_PROMPT)), "no Continue the task. turn");
      assert.deepEqual([promptOf(report), reportFields(report), report?.sessionId], [REPORT, ["ok", "summary"], first!.sessionId]);
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
        place.lines().map((line) => [promptOf(line), fields(line)]),
        [["Say ok.", ["ok", "summary"]]],
      );
    });
  });
}

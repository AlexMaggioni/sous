// The schema of each turn, in the steps module. A step that runs until done answers with the
// status object. A plain prompt carries the status schema on its own turn. A slash prompt runs
// with no schema, then the report turn asks for the status in the same session. An answer that
// does not fit gets a repair turn, with no cap unless the step sets maxRepairs. A step that runs
// one turn answers with its text, or its own schema's value.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { StepRequest } from "../src/steps/agent-run.js";
import { createSteps } from "../src/steps/steps.js";
import { fakePlace, onFakes, plantSkill, routed, said, wentOn, type FakeLine } from "./helpers/fake-steps.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const REPORT = "Report on the task you were given.";
const SCHEMA = Type.Object({ ok: Type.Boolean(), summary: Type.String() });
const STATUS = ["message", "result", "status"];
const DONE = { untilDone: true } as const;

/** The property names of the schema a turn got, or null when it got none. */
const fields = (line: FakeLine | undefined) => (line?.schema ? Object.keys((line.schema as { properties: object }).properties).sort() : null);
/** The schema the status schema of a turn gives `result`, before its null. */
const resultSchema = (line: FakeLine | undefined) =>
  ((line?.schema as { properties: { result: { anyOf: unknown[] } } }).properties.result.anyOf[0] as { properties?: object; type?: string });

/** Runs one step on the fakes with the given rules, and gives its value and the fakes' turns. */
async function step(prompt: string, fieldsOf: Omit<StepRequest, "route">, rules: object[] = [], model = "claude/haiku") {
  const place = fakePlace(rules);
  plantSkill(place, "canary");
  const steps = createSteps(onFakes(place));
  try {
    const value = await steps.run(prompt, routed(steps, { label: "builder", model }, fieldsOf));
    return { value, lines: place.lines() };
  } finally {
    await steps.dispose();
  }
}

for (const [harness, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-6.1-sol"],
] as const) {
  describe(`a step that runs until done, on ${harness}`, () => {
    it("with a plain prompt and no schema runs one turn with the status schema, whose result is text", async () => {
      const { value, lines } = await step("Build it.", DONE, [{ status: [{ status: "done", result: "Built.", message: null }] }], model);
      assert.deepEqual(
        lines.map((line) => [line.prompt, fields(line)]),
        [["Build it.", STATUS]],
      );
      assert.equal(resultSchema(lines[0]).type, "string");
      assert.deepEqual(value, { status: "done", result: "Built.", message: null });
    });

    it("with a plain prompt and a schema runs one turn with the status schema, whose result is the step's schema", async () => {
      const { value, lines } = await step("Build it.", { ...DONE, schema: SCHEMA }, [], model);
      assert.deepEqual(
        lines.map((line) => [line.prompt, fields(line)]),
        [["Build it.", STATUS]],
      );
      assert.deepEqual(Object.keys(resultSchema(lines[0]).properties ?? {}).sort(), ["ok", "summary"]);
      assert.deepEqual((value as { status: string; result: unknown }).status, "done");
      assert.deepEqual((value as { result: unknown }).result, { ok: true, summary: "fake-summary" });
    });

    it("with a slash prompt and no schema runs its turn with none, then the report turn asks for the status in the same session", async () => {
      const { value, lines } = await step("/canary", DONE, [], model);
      assert.deepEqual(
        lines.map((line, i) => [line.prompt, fields(line), i === 0 ? line.resume : wentOn(lines[0], line)]),
        [
          [said(harness, "/canary"), null, false],
          // Claude Code takes a schema once per program, so its report turn resumes the session in a new one.
          [REPORT, STATUS, harness === "claude" ? "resumed" : "held"],
        ],
      );
      assert.equal(lines[1]?.sessionId, lines[0]?.sessionId);
      assert.equal(resultSchema(lines[1]).type, "string");
      assert.equal((value as { status: string }).status, "done");
      assert.equal(typeof (value as { result: unknown }).result, "string");
    });

    it("with a slash prompt and a schema runs its turn with none, then the report turn with the status schema", async () => {
      const { value, lines } = await step("/canary", { ...DONE, schema: SCHEMA }, [], model);
      assert.deepEqual(
        lines.map((line, i) => [line.prompt, fields(line), i === 0 ? line.resume : wentOn(lines[0], line)]),
        [
          [said(harness, "/canary"), null, false],
          // Claude Code takes a schema once per program, so its report turn resumes the session in a new one.
          [REPORT, STATUS, harness === "claude" ? "resumed" : "held"],
        ],
      );
      assert.equal(lines[1]?.sessionId, lines[0]?.sessionId);
      assert.deepEqual(Object.keys(resultSchema(lines[1]).properties ?? {}).sort(), ["ok", "summary"]);
      assert.deepEqual((value as { result: unknown }).result, { ok: true, summary: "fake-summary" });
    });

    it("with ask false gives no question status", async () => {
      const { lines } = await step("Build it.", { untilDone: true, ask: false }, [], model);
      const status = (lines[0]?.schema as { properties: { status: { anyOf: Array<{ enum?: string[] }> } } }).properties.status.anyOf[0]?.enum;
      assert.deepEqual(status, ["done", "working"]);
    });
  });

  describe(`a step that runs one turn, on ${harness}`, () => {
    it("with a plain prompt and no schema runs one turn with no schema and returns the text", async () => {
      const { value, lines } = await step("Build it.", {}, [], model);
      assert.deepEqual(
        lines.map((line) => [line.prompt, fields(line)]),
        [["Build it.", null]],
      );
      assert.equal(value, `Fake ${harness} answer.`);
    });

    it("with a plain prompt and a schema runs one turn with the step's schema and returns its value", async () => {
      const { value, lines } = await step("Build it.", { schema: SCHEMA }, [], model);
      assert.deepEqual(
        lines.map((line) => [line.prompt, fields(line)]),
        [["Build it.", ["ok", "summary"]]],
      );
      assert.deepEqual(value, { ok: true, summary: "fake-summary" });
    });

    it("with a slash prompt and no schema runs its one turn with no schema and sends no report turn", async () => {
      const { value, lines } = await step("/canary", {}, [], model);
      assert.deepEqual(
        lines.map((line) => [line.prompt, fields(line)]),
        [[said(harness, "/canary"), null]],
      );
      assert.equal(typeof value, "string");
    });

    it("with a slash prompt and a schema sends one report turn for the value, with the step's schema", async () => {
      const { value, lines } = await step("/canary", { schema: SCHEMA }, [], model);
      assert.deepEqual(
        lines.map((line) => [line.prompt, fields(line)]),
        [
          [said(harness, "/canary"), null],
          [REPORT, ["ok", "summary"]],
        ],
      );
      assert.deepEqual(value, { ok: true, summary: "fake-summary" });
    });
  });
}

describe("a status that does not fit", () => {
  it("gets a repair turn with the report prompt and the status schema, in the same session", async () => {
    const { value, lines } = await step("Build it.", DONE, [{ answer: { verdict: "fine" }, times: 1 }]);
    assert.deepEqual(
      lines.map((line, i) => [line.prompt, fields(line), i === 0 ? line.resume : wentOn(lines[0], line)]),
      [
        ["Build it.", STATUS, false],
        [REPORT, STATUS, "held"],
      ],
    );
    assert.equal(lines[1]?.sessionId, lines[0]?.sessionId);
    assert.equal((value as { status: string }).status, "done");
  });

  it("gets a repair turn when it says done with a result that does not fit the step's schema", async () => {
    const { value, lines } = await step("Build it.", { ...DONE, schema: SCHEMA }, [{ status: [{ status: "done", result: { summary: 5 } }], times: 1 }]);
    assert.deepEqual(
      lines.map((line) => line.prompt),
      ["Build it.", REPORT],
    );
    assert.deepEqual((value as { result: unknown }).result, { ok: true, summary: "fake-summary" });
  });

  it("gets repair turns with no cap: five misfits, then a fit", async () => {
    const { value, lines } = await step("Build it.", DONE, [{ answer: { verdict: "fine" }, times: 5 }]);
    assert.deepEqual(
      lines.map((line) => line.prompt),
      ["Build it.", REPORT, REPORT, REPORT, REPORT, REPORT],
    );
    assert.equal(new Set(lines.map((line) => line.sessionId)).size, 1);
    assert.equal((value as { status: string }).status, "done");
  });

  it("fails the step with the limit error after one repair with maxRepairs 1", async () => {
    let error: unknown;
    let lines: FakeLine[] = [];
    const place = fakePlace([{ answer: { verdict: "fine" } }]);
    const steps = createSteps(onFakes(place));
    try {
      await steps.run("Build it.", routed(steps, { label: "builder", model: "claude/haiku" }, { ...DONE, limits: { maxRepairs: 1 } }));
    } catch (thrown) {
      error = thrown;
    } finally {
      await steps.dispose();
      lines = place.lines();
    }
    assert.ok(error instanceof WorkflowError, String(error));
    assert.equal(error.code, WorkflowErrorCode.STEP_LIMIT);
    assert.match(error.message, /maxRepairs/);
    assert.match(error.message, /"builder"/);
    assert.deepEqual(
      lines.map((line) => line.prompt),
      ["Build it.", REPORT],
    );
  });
});

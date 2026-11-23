import assert from "node:assert/strict";
import test from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { runWorkflow } from "../src/workflow.js";
import { parseWorkflowScript } from "../src/workflows/script.js";

// Options no step read are gone. A script that still sets one is refused before any step runs,
// with a message that names it.

function countingRunner(): { runner: AgentRunner; calls: () => number } {
  let calls = 0;
  const runner: AgentRunner = {
    async run<S extends TSchema | undefined = undefined>(): Promise<AgentResult<S>> {
      calls++;
      return "ok" as AgentResult<S>;
    },
  };
  return { runner, calls: () => calls };
}

const REMOVED_STEP_OPTIONS = [
  { option: "meta", value: "{ credsRef: 'vault://qa' }", message: "meta is gone. No harness read it. Remove it from the step." },
  { option: "promptMeta", value: "{ viewport: '1280x800' }", message: "promptMeta is gone. No harness read it. Remove it from the step." },
  {
    option: "resume",
    value: "{ filesystem: 'read-only' }",
    message: "resume is gone. A resume replays the calls that match the recorded ones. Remove it from the step.",
  },
];

for (const { option, value, message } of REMOVED_STEP_OPTIONS) {
  test(`refuses the removed step option ${option}`, async () => {
    const { runner, calls } = countingRunner();
    const script = `export const meta = { name: 'removed', description: 'removed' }
return await agent('p', { label: 'a', ${option}: ${value} })`;
    await assert.rejects(runWorkflow(script, { agent: runner, persistLogs: false }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.message, message);
      return true;
    });
    assert.equal(calls(), 0, "a step with a removed option never reaches the runner");
  });
}

test("refuses a script that declares meta.backends", () => {
  const script = [
    'export const meta = { name: "m", description: "d", backends: { browser: { command: "browser-acp" } } };',
    'return await agent("p", { label: "a" });',
  ].join("\n");
  assert.throws(() => parseWorkflowScript(script), { message: "meta.backends is gone. No step ran on it. Remove it from meta." });
});

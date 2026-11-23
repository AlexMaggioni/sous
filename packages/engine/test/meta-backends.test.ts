import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, StepRequest } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import { runWorkflow } from "../src/workflow.js";
import { parseWorkflowScript } from "../src/workflows/script.js";

// A script may declare meta.backends. The engine checks its shape and runs no step on it.

const BACKENDS_SNIPPET =
  'backends: { browser: { command: "browser-acp", args: ["--headless"], env: { HEADLESS: "1" }, sessionMeta: { mode: "verify" }, structuredOutputTool: false } }';

const SCRIPT_WITH_BACKENDS = [
  `export const meta = { name: "m", description: "d", ${BACKENDS_SNIPPET} };`,
  'return await agent("p", { label: "a", model: "browser" });',
].join("\n");

function capturingRunner(): { runner: AgentRunner; captured: () => StepRequest | undefined } {
  let captured: StepRequest | undefined;
  const runner: AgentRunner = {
    async run<S extends TSchema | undefined = undefined>(
      _prompt: string,
      options?: StepRequest<S>,
    ): Promise<AgentResult<S>> {
      captured = options as StepRequest;
      return "ok" as AgentResult<S>;
    },
  };
  return { runner, captured: () => captured };
}

describe("meta.backends parsing", () => {
  it("accepts a valid backends block and exposes it on parsed meta", () => {
    const { meta } = parseWorkflowScript(SCRIPT_WITH_BACKENDS);
    assert.deepEqual(meta.backends, {
      browser: {
        command: "browser-acp",
        args: ["--headless"],
        env: { HEADLESS: "1" },
        sessionMeta: { mode: "verify" },
        structuredOutputTool: false,
      },
    });
  });

  it("rejects malformed backends blocks with legible messages", () => {
    const bad = (backends: string) =>
      `export const meta = { name: "m", description: "d", backends: ${backends} };\nreturn 1;`;
    assert.throws(() => parseWorkflowScript(bad("[]")), /meta\.backends must be an object/);
    assert.throws(() => parseWorkflowScript(bad('{ b: "cmd" }')), /must be an object with at least \{ command \}/);
    assert.throws(() => parseWorkflowScript(bad("{ b: { command: '' } }")), /command must be a non-empty string/);
    assert.throws(() => parseWorkflowScript(bad('{ b: { command: "x", args: "no" } }')), /args must be an array of strings/);
    assert.throws(() => parseWorkflowScript(bad('{ b: { command: "x", env: ["no"] } }')), /env must be an object of string values/);
    assert.throws(() => parseWorkflowScript(bad('{ b: { command: "x", sessionMeta: 3 } }')), /sessionMeta must be an object/);
    assert.throws(
      () => parseWorkflowScript(bad('{ b: { command: "x", structuredOutputTool: "no" } }')),
      /structuredOutputTool must be a boolean/,
    );
  });
});

describe("meta.backends at run time", () => {
  it("gives no step the declared backends", async () => {
    const { runner, captured } = capturingRunner();
    await runWorkflow(SCRIPT_WITH_BACKENDS, { agent: runner, persistLogs: false });
    assert.equal((captured() as Record<string, unknown> | undefined)?.backends, undefined, "the engine never reads meta.backends into the run");
  });
});

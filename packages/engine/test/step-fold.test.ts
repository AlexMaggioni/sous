import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldStep, type WorkflowAgentSnapshot } from "../src/display.js";
import { WorkflowErrorCode } from "../src/errors.js";

// foldStep is the one rule for turning step events into the step list. The manager and the
// live view in run.ts both call it.

const start = (callIndex: number, label: string) =>
  ({ type: "agentStart", scope: "run", callIndex, label, prompt: `${label} prompt` }) as const;

describe("foldStep", () => {
  it("adds a started step with the next id", () => {
    const steps: WorkflowAgentSnapshot[] = [];
    foldStep(steps, start(0, "a"), "t1");
    foldStep(steps, start(1, "b"), "t2");
    assert.deepEqual(steps.map(({ id, label, status, startedAt }) => ({ id, label, status, startedAt })), [
      { id: 1, label: "a", status: "running", startedAt: "t1" },
      { id: 2, label: "b", status: "running", startedAt: "t2" },
    ]);
  });

  it("starts a listed step again in place", () => {
    const steps: WorkflowAgentSnapshot[] = [];
    foldStep(steps, start(0, "a"), "t1");
    foldStep(steps, { type: "agentEnd", scope: "run", callIndex: 0, error: "no", errorRecord: {} }, "t2");
    foldStep(steps, start(0, "b"), "t3");
    assert.deepEqual(JSON.parse(JSON.stringify(steps)), [
      { id: 1, label: "b", prompt: "b prompt", status: "running", callIndex: 0, scope: "run", startedAt: "t3" },
    ]);
  });

  it("keeps the key order the saved state has, also for a model only the end gives", () => {
    const steps: WorkflowAgentSnapshot[] = [];
    foldStep(steps, start(0, "a"), "t1");
    foldStep(steps, { type: "agentEnd", scope: "run", callIndex: 0, resultPreview: "ok", tokens: 4, model: "m" }, "t2");
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(steps[0]))), [
      "id", "label", "prompt", "status", "model", "callIndex", "scope", "startedAt", "resultPreview", "tokens", "endedAt",
    ]);
  });

  it("settles a running step as done, or as error when the end has an error record", () => {
    const steps: WorkflowAgentSnapshot[] = [];
    foldStep(steps, start(0, "a"), "t1");
    foldStep(steps, start(1, "b"), "t1");
    foldStep(steps, { type: "agentEnd", scope: "run", callIndex: 0, tokens: 4, model: "m" }, "t2");
    foldStep(steps, { type: "agentEnd", scope: "run", callIndex: 1, error: "failed", errorCode: WorkflowErrorCode.AGENT_EXECUTION_ERROR, recoverable: true, errorRecord: {} }, "t3");
    assert.deepEqual(steps.map(({ status, tokens, model, error, errorCode, recoverable, endedAt }) => ({ status, tokens, model, error, errorCode, recoverable, endedAt })), [
      { status: "done", tokens: 4, model: "m", error: undefined, errorCode: undefined, recoverable: undefined, endedAt: "t2" },
      { status: "error", tokens: undefined, model: undefined, error: "failed", errorCode: WorkflowErrorCode.AGENT_EXECUTION_ERROR, recoverable: true, endedAt: "t3" },
    ]);
  });

  it("changes nothing for an end with no running step", () => {
    const steps: WorkflowAgentSnapshot[] = [];
    assert.equal(foldStep(steps, { type: "agentEnd", scope: "run", callIndex: 0 }, "t1"), undefined);
    assert.deepEqual(steps, []);
    foldStep(steps, start(0, "a"), "t1");
    foldStep(steps, { type: "agentEnd", scope: "run", callIndex: 0 }, "t2");
    const before = structuredClone(steps);
    assert.equal(foldStep(steps, { type: "agentEnd", scope: "run", callIndex: 0, error: "late", errorRecord: {} }, "t3"), undefined);
    assert.deepEqual(steps, before);
  });
});

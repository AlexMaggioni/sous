import assert from "node:assert/strict";
import { describe, it } from "node:test";
// wrapError is the engine-local helper. Provider classification is completed by the
// injected runner before errors reach this boundary; the engine consumes typed errors.
import {
  isAbortError,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "../src/errors.js";

describe("wrapError provider-limit classification", () => {
  it("does not infer a provider limit from raw Error.message prose", () => {
    const e = wrapError(new Error("You're out of usage credits. Run /usage-credits to continue."), { agentLabel: "a" });
    assert.equal(e.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.recoverable, true);
    assert.equal(e.resetHint, undefined);
    assert.equal(e.agentLabel, "a");
  });

  it("passes an existing WorkflowError through unchanged", () => {
    const orig = new WorkflowError("nope", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
    assert.equal(wrapError(orig), orig);
  });
});

describe("isAbortError", () => {
  it("uses the structured Error.name discriminant", () => {
    const abort = new Error("The operation was cancelled");
    abort.name = "AbortError";
    assert.equal(isAbortError(abort), true);
    assert.equal(wrapError(abort).code, WorkflowErrorCode.WORKFLOW_ABORTED);
  });

  it("does not reserve WORKFLOW_ABORTED for unrelated message prose", () => {
    const error = new Error("transaction aborted because validation failed");
    assert.equal(isAbortError(error), false);
    assert.equal(wrapError(error).code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  });
});

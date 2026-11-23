import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The shared seam owns the WorkflowError runtime class, structured contexts, and guards.
import {
  isAuthRequired,
  isProviderUsageLimit,
  WorkflowError,
  WorkflowErrorCode,
  type AuthErrorContext,
  type CheckpointContext,
  type ProviderUsageLimitContext,
} from "../../src/errors.js";

describe("isProviderUsageLimit", () => {
  it("is true only for a PROVIDER_USAGE_LIMIT WorkflowError", () => {
    assert.equal(
      isProviderUsageLimit(
        new WorkflowError("x", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false }),
      ),
      true,
    );
    assert.equal(isProviderUsageLimit(new WorkflowError("x", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE)), false);
    assert.equal(isProviderUsageLimit(new Error("usage limit")), false);
    assert.equal(isProviderUsageLimit(undefined), false);
    assert.equal(isProviderUsageLimit("usage limit"), false);
  });
});

describe("isAuthRequired", () => {
  it("is true only for an AUTH_REQUIRED WorkflowError", () => {
    assert.equal(
      isAuthRequired(new WorkflowError("x", WorkflowErrorCode.AUTH_REQUIRED, { recoverable: false })),
      true,
    );
    assert.equal(isAuthRequired(new WorkflowError("x", WorkflowErrorCode.PROVIDER_USAGE_LIMIT)), false);
    assert.equal(isAuthRequired(new WorkflowError("x", WorkflowErrorCode.AGENT_EXECUTION_ERROR)), false);
    assert.equal(isAuthRequired(new Error("authentication required")), false);
    assert.equal(isAuthRequired(undefined), false);
    assert.equal(isAuthRequired("authentication required"), false);
  });
});

describe("WorkflowError", () => {
  it("exposes the cancel error code as a stable wire literal", () => {
    assert.equal(WorkflowErrorCode.AGENT_CANCELLED, "AGENT_CANCELLED");
  });

  // One call per value of recoverable, so a constructor that ignores the option fails the true case.
  for (const recoverable of [false, true]) {
    it(`captures code, recoverable ${recoverable}, resetHint, agentLabel, details and the contexts from options`, () => {
      const providerUsageLimitContext: ProviderUsageLimitContext = {
        backendId: "claude",
        source: "provider",
        providerCode: "rate_limit",
        resetAt: "2026-07-15T08:00:00.000Z",
      };
      const authContext: AuthErrorContext = {
        backendId: "codex",
        methods: [
          { id: "api-key", type: "agent", name: "API Key" },
          { id: "claude-login", type: "terminal" },
        ],
      };
      const checkpointContext: CheckpointContext = {
        callIndex: 2,
        hash: "abc123",
        prompt: "Ship this release?",
        kind: "select",
        choices: ["ship", "hold"],
        timeoutMs: 30_000,
      };
      const e = new WorkflowError("Provider usage limit reached.", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable,
        agentLabel: "researcher",
        resetHint: "Resets in ~3h",
        providerUsageLimitContext,
        authContext,
        checkpointContext,
        details: { provider: "claude" },
      });
      assert.ok(e instanceof Error);
      assert.ok(e instanceof WorkflowError);
      assert.equal(e.name, "WorkflowError");
      assert.equal(e.message, "Provider usage limit reached.");
      assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
      assert.equal(e.recoverable, recoverable);
      assert.equal(e.agentLabel, "researcher");
      assert.equal(e.resetHint, "Resets in ~3h");
      assert.deepEqual(e.providerUsageLimitContext, providerUsageLimitContext);
      assert.deepEqual(e.authContext, authContext);
      assert.deepEqual(e.checkpointContext, checkpointContext);
      assert.deepEqual(e.details, { provider: "claude" });
    });
  }

  it("defaults recoverable to false and leaves optional fields undefined when options omitted", () => {
    const e = new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.recoverable, false);
    assert.equal(e.agentLabel, undefined);
    assert.equal(e.resetHint, undefined);
    assert.equal(e.providerUsageLimitContext, undefined);
    assert.equal(e.authContext, undefined);
    assert.equal(e.checkpointContext, undefined);
    assert.equal(e.details, undefined);
  });
});

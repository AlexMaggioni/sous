import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { StepRequest } from "../src/steps/agent-run.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunLease, RunPersistence } from "../src/runs/persistence/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const script = `export const meta = { name: "managed-continuation", description: "manager continuation" }
return await agent("finish the task", { label: "worker" })`;

function fixture(): {
  cwd: string;
  root: string;
  persistence: RunPersistence;
  states: Map<string, PersistedRunState>;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), "continuation-manager-cwd-"));
  const root = mkdtempSync(join(tmpdir(), "continuation-manager-root-"));
  mkdirSync(root, { recursive: true });
  const states = new Map<string, PersistedRunState>();
  const leases = new Set<string>();
  const persistence: RunPersistence = {
    save(value) {
      states.set(value.runId, structuredClone(value));
    },
    load(runId) {
      const value = states.get(runId);
      return value ? structuredClone(value) : null;
    },
    list() {
      return [...states.values()].map((value) => structuredClone(value));
    },
    delete(runId) {
      return states.delete(runId);
    },
    acquireRunLease(runId) {
      if (leases.has(runId)) return null;
      leases.add(runId);
      return { runId, token: runId };
    },
    releaseRunLease(lease: RunLease) {
      leases.delete(lease.runId);
    },
    validateRunLease() {
      return true;
    },
  };
  return {
    cwd,
    root,
    persistence,
    states,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

class ContinuationRunner implements AgentRunner {
  mode: "usage-pause" | "auth-pause" | "continue" = "usage-pause";
  readonly directives: Array<StepRequest["continueFromSession"]> = [];
  readonly calls: string[] = [];

  async run(prompt: string, options: StepRequest): Promise<string> {
    this.calls.push(prompt);
    if (this.mode === "usage-pause" || this.mode === "auth-pause") {
      options.onSessionOpen?.({
        sessionId: `${this.mode}-session`,
        backendId: "test-backend",
        poolKey: "test-backend",
        cwd: options.cwd ?? "",
        reopen: { load: true, resume: true, list: true },
      });
      // The runner reports the session's cumulative cost gauge at release, error path included.
      options.onSessionCostGauge?.(0.03);
      if (this.mode === "auth-pause") {
        throw new WorkflowError("credentials expired", WorkflowErrorCode.AUTH_REQUIRED, {
          recoverable: false,
          authContext: { backendId: "test-backend", methods: [] },
        });
      }
      throw new WorkflowError("quota exhausted", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable: false,
      });
    }

    this.directives.push(options.continueFromSession);
    if (options.continueFromSession) {
      options.onResultProvenance?.({
        source: "live",
        continuation: { reattached: true, method: "resume" },
      });
      options.onSessionOpen?.({
        ...options.continueFromSession,
        sessionId: `${options.continueFromSession.sessionId}-continued`,
      });
    }
    return options.continueFromSession ? "continued result" : "fresh result";
  }
}

describe("WorkflowManager continuation wiring", () => {
  it("reattaches by default on same-ID resume without a PreparedResume", async () => {
    const test = fixture();
    try {
      const runner = new ContinuationRunner();
      const manager = new WorkflowManager({
        cwd: test.cwd,
        persistence: test.persistence,
        agent: runner,
        environmentKey: "continuation-v1",
      });
      const paused = await manager.runSync(script, undefined, { runId: "same-id" });
      assert.equal(paused.status, "paused");
      assert.equal(paused.reason, "usage_limit");
      runner.mode = "continue";

      const resumed = await manager.resumeInBackground("same-id");
      assert.equal(resumed.accepted, true);
      const completed = await resumed.promise;
      assert.equal(completed.status, "completed");
      assert.equal(completed.result, "continued result");
      assert.equal(runner.directives.length, 1);
      assert.equal(runner.directives[0]?.sessionId, "usage-pause-session");
      assert.equal(runner.directives[0]?.costGauge, 0.03, "the paused call's release-time gauge rides the reattach directive");
      assert.equal(completed.fallbacks?.[0]?.kind, "continuation");
      assert.equal(completed.resumeReport, undefined, "same-ID recovery builds no PreparedResume");
    } finally {
      test.cleanup();
    }
  });

  it("an auth pause resumes from its session", async () => {
    const test = fixture();
    try {
      const runner = new ContinuationRunner();
      runner.mode = "auth-pause";
      const manager = new WorkflowManager({ cwd: test.cwd, persistence: test.persistence, agent: runner });
      const paused = await manager.runSync(script, undefined, { runId: "auth-source" });
      assert.equal(paused.status, "paused");
      assert.equal(paused.reason, "auth_required");
      runner.mode = "continue";

      const resumed = await manager.resumeInBackground("auth-source");
      assert.equal(resumed.accepted, true);
      const completed = await resumed.promise;
      assert.equal(completed.status, "completed");
      assert.equal(runner.directives[0]?.sessionId, "auth-pause-session");
      assert.equal(test.states.get("auth-source")?.resumeSourceRunId, undefined);
    } finally {
      test.cleanup();
    }
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuthErrorContext } from "../src/errors.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunPersistence } from "../src/runs/persistence/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

// PR4 (§2.12/§2.13): the engine generalizes the PROVIDER_USAGE_LIMIT pause branch so an
// AUTH_REQUIRED fault CHECKPOINTS the run as paused (reason "auth_required") carrying the
// structured, non-secret authContext — never the intent's secret payload. These tests drive the
// engine seam with stub runners. steps.test.ts checks that a harness's auth failure on the fake
// programs becomes AUTH_REQUIRED.

const ONE_AGENT = `export const meta = { name: 'auth_pause_demo', description: 'auth pause demo' }
const a = await agent('first', { label: 'first' })
return { a }`;

const AUTH_CONTEXT: AuthErrorContext = {
  backendId: "claude",
  methods: [
    { id: "gateway", type: "agent", name: "Gateway" },
    { id: "claude-login", type: "terminal", name: "Terminal Login" },
  ],
};

/** An in-memory RunPersistence with capture hooks — no fs, deterministic, shareable across
 *  "cold" managers so a fresh manager re-loads a paused run exactly as a new process would. */
function memoryPersistence(): {
  persistence: RunPersistence;
  saves: PersistedRunState[];
  acquired: string[];
  released: string[];
  seed: (state: PersistedRunState) => void;
} {
  const states = new Map<string, PersistedRunState>();
  const saves: PersistedRunState[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const clone = (state: PersistedRunState): PersistedRunState => structuredClone(state);
  return {
    saves,
    acquired,
    released,
    seed(state) {
      states.set(state.runId, clone(state));
    },
    persistence: {
      save(state) {
        const copy = clone(state);
        saves.push(copy);
        states.set(state.runId, copy);
      },
      load(runId) {
        const state = states.get(runId);
        return state ? clone(state) : null;
      },
      list() {
        return [...states.values()].map(clone);
      },
      delete(runId) {
        return states.delete(runId);
      },
      acquireRunLease(runId) {
        acquired.push(runId);
        return { runId, token: `${runId}-lease` };
      },
      releaseRunLease(lease) {
        released.push(lease.runId);
      },
      validateRunLease() {
        return true;
      },
    },
  };
}

/** A runner stub that fails EVERY agent() call with AUTH_REQUIRED carrying the given authContext.
 *  A secret may be attached to the error's `details` — the closest analog to the intent's secret
 *  payload — so we can prove the engine persists ONLY the non-secret authContext, never `details`.
 *  (Upstream PR1 guarantees the MESSAGE itself is secret-free; the engine passes it through.) */
function authRequiredAgent(opts: { authContext: AuthErrorContext; secret?: string } = { authContext: AUTH_CONTEXT }) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    runner: {
      async run() {
        calls++;
        throw new WorkflowError("Authentication required for claude", WorkflowErrorCode.AUTH_REQUIRED, {
          recoverable: false,
          authContext: opts.authContext,
          details: opts.secret ? { apiKey: opts.secret } : undefined,
        });
      },
    },
  };
}

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-auth-pause-"));
    try {
      await fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

test(
  "executeRun pause branch fires for AUTH_REQUIRED → status paused, not failed (§2.12)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const agent = authRequiredAgent();
    const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: agent.runner });

    const result = await manager.runSync(ONE_AGENT);

    assert.equal(result.status, "paused", "AUTH_REQUIRED checkpoints the run as paused");
    assert.equal(result.reason, "auth_required", "composeResult reports reason 'auth_required'");
    assert.equal(result.resetHint, undefined, "resetHint stays usage-limit-only");
    assert.deepEqual(result.authContext, AUTH_CONTEXT, "the structured non-secret authContext rides the result");
  }),
);

test(
  "'paused' event carries reason 'auth_required' + non-secret authContext, resetHint undefined (§2.12)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const agent = authRequiredAgent();
    const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: agent.runner });

    let paused:
      | { runId: string; reason?: string; error?: WorkflowError; resetHint?: unknown; authContext?: AuthErrorContext }
      | undefined;
    manager.on("paused", (ev: typeof paused) => {
      paused = ev;
    });

    const result = await manager.runSync(ONE_AGENT);

    assert.ok(paused, "the paused event fired");
    assert.equal(paused?.runId, result.runId);
    assert.equal(paused?.reason, "auth_required");
    assert.equal(paused?.resetHint, undefined, "resetHint is undefined for an auth pause");
    assert.equal(paused?.error?.code, WorkflowErrorCode.AUTH_REQUIRED);
    assert.deepEqual(paused?.authContext, AUTH_CONTEXT);
  }),
);

test(
  "persistRun writes pauseReason 'auth_required' and keeps authContext non-secret (§2.12/§2.14)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const secret = "sk-SECRET-abc123";
    const agent = authRequiredAgent({ authContext: AUTH_CONTEXT, secret });
    const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: agent.runner });

    const result = await manager.runSync(ONE_AGENT);
    const persisted = store.persistence.load(result.runId);

    assert.equal(persisted?.status, "paused");
    assert.equal(persisted?.pauseReason, "auth_required", "pauseReason switches on the paused error code");
    assert.equal(persisted?.resetHint, undefined, "resetHint stays usage-limit-only");
    assert.deepEqual(persisted?.authContext, AUTH_CONTEXT, "the non-secret authContext is persisted");

    // AUTH_REQUIRED's dedicated authContext remains the deliberately non-secret surface.
    // Gap B separately records every public WorkflowError field in calls[].error;
    // callers must therefore continue to keep credentials out of WorkflowError.details.
    assert.equal(persisted?.calls?.[0]?.error?.form, "workflow-error");
    assert.deepEqual(persisted?.calls?.[0]?.error?.details, { apiKey: secret });
    assert.equal(
      // authContext carries exactly backendId + method ids/types/names — no secret-shaped keys.
      Object.keys(persisted?.authContext ?? {}).sort().join(","),
      "backendId,methods",
    );
  }),
);

test(
  "usage-limit pause is UNCHANGED by the generalization — reason 'usage_limit' + resetHint, no authContext (regression)",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const manager = new WorkflowManager({
      cwd,
      persistence: store.persistence,
      agent: {
        async run() {
          throw new WorkflowError("Codex usage limit reached. Resets in ~3h.", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
            resetHint: "Resets in ~3h",
          });
        },
      },
    });

    let paused: { reason?: string; resetHint?: unknown; authContext?: unknown } | undefined;
    manager.on("paused", (ev: typeof paused) => {
      paused = ev;
    });

    const result = await manager.runSync(ONE_AGENT);
    const persisted = store.persistence.load(result.runId);

    assert.equal(result.status, "paused");
    assert.equal(result.reason, "usage_limit");
    assert.equal(result.resetHint, "Resets in ~3h");
    assert.equal(result.authContext, undefined, "a usage-limit pause carries no authContext");
    assert.equal(paused?.reason, "usage_limit");
    assert.equal(paused?.resetHint, "Resets in ~3h");
    assert.equal(paused?.authContext, undefined);
    assert.equal(persisted?.pauseReason, "usage_limit");
    assert.equal(persisted?.resetHint, "Resets in ~3h");
    assert.equal(persisted?.authContext, undefined);
  }),
);

// ─── Cold resume of a paused run ───

/** Seed a paused "auth_required" run directly, as a fresh (cold) process would re-load it. */
function seedAuthPausedRun(store: ReturnType<typeof memoryPersistence>, runId: string): void {
  const now = new Date().toISOString();
  store.seed({
    runId,
    workflowName: "auth_pause_demo",
    script: ONE_AGENT,
    status: "paused",
    pauseReason: "auth_required",
    authContext: AUTH_CONTEXT,
    phases: [],
    agents: [],
    logs: [],
    journal: [],
    startedAt: now,
    updatedAt: now,
  });
}

/** A runner whose run() succeeds, so "resume proceeds" is observable as the run driving to completion. */
function resumableAgent() {
  let runCalls = 0;
  return {
    get runCalls() {
      return runCalls;
    },
    runner: {
      async run(prompt: string) {
        runCalls++;
        return `ok:${prompt}`;
      },
    },
  };
}

test(
  "cold resume of an auth pause runs the step again, and the run completes once the login is back",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const runId = "cold-auth";
    seedAuthPausedRun(store, runId);
    const agent = resumableAgent();
    const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: agent.runner });

    let resumedEvent = false;
    manager.on("resumed", () => {
      resumedEvent = true;
    });

    const ok = (await manager.resumeInBackground(runId)).accepted;
    assert.equal(ok, true, "resume was accepted");
    assert.equal(resumedEvent, true, "a proceeding resume emits 'resumed'");

    const deadline = Date.now() + 5_000;
    while (manager.getRun(runId)?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(manager.getRun(runId)?.status, "completed", "the auth-paused run resumed and completed");
    assert.ok(agent.runCalls >= 1, "the agent re-executed live");
  }),
);

test(
  "a usage-limit cold resume proceeds and completes",
  withTempCwd(async (cwd) => {
    const store = memoryPersistence();
    const runId = "cold-usage-limit";
    const now = new Date().toISOString();
    store.seed({
      runId,
      workflowName: "auth_pause_demo",
      script: ONE_AGENT,
      status: "paused",
      pauseReason: "usage_limit",
      resetHint: "Resets in ~3h",
      phases: [],
      agents: [],
      logs: [],
      journal: [],
      startedAt: now,
      updatedAt: now,
    });
    const agent = resumableAgent();
    const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: agent.runner });

    const ok = (await manager.resumeInBackground(runId)).accepted;
    assert.equal(ok, true);

    const deadline = Date.now() + 5_000;
    while (manager.getRun(runId)?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(manager.getRun(runId)?.status, "completed", "the usage-limit run resumed normally");
  }),
);

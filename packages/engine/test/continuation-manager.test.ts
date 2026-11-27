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
import { initGitRepo } from "./helpers/git.js";
import { memoryPersistence } from "./helpers/memory-persistence.js";
import { tempPlaces } from "./helpers/places.js";

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

// A resumed run goes on in the same session and the same folder, whatever stopped it, in a nested
// run too and in a step's own worktree (DESIGN.md, workflow-shape, "Resume and the journal").

interface Call {
  prompt: string;
  cwd: string | undefined;
  resumed: string | undefined;
}

/** A runner whose `pauseOn` prompt hits the usage limit once, after its session opened. */
class PausingRunner implements AgentRunner {
  readonly calls: Call[] = [];
  readonly opened = new Map<string, { sessionId: string; cwd: string | undefined }>();
  private paused = false;

  constructor(private readonly pauseOn: string) {}

  async run(prompt: string, options: StepRequest): Promise<string> {
    this.calls.push({ prompt, cwd: options.cwd, resumed: options.continueFromSession?.sessionId });
    if (options.continueFromSession) {
      options.onResultProvenance?.({ source: "live", continuation: { reattached: true, method: "resume" } });
      return `${prompt} went on`;
    }
    const sessionId = `session-${this.calls.length}`;
    this.opened.set(prompt, { sessionId, cwd: options.cwd });
    options.onSessionOpen?.({
      sessionId,
      backendId: "test-backend",
      poolKey: "test-backend",
      cwd: options.cwd ?? "",
      reopen: { load: true, resume: true, list: true },
    });
    if (prompt === this.pauseOn && !this.paused) {
      this.paused = true;
      throw new WorkflowError("quota exhausted", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
    }
    return `${prompt} done`;
  }

  /** The calls made after the first `count`. */
  after(count: number): Call[] {
    return this.calls.slice(count);
  }
}

const child = (place = "") => `\`export const meta = { name: "ticket", description: "one ticket" }
const one = await agent("part one", { label: "one" })
const two = await agent("part two", { label: "two" })
return [one, two]\`, undefined${place ? `, { place: "${place}" }` : ""}`;

const parent = (place = "") => `export const meta = { name: "epic", description: "nested continuation" }
const plan = await agent("plan it", { label: "plan" })
const built = await workflow(${child(place)})
return { plan, built }`;

async function pauseThenResume(script: string, runner: PausingRunner, cwd: string, places?: ReturnType<typeof tempPlaces>) {
  const store = memoryPersistence();
  const manager = new WorkflowManager({
    cwd,
    persistence: store.persistence,
    agent: runner,
    ...(places ? { sous: { places: places.places } } : {}),
  });
  const paused = await manager.runSync(script, undefined, { runId: "epic-run" });
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  assert.equal(paused.reason, "usage_limit");
  const ran = runner.calls.length;
  const resumed = await manager.resumeInBackground("epic-run");
  assert.equal(resumed.accepted, true);
  const completed = await resumed.promise;
  return { completed, ran };
}

describe("continuation in nested runs and worktrees", () => {
  it("a nested run's interrupted call goes on in its session, and no finished call runs again", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-continuation-"));
    try {
      const runner = new PausingRunner("part two");
      const { completed, ran } = await pauseThenResume(parent(), runner, cwd);
      assert.equal(completed.status, "completed", JSON.stringify(completed));
      assert.deepEqual(runner.after(ran), [{ prompt: "part two", cwd, resumed: runner.opened.get("part two")?.sessionId }]);
      assert.equal(JSON.stringify(completed.result), JSON.stringify({ plan: "plan it done", built: ["part one done", "part two went on"] }));
      assert.deepEqual(completed.fallbacks?.map((fallback) => [fallback.kind, fallback.continuation]), [
        ["continuation", { outcome: "reattached", method: "resume" }],
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a step in its own worktree goes on in its session, in the same folder", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-continuation-git-"));
    const places = tempPlaces();
    try {
      initGitRepo(cwd);
      const script = `export const meta = { name: "epic", description: "worktree continuation" }
return await agent("build it", { label: "impl", place: "worktree" })`;
      const runner = new PausingRunner("build it");
      const { completed, ran } = await pauseThenResume(script, runner, cwd, places);
      assert.equal(completed.status, "completed", JSON.stringify(completed));
      const first = runner.opened.get("build it");
      assert.ok(first?.cwd && first.cwd !== cwd, `the step worked in a worktree, not in ${cwd}`);
      assert.deepEqual(runner.after(ran), [{ prompt: "build it", cwd: first.cwd, resumed: first.sessionId }]);
    } finally {
      places.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a nested run in its own worktree goes on in the interrupted call's session and folder", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-continuation-place-"));
    const places = tempPlaces();
    try {
      initGitRepo(cwd);
      const runner = new PausingRunner("part two");
      const { completed, ran } = await pauseThenResume(parent("worktree"), runner, cwd, places);
      assert.equal(completed.status, "completed", JSON.stringify(completed));
      const first = runner.opened.get("part two");
      assert.ok(first?.cwd && first.cwd !== cwd, `the nested run worked in a worktree, not in ${cwd}`);
      assert.deepEqual(runner.after(ran), [{ prompt: "part two", cwd: first.cwd, resumed: first.sessionId }]);
    } finally {
      places.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

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

// A running step's session goes to disk with its call's identity, so a run whose process died
// goes on in that session when it resumes, the same as after a pause.

/** A promise the test opens by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/** The session a test runner reports, as the step runner reports it at open: not delivered yet. */
function testSession(sessionId: string, options: StepRequest) {
  return { sessionId, backendId: "test-backend", poolKey: "test-backend", cwd: options.cwd ?? "", reopen: { load: true, resume: true, list: true } };
}

/** The call identity a call row gives, as a running row saves it. */
const identityOf = (row: { hash: string; inputsHash?: string; path?: string; resolvedCwd?: string }) =>
  JSON.parse(JSON.stringify({ hash: row.hash, inputsHash: row.inputsHash, path: row.path, resolvedCwd: row.resolvedCwd }));

describe("a running step's saved session", () => {
  it("is saved at open, marked not delivered, then again at delivery, and its end removes the call", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "turn-session-saved-"));
    const store = memoryPersistence();
    const reached = [gate(), gate()];
    const go = [gate(), gate()];
    const runner: AgentRunner = {
      async run(_prompt, options) {
        const ref = testSession("live-session", options);
        options.onSessionOpen?.({ ...ref, delivered: false });
        reached[0]!.open();
        await go[0]!.opened;
        options.onSessionOpen?.(ref);
        reached[1]!.open();
        await go[1]!.opened;
        return "done";
      },
    };
    try {
      const manager = new WorkflowManager({ cwd, persistence: store.persistence, agent: runner });
      const { promise } = manager.startInBackground(script, undefined, { runId: "saved-turn" });
      const row = () => store.states.get("saved-turn")?.agents[0];
      await reached[0]!.opened;
      assert.equal(row()?.status, "running");
      assert.equal(row()?.session?.sessionId, "live-session");
      assert.equal(row()?.session?.delivered, false);
      const opened = row()?.call;
      go[0]!.open();
      await reached[1]!.opened;
      assert.equal(row()?.status, "running");
      assert.equal(row()?.session ? "delivered" in row()!.session! : undefined, false, "the delivered session has no mark");
      assert.deepEqual(row()?.call, opened);
      go[1]!.open();
      const completed = await promise;
      assert.equal(completed.status, "completed");
      const saved = store.states.get("saved-turn")!;
      assert.equal(saved.agents[0]?.status, "done");
      assert.equal(saved.agents[0]?.call, undefined, "the step's end removed its call");
      const [callRow] = saved.calls ?? [];
      assert.ok(callRow?.inputsHash && callRow.resolvedCwd === cwd);
      assert.deepEqual(opened, identityOf(callRow), "the saved call is the call row the step ended with");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  const crashed = `export const meta = { name: "crashed", description: "a run whose process died" }
const plan = await agent("plan it", { label: "plan" })
const built = await agent("build it", { label: "build" })
return { plan, built }`;

  const CRASHES = [
    { title: "goes on in its session after the process died", delivered: true, settle: true },
    { title: "runs the step again when its program never had the prompt", delivered: false, settle: true },
    { title: "settles the dead run on its own when it resumes, and goes on in the session", delivered: true, settle: false },
  ];
  for (const { title, delivered, settle } of CRASHES) {
    it(title, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "turn-session-crash-"));
      const first = memoryPersistence();
      const hung = gate();
      const dying: AgentRunner = {
        async run(prompt, options) {
          const ref = testSession(`${prompt}-session`, options);
          options.onSessionOpen?.({ ...ref, delivered: false });
          if (prompt === "plan it" || delivered) options.onSessionOpen?.(ref);
          if (prompt === "plan it") return "planned";
          hung.open();
          return await new Promise<string>((_, reject) => options.signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
        },
      };
      const dead = new WorkflowManager({ cwd, persistence: first.persistence, agent: dying });
      const { promise } = dead.startInBackground(crashed, undefined, { runId: "crashed" });
      try {
        await hung.opened;
        // The state a process that died here left on disk.
        const left = first.states.get("crashed")!;
        assert.equal(left.status, "running");
        const second = memoryPersistence();
        second.seed(left);
        const runner = new PausingRunner("never");
        const manager = new WorkflowManager({ cwd, persistence: second.persistence, agent: runner });

        // `sous resume` calls only resumeInBackground, which settles the run itself.
        if (settle) {
          const reconciled = manager.reconcileExternallyDeadRun("crashed");
          assert.equal(reconciled?.status, "paused");
          assert.equal(reconciled?.pauseReason, "interrupted");
          const build = reconciled?.agents.find((agent) => agent.label === "build");
          assert.equal(build?.status, "error");
          assert.equal(build?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
          assert.equal(build?.call, undefined);
          assert.deepEqual(reconciled?.calls?.map((row) => [row.index, row.outcome]), [[0, "result"], [1, "error"]]);
          assert.deepEqual(identityOf(reconciled!.calls![1]!), left.agents.find((agent) => agent.label === "build")?.call);
          assert.equal(build?.session?.delivered, delivered ? undefined : false);
        }

        const resumed = await manager.resumeInBackground("crashed");
        assert.equal(resumed.accepted, true);
        const completed = await resumed.promise;
        assert.equal(completed.status, "completed", JSON.stringify(completed));
        assert.deepEqual(runner.calls, [{ prompt: "build it", cwd, resumed: delivered ? "build it-session" : undefined }], "the finished step did not run again");
        assert.equal(JSON.stringify(completed.result), JSON.stringify({ plan: "planned", built: delivered ? "build it went on" : "build it done" }));
      } finally {
        dead.stop("crashed");
        await promise.catch(() => {});
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});

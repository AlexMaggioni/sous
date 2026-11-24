import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { JournalEntry, WorkflowCallRecord, WorkflowResumeCallDecision } from "../src/workflow-result.js";
import type { StepRequest } from "../src/steps/agent-run.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  cloneResumeCandidate,
  normalizeResumeSeed,
} from "../src/resume-matcher.js";
import { resumeRows } from "../src/resume-rows.js";
import type { PersistedResumeSeed } from "../src/runs/persistence/run-persistence.js";
import { runWorkflow, type WorkflowResume } from "../src/workflow.js";
import type { RunPlaces } from "../src/places/places.js";
import { tempPlaces } from "./helpers/places.js";
import { git, initGitRepo } from "./helpers/git.js";
import { tempDirs } from "./helpers/temp.js";

const source = (body: string, name = "incremental-engine-resume") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "engine resume integration" }\n${body}`;

const usage = (total: number) => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  cost: 0,
});

interface Recording {
  runId: string;
  calls: WorkflowCallRecord[];
  journal: JournalEntry[];
}

function seedFor(recording: Recording): PersistedResumeSeed {
  const journal = new Map(recording.journal.map((entry) => [entry.index, entry]));
  const promoted = recording.calls.flatMap((call) => {
    const entry = journal.get(call.index);
    if (!entry) return [];
    const candidate = cloneResumeCandidate(recording.runId, entry, call);
    return candidate ? [candidate] : [];
  });
  const seed = normalizeResumeSeed({ sourceRunId: recording.runId, promoted });
  assert.ok(seed);
  return seed;
}

async function record(
  script: string,
  options: {
    runId?: string;
    runner?: AgentRunner;
    confirm?: NonNullable<Parameters<typeof runWorkflow>[1]["confirm"]>;
    cwd?: string;
    concurrency?: number;
    places?: RunPlaces;
  } = {},
): Promise<Recording> {
  const calls: WorkflowCallRecord[] = [];
  const journal: JournalEntry[] = [];
  const runId = options.runId ?? "resume-source";
  await runWorkflow(script, {
    runId,
    agent: options.runner ?? { async run(prompt) { return prompt; } },
    confirm: options.confirm,
    cwd: options.cwd,
    concurrency: options.concurrency,
    places: options.places,
    persistLogs: false,
    onCallRecord: (call) => calls.push(call),
    onAgentJournal: (entry) => journal.push(entry),
  });
  return JSON.parse(JSON.stringify({ runId, calls, journal })) as Recording;
}

function fanout(items: readonly string[], worktree: boolean): string {
  return source(`
const items = ${JSON.stringify(items)}
return await parallel(items.map((item, index) => () => agent(item, {
  label: "item-" + index,
  ${worktree ? 'isolation: "worktree",' : ""}
})))`, worktree ? "worktree-fanout" : "reader-fanout");
}

/** A reuse of the recording by the run `runId`: its calls pair by occurrence with the seed's rows. */
function occurrence(
  seed: PersistedResumeSeed,
  runId: string,
): { resume: WorkflowResume } {
  return {
    resume: {
      rows: resumeRows({ runId, journal: [], calls: [], seed, key: "inputs" }),
      plan: { strategy: "occurrence-v1", sourceRunId: seed.sourceRunId, requestedPolicy: "auto" },
    },
  };
}

describe("PreparedResume occurrence engine integration", () => {
  it("replays moved calls, re-journals current indexes, rebinds sessions, and keeps usage observational", async () => {
    const sourceRunner: AgentRunner = {
      async run(prompt: string, options: StepRequest) {
        options.onUsage?.(usage(5));
        options.onSessionOpen?.({
          sessionId: `session-${prompt}`,
          backendId: "test-backend",
          cwd: "/recorded/cwd",
          reopen: { load: true, resume: true, list: true },
        });
        return `recorded:${prompt}`;
      },
    };
    const recording = await record(source(`
const values = await parallel([
  () => agent("alpha", { label: "alpha", phase: "read" }),
  () => agent("beta", { label: "beta", phase: "read" }),
])
return values`), { runner: sourceRunner });
    const originalSessions = recording.journal.map((entry) => entry.session);
    const decisions: WorkflowResumeCallDecision[] = [];
    const currentJournal: JournalEntry[] = [];
    const runnerPrompts: string[] = [];
    const result = await runWorkflow(source(`
const values = await parallel([
  () => agent("inserted", { label: "inserted", phase: "read" }),
  () => agent("alpha", { label: "alpha", phase: "read" }),
  () => agent("beta", { label: "beta", phase: "read" }),
])
return { values }`), {
      runId: "resume-target",
      agent: {
        async run(prompt: string, options: StepRequest) {
          runnerPrompts.push(prompt);
          options.onUsage?.(usage(7));
          return `live:${prompt}`;
        },
      },
      ...occurrence(seedFor(recording), "resume-target"),
      persistLogs: false,
      onAgentJournal: (entry) => currentJournal.push(entry),
      onResumeDecision: (decision) => decisions.push(decision),
    });

    assert.deepEqual(runnerPrompts, ["inserted"]);
    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
      values: ["live:inserted", "recorded:alpha", "recorded:beta"],
    });
    assert.equal(result.tokenUsage?.total, 7);
    assert.deepEqual(result.resumeReport, {
      strategy: "occurrence-v1",
      sourceRunId: "resume-source",
      requestedPolicy: "auto",
      replayed: 2,
      live: 1,
      failed: 0,
      calls: decisions,
    });
    assert.deepEqual(decisions.map((decision) => [decision.index, decision.action]), [
      [0, "live"],
      [1, "replayed"],
      [2, "replayed"],
    ]);
    assert.deepEqual(decisions.slice(1).map((decision) =>
      decision.action === "replayed" ? decision.match : undefined), ["occurrence", "occurrence"]);
    assert.deepEqual(currentJournal.map((entry) => [entry.index, entry.scope]), [
      [0, "resume-target"],
      [1, "resume-target"],
      [2, "resume-target"],
    ]);
    assert.deepEqual(result.calls?.map((call) => [call.index, call.origin]), [
      [0, "runner"],
      [1, "journal-replay"],
      [2, "journal-replay"],
    ]);
    assert.equal(result.calls?.some((call) => Object.hasOwn(call, "budgetDebit")), false);
    assert.equal(result.resumeReport?.calls.some((call) => Object.hasOwn(call, "logicalBudgetDebit")), false);
    assert.deepEqual(result.agentSessions?.map((session) => [session.callIndex, session.label, session.phase]), [
      [1, "alpha", "read"],
      [2, "beta", "read"],
    ]);
    assert.deepEqual(recording.journal.map((entry) => entry.session), originalSessions);
  });
});

describe("PreparedResume allocation-ordered barriers and fan-out", () => {
  it("replays matching worktrees without making degradation a suffix barrier", async () => {
    const dirs = tempDirs("resume-engine-git");
    initGitRepo(dirs.cwd, "tracked.txt", "clean\n");
    const home = tempPlaces();
    try {
      // Three items keep every case. Each one makes a real git worktree, so more only add time.
      const original = Array.from({ length: 3 }, (_value, index) => `worktree-${index}`);
      const changed = [...original];
      changed[1] = "worktree-1-changed";
      const recording = await record(fanout(original, true), {
        runId: "worktree-source",
        cwd: dirs.cwd,
        concurrency: 1,
        places: home.places("worktree-source"),
      });

      const runnerPrompts: string[] = [];
      const orderedDecisions: number[] = [];
      const result = await runWorkflow(fanout(changed, true), {
        runId: "worktree-success",
        cwd: dirs.cwd,
        concurrency: 2,
        places: home.places("worktree-success"),
        agent: {
          async run(prompt, options) {
            assert.notEqual(options.cwd, dirs.cwd);
            runnerPrompts.push(prompt);
            return `live:${prompt}`;
          },
        },
        ...occurrence(seedFor(recording), "worktree-success"),
        persistLogs: false,
        onResumeDecision: (decision) => orderedDecisions.push(decision.index),
      });
      assert.deepEqual(runnerPrompts, ["worktree-1-changed"]);
      assert.equal(result.resumeReport?.replayed, 2);
      assert.equal(result.resumeReport?.live, 1);
      assert.deepEqual(orderedDecisions, [0, 1, 2]);

      git(dirs.cwd, "branch", "sous/degrade-0-item-0");
      const degraded = [...original];
      degraded[0] = "worktree-0-changed";
      const degradedPrompts: string[] = [];
      const degradedResult = await runWorkflow(fanout(degraded, true), {
        runId: "degrade",
        cwd: dirs.cwd,
        concurrency: 2,
        places: home.places("degrade"),
        agent: { async run(prompt) { degradedPrompts.push(prompt); return `live:${prompt}`; } },
        ...occurrence(seedFor(recording), "degrade"),
        persistLogs: false,
      });
      assert.deepEqual(degradedPrompts, ["worktree-0-changed"]);
      assert.equal(degradedResult.resumeReport?.replayed, 2);
      assert.equal(degradedResult.resumeReport?.live, 1);
      assert.deepEqual(degradedResult.resumeReport?.calls.slice(0, 2).map((decision) =>
        decision.action === "live" ? decision.reason : decision.action), [
        "worktree-degraded",
        "replayed",
      ]);

      const unsafeRecording = await record(fanout(original, true), {
        runId: "unsafe-worktree-source",
        cwd: dirs.cwd,
        concurrency: 1,
        places: home.places("unsafe-worktree-source"),
      });
      let unsafeRunnerCalls = 0;
      const unsafeResult = await runWorkflow(fanout(original, true), {
        runId: "unsafe-worktree-target",
        cwd: dirs.cwd,
        concurrency: 2,
        places: home.places("unsafe-worktree-target"),
        agent: { async run() { unsafeRunnerCalls += 1; return "live"; } },
        ...occurrence(seedFor(unsafeRecording), "unsafe-worktree-target"),
        persistLogs: false,
      });
      assert.equal(unsafeRunnerCalls, 0);
      assert.equal(unsafeResult.resumeReport?.replayed, 3);
      assert.equal(unsafeResult.resumeReport?.live, 0);
    } finally {
      dirs.cleanup();
      home.cleanup();
    }
  });

  it("keeps root replay correspondence across a live nested workflow", async () => {
    const child = source(`return await agent("child", { label: "child" })`, "nested-child");
    const beforeRecording = await record(source(`
return await agent("parent", { label: "parent" })`, "nested-parent"));
    const beforePrompts: string[] = [];
    const beforeResult = await runWorkflow(source(`
await workflow(${JSON.stringify(child)})
return await agent("parent", { label: "parent" })`, "nested-parent"), {
      runId: "before-nested-target",
      agent: {
        async run(prompt) {
          beforePrompts.push(prompt);
          return `live:${prompt}`;
        },
      },
      ...occurrence(seedFor(beforeRecording), "before-nested-target"),
      persistLogs: false,
    });
    assert.deepEqual(beforePrompts, ["child"]);
    assert.equal(beforeResult.resumeReport?.calls[0]?.action, "replayed");

    const betweenRecording = await record(source(`
const first = await agent("first", { label: "first" })
const second = await agent("second", { label: "second" })
return { first, second }`, "nested-between"));
    const betweenPrompts: string[] = [];
    const betweenResult = await runWorkflow(source(`
const first = await agent("first", { label: "first" })
await workflow(${JSON.stringify(child)})
const second = await agent("second", { label: "second" })
return { first, second }`, "nested-between"), {
      runId: "between-nested-target",
      agent: { async run(prompt) { betweenPrompts.push(prompt); return `live:${prompt}`; } },
      ...occurrence(seedFor(betweenRecording), "between-nested-target"),
      persistLogs: false,
    });
    assert.deepEqual(betweenPrompts, ["child"]);
    assert.deepEqual(betweenResult.resumeReport?.calls.map((decision) => decision.action), [
      "replayed",
      "replayed",
    ]);
  });
});

describe("PreparedResume checkpoint integration", () => {
  it("replays a moved proven host decision and re-journals its current index", async () => {
    const recording = await record(source(`
return await checkpoint("approve", { kind: "confirm", timeoutMs: 50 })`), {
      confirm: async () => ({ approved: true }),
    });
    const journal: JournalEntry[] = [];
    let confirms = 0;
    const result = await runWorkflow(source(`
await agent("inserted", { label: "inserted" })
return await checkpoint("approve", { kind: "confirm", timeoutMs: 50 })`), {
      runId: "checkpoint-target",
      agent: { async run() { return "inserted"; } },
      confirm: async () => { confirms += 1; return false; },
      ...occurrence(seedFor(recording), "checkpoint-target"),
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    });

    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { approved: true });
    assert.equal(confirms, 0);
    assert.deepEqual(result.resumeReport?.calls, [
      { index: 0, kind: "agent", action: "live", reason: "not-recorded" },
      {
        index: 1,
        kind: "checkpoint",
        action: "replayed",
        sourceRunId: "resume-source",
        recordedIndex: 0,
        match: "occurrence",
      },
    ]);
    assert.equal(result.calls?.[1].replay?.checkpointHostDecision, true);
    assert.deepEqual(journal.map((entry) => [entry.index, entry.kind, entry.scope]), [
      [0, "agent", "checkpoint-target"],
      [1, "checkpoint", "checkpoint-target"],
    ]);
  });

  it("keeps later rows after an explicit answer and while an unanswered checkpoint pauses", async () => {
    const recording = await record(source(`
const decision = await checkpoint("source-decision", {})
const later = await agent("later", { label: "later" })
return { decision, later }`), { confirm: async () => true });

    const confirmResult = await runWorkflow(source(`
const decision = await checkpoint("changed-decision", {})
const later = await agent("later", { label: "later" })
return { decision, later }`), {
      runId: "confirm-barrier-target",
      agent: { async run(prompt) { return `live:${prompt}`; } },
      confirm: async () => {
        return false;
      },
      ...occurrence(seedFor(recording), "confirm-barrier-target"),
      persistLogs: false,
    });
    assert.deepEqual(confirmResult.resumeReport?.calls.map((decision) =>
      decision.action === "live" ? decision.reason : decision.action), ["not-recorded", "replayed"]);

    const waitingSeed = seedFor(recording);
    let waitingRunnerCalls = 0;
    await assert.rejects(runWorkflow(source(`
const decision = await checkpoint("changed-decision")
const later = await agent("later", { label: "later" })
return { decision, later }`), {
      runId: "waiting-target",
      agent: { async run() { waitingRunnerCalls += 1; return "must-not-run"; } },
      ...occurrence(waitingSeed, "waiting-target"),
      persistLogs: false,
    }), (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_REQUIRED);
    assert.equal(waitingRunnerCalls, 0);
    assert.equal(waitingSeed.candidates.length, 2);
  });
});

describe("PreparedResume empty output", () => {
  it("runs live a step whose recorded text is blank, unless the step has a schema", async () => {
    const script = source(`
const plain = await agent("plain", { label: "plain" })
const shaped = await agent("shaped", { label: "shaped", schema: { type: "string" } })
return { plain, shaped }`);
    const recording = await record(script);
    for (const entry of recording.journal) entry.result = "  \n";
    const prompts: string[] = [];
    const result = await runWorkflow(script, {
      runId: "blank-target",
      agent: { async run(prompt) { prompts.push(prompt); return `live:${prompt}`; } },
      ...occurrence(seedFor(recording), "blank-target"),
      persistLogs: false,
    });
    assert.deepEqual(prompts, ["plain"]);
    assert.deepEqual(result.resumeReport?.calls.map((decision) =>
      decision.action === "live" ? decision.reason : decision.action), ["empty-output", "replayed"]);
  });
});

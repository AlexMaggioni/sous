import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CheckpointContext } from "../src/errors.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { projectRunEventForPersistence } from "../src/run-observability.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import type { WorkflowCallRecord } from "../src/workflow-result.js";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";
import { journalResume } from "./helpers/journal-resume.js";
import { memoryPersistence } from "./helpers/memory-persistence.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

const DURABLE_PROMPT = "Choose release action";
const DURABLE_CHOICES = ["ship", "hold"];
const DURABLE_SCRIPT = `export const meta = { name: 'durable-checkpoint', description: 'durable checkpoint' }
const prefix = await agent('before', { label: 'before' })
const decision = await ask('${DURABLE_PROMPT}', {
  choices: ['ship', 'hold'],
})
const after = await agent('after:' + decision, { label: 'after' })
return { prefix, decision, after }`;

function recordingAgent() {
  const prompts: string[] = [];
  return {
    prompts,
    runner: {
      async run(prompt: string) {
        prompts.push(prompt);
        return `agent:${prompt}`;
      },
    },
  };
}

function withTempPersistenceRoot(fn: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "sous-durable-checkpoint-"));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function withTempPersistenceDirs(fn: (root: string, cwd: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "sous-durable-checkpoint-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "sous-durable-checkpoint-cwd-"));
    try {
      await fn(root, cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

// ask() returns text: a string answer as it is, no answer as "", and any other answer as its JSON.
function askText(answer: unknown): string {
  return typeof answer === "string" ? answer : answer === undefined || answer === null ? "" : JSON.stringify(answer);
}

for (const answer of [false, null, "", 0, { approved: true }]) {
  test(`ask(): preserves the explicit answer ${JSON.stringify(answer)}`, async () => {
    const journal: JournalEntry[] = [];
    const result = await runWorkflow(`export const meta = { name: 'c', description: 'checkpoint' }
return await ask('Proceed?')`, {
      agent: noopAgent, persistLogs: false, confirm: async () => answer,
      onAgentJournal: entry => journal.push(entry),
    });
    assert.equal(result.result, askText(answer));
    assert.deepEqual(journal[0].result, answer);
    assert.deepEqual(result.checkpointsTaken?.[0].decision, answer);
    assert.equal(journal[0].checkpointDecision, "explicit-v1");
    assert.equal(result.calls?.[0].checkpointDecision, "explicit-v1");
    assert.equal(result.checkpointsTaken?.[0].source, "live");
  });
}

for (const channel of ["absent", "undefined", "rejected"] as const) {
  test(`ask(): ${channel} answer channel pauses even when the script catches`, async () => {
    let dispatched = 0;
    const journal: JournalEntry[] = [];
    const confirm = channel === "absent" ? undefined : channel === "undefined" ? async () => undefined
      : async () => { throw new Error("panel dismissed"); };
    await assert.rejects(runWorkflow(`export const meta = { name: 'c', description: 'checkpoint' }
try { await ask('Proceed?') } catch {}
try { await agent('must not run') } catch {}
return 'must not complete'`, {
      agent: { async run() { dispatched++; return "unsafe"; } }, persistLogs: false, confirm,
      onAgentJournal: entry => journal.push(entry),
    }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.CHECKPOINT_REQUIRED);
      assert.equal(error.checkpointContext?.prompt, "Proceed?");
      assert.equal(error.checkpointContext?.kind, "input");
      assert.equal(Object.hasOwn(error.checkpointContext!, "timeoutMs"), false);
      assert.equal(Object.hasOwn(error.checkpointContext!, "default"), false);
      return true;
    });
    assert.equal(dispatched, 0);
    assert.deepEqual(journal, []);
  });
}

test("checkpoint-only completion reports zero agents while retaining its separate call count", async () => {
  const result = await runWorkflow(`export const meta = { name: "checkpoint-count", description: "no agent work" };
return await ask("Continue?");`, { agent: noopAgent, persistLogs: false, confirm: async () => true });
  assert.equal(result.agentCount, 0);
  assert.equal(result.calls?.length, 1);
  const persisted = projectRunEventForPersistence({
    type: "complete", runId: result.runId, scope: result.runId, result: { ...result, status: "completed" },
  });
  assert.equal(persisted.event.type, "complete");
  if (persisted.event.type !== "complete") assert.fail("expected completion summary");
  assert.equal(persisted.event.summary.agentCount, 0);
  assert.equal(persisted.event.summary.callCount, 1);
});

test("ask(): explicit cancellation interrupts an unanswered SDK callback", async () => {
  const controller = new AbortController();
  let opened!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const running = runWorkflow(`export const meta = { name: 'c', description: 'checkpoint' }
return await ask('Proceed?')`, {
    agent: noopAgent, persistLogs: false, signal: controller.signal,
    confirm: () => { opened(); return new Promise(() => {}); },
  });
  await ready;
  controller.abort();
  await assert.rejects(running, (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED);
});

const INVALID_REPLY_SCRIPT = `export const meta = { name: "invalid-checkpoint-answer", description: "must wait for valid JSON" };
let answer;
try { answer = await ask("Approve?"); } catch {}
try { await agent("after explicit answer"); } catch {}
return answer;`;

// The reply is checked in the call, so the cases below run in memory. Only the function reply
// goes through a manager on disk, for the cold resume. That half never reads the invalid reply.
test("ask(): invalid function reply cannot be caught to bypass and can resume cold", withTempPersistenceDirs(async (persistenceRoot, cwd) => {
  let dispatched = 0;
  const runner = { async run() { dispatched++; return "done"; } };
  const first = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
  const paused = await first.runSync(INVALID_REPLY_SCRIPT, undefined, { confirm: async () => () => true });
  assert.equal(paused.status, "paused");
  assert.equal(paused.reason, "checkpoint_required");
  assert.equal(paused.checkpointContext?.callIndex, 0);
  assert.equal(dispatched, 0, "invalid confirmation cannot authorize later live work");
  const persisted = first.getPersistence().load(paused.runId)!;
  assert.deepEqual(persisted.journal, []);
  assert.equal(persisted.calls?.[0].checkpointDecision, undefined);

  const cold = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
  const resumed = await cold.resumeInBackground(paused.runId, { confirm: async () => false });
  assert.equal(resumed.accepted, true);
  if (!resumed.accepted) assert.fail("a later explicit valid reply should continue");
  const completed = await resumed.promise;
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, askText(false));
  assert.equal(dispatched, 1);
  assert.equal(cold.getPersistence().load(paused.runId)?.journal?.[0].checkpointDecision, "explicit-v1");
  assert.equal(cold.getPersistence().load(paused.runId)?.journal?.[0].result, false);
}));

for (const [label, invalidReply] of [
  ["non-finite number", () => Number.NaN],
  ["undefined property", () => ({ approved: undefined })],
  ["cyclic object", () => { const value: { self?: unknown } = {}; value.self = value; return value; }],
] as const) {
  test(`ask(): invalid ${label} reply cannot be caught to bypass`, async () => {
    let dispatched = 0;
    const journal: JournalEntry[] = [];
    const calls: WorkflowCallRecord[] = [];
    await assert.rejects(runWorkflow(INVALID_REPLY_SCRIPT, {
      agent: { async run() { dispatched++; return "unsafe"; } }, persistLogs: false, confirm: async () => invalidReply(),
      onAgentJournal: entry => journal.push(entry), onCallRecord: record => calls.push(record),
    }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.CHECKPOINT_REQUIRED);
      assert.equal(error.checkpointContext?.callIndex, 0);
      return true;
    });
    assert.equal(dispatched, 0, "invalid confirmation cannot authorize later live work");
    assert.deepEqual(journal, []);
    assert.deepEqual(calls.map((call) => [call.index, call.outcome, call.checkpointDecision]), [[0, "error", undefined]]);
  });
}

test("ask(): replays the journaled reply on resume (no re-prompt)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const r = await ask('Approve?', {})
return { r }`;
  const journal = new Map<number, JournalEntry>();
  const first = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async () => "approved",
    onAgentJournal: (e) => journal.set(e.index, e),
  });
  assert.equal(first.result.r, "approved");

  let calledAgain = false;
  const second = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    ...journalResume(journal),
    confirm: async () => {
      calledAgain = true;
      return "DIFFERENT";
    },
  });
  assert.equal(second.result.r, "approved", "reply replays from the journal");
  assert.equal(calledAgain, false, "confirm is not called again on resume");
  assert.deepEqual(second.checkpointsTaken, [
    { callIndex: 0, kind: "input", decision: "approved", source: "journal-replay" },
  ]);
});

test("checkpoints preserve actual authored routes across cold continuation", withTempPersistenceDirs(async (persistenceRoot, cwd) => {
  const models: Array<string | undefined> = [];
  const runner = { async run(_prompt: string, options?: { model?: string }) { models.push(options?.model); return "done"; } };
  const script = `export const meta = { name: "checkpoint-routing", description: "authored routes after a gate" }
await agent("before", { model: "claude/first" })
await ask("Continue?")
return await agent("after", { model: "codex/second" })`;
  const first = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
  const paused = await first.runSync(script);
  assert.equal(paused.status, "paused");
  assert.deepEqual(models, ["claude/first"]);
  const cold = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
  const resumed = await cold.resumeInBackground(paused.runId, { confirm: async () => true });
  assert.equal(resumed.accepted, true);
  if (!resumed.accepted) assert.fail("explicit answer should continue");
  const completed = await resumed.promise;
  assert.equal(completed.status, "completed");
  assert.equal(completed.agentCount, 2);
  assert.deepEqual(models, ["claude/first", "codex/second"]);
}));

test("ask(): counts against maxAgents (no tokens, but bounded)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await ask('a')
await ask('b')
await ask('c')
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false, maxAgents: 2, confirm: async () => 1 }), /limit/i);
});

test(
  "durable checkpoint: pause context and prefix persist; cold confirm resume journals the answer permanently",
  withTempPersistenceRoot(async (persistenceRoot) => {
    const store = memoryPersistence();
    const firstAgent = recordingAgent();
    const manager1 = new WorkflowManager({
      agent: firstAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let pausedEvent:
      | { reason?: string; checkpointContext?: CheckpointContext; authContext?: unknown; resetHint?: unknown }
      | undefined;
    manager1.on("paused", (event: typeof pausedEvent) => {
      pausedEvent = event;
    });

    const paused = await manager1.runSync(DURABLE_SCRIPT);
    const context = paused.checkpointContext;
    const expectedHash = createHash("sha256")
      .update(JSON.stringify({ promptText: DURABLE_PROMPT, kind: "select", choices: DURABLE_CHOICES }))
      .digest("hex");

    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "checkpoint_required");
    assert.ok(context, "the terminal result carries checkpointContext");
    assert.equal(context.callIndex, 1);
    assert.equal(context.hash, expectedHash);
    assert.equal(context.prompt, DURABLE_PROMPT);
    assert.equal(context.kind, "select");
    assert.deepEqual(Array.from(context.choices ?? []), DURABLE_CHOICES);
    assert.equal(Object.hasOwn(context, "default"), false);
    assert.equal(paused.authContext, undefined);
    assert.equal(paused.resetHint, undefined);
    assert.equal(paused.checkpointsTaken, undefined, "a checkpoint that pauses has not resolved");
    assert.equal(pausedEvent?.reason, "checkpoint_required");
    assert.deepEqual(pausedEvent?.checkpointContext, context);
    assert.equal(pausedEvent?.authContext, undefined);
    assert.equal(pausedEvent?.resetHint, undefined);
    assert.deepEqual(firstAgent.prompts, ["before"]);

    const persistedPause = store.persistence.load(paused.runId);
    assert.equal(persistedPause?.status, "paused");
    assert.equal(persistedPause?.pauseReason, "checkpoint_required");
    assert.deepEqual(persistedPause?.checkpointContext, structuredClone(context));
    assert.equal(persistedPause?.journal?.length, 1, "the completed agent prefix remains journaled");
    assert.equal(persistedPause?.journal?.[0]?.index, 0);
    assert.equal(persistedPause?.journal?.[0]?.result, "agent:before");

    // Fresh manager instance: the resuming call answers through its own confirm, as sous does.
    const resumedAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: resumedAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let liveAsks = 0;
    const resumed = await manager2.resumeInBackground(paused.runId, {
      confirm: async () => {
        liveAsks++;
        return "ship";
      },
    });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the cold resume should be accepted");
    const completed = await resumed.promise;

    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.checkpointsTaken, [
      { callIndex: context.callIndex, kind: "select", decision: "ship", source: "live" },
    ]);
    assert.equal(field(completed.result, "prefix"), "agent:before");
    assert.equal(field(completed.result, "decision"), "ship");
    assert.equal(field(completed.result, "after"), "agent:after:ship");
    assert.equal(liveAsks, 1, "the resumed run asks the paused checkpoint once");
    assert.deepEqual(resumedAgent.prompts, ["after:ship"], "the prefix replayed and only new work ran live");

    const finalState = store.persistence.load(paused.runId);
    assert.equal(finalState?.status, "completed");
    const replyEntry = finalState?.journal?.find((entry) => entry.index === context.callIndex);
    assert.deepEqual(
      { index: replyEntry?.index, hash: replyEntry?.hash, result: replyEntry?.result, kind: replyEntry?.kind, scope: replyEntry?.scope },
      { index: context.callIndex, hash: context.hash, result: "ship", kind: "checkpoint", scope: paused.runId },
      "the confirmed decision is in the final persisted journal",
    );
    assert.deepEqual(replyEntry?.call, { kind: "checkpoint", label: "checkpoint", phase: undefined });
    assert.deepEqual(finalState?.checkpointsTaken, completed.checkpointsTaken);
  }),
);

test(
  "durable checkpoint: real filesystem persistence survives a fresh-manager confirm resume",
  withTempPersistenceDirs(async (persistenceRoot, cwd) => {
    const firstAgent = recordingAgent();
    const manager1 = new WorkflowManager({
      agent: firstAgent.runner,
      cwd,
      persistenceRoot,
    });

    const paused = await manager1.runSync(DURABLE_SCRIPT);
    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "checkpoint_required");
    const context = paused.checkpointContext;
    assert.ok(context, "the filesystem-persisted pause exposes its checkpoint context");
    assert.deepEqual(firstAgent.prompts, ["before"]);
    assert.equal(manager1.getPersistence().load(paused.runId)?.status, "paused");

    const resumedAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: resumedAgent.runner,
      cwd,
      persistenceRoot,
    });
    const resumed = await manager2.resumeInBackground(paused.runId, {
      confirm: async () => "ship",
    });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the fresh manager should load and resume the on-disk pause");
    const completed = await resumed.promise;

    assert.equal(completed.status, "completed");
    assert.equal(field(completed.result, "decision"), "ship");
    assert.equal(field(completed.result, "after"), "agent:after:ship");
    assert.deepEqual(resumedAgent.prompts, ["after:ship"]);

    const listed = manager2.getPersistence().list().find((run) => run.runId === paused.runId);
    const loaded = manager2.getPersistence().load(paused.runId);
    assert.equal(listed?.status, "completed", "the filesystem listing exposes the terminal state");
    assert.equal(loaded?.status, "completed", "a direct filesystem load exposes the terminal state");
    const replyEntry = loaded?.journal?.find((entry) => entry.index === context.callIndex);
    assert.deepEqual(
      { index: replyEntry?.index, hash: replyEntry?.hash, result: replyEntry?.result, kind: replyEntry?.kind, scope: replyEntry?.scope },
      { index: context.callIndex, hash: context.hash, result: "ship", kind: "checkpoint", scope: paused.runId },
      "the confirmed checkpoint answer is durably journaled on disk",
    );
    assert.deepEqual(replyEntry?.call, { kind: "checkpoint", label: "checkpoint" });
  }),
);

test(
  "durable checkpoint: cold resume without a reply or live confirm pauses again at the same question",
  withTempPersistenceRoot(async (persistenceRoot) => {
    const store = memoryPersistence();
    const firstAgent = recordingAgent();
    const manager1 = new WorkflowManager({
      agent: firstAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    const first = await manager1.runSync(DURABLE_SCRIPT);
    assert.equal(first.status, "paused");
    assert.ok(first.checkpointContext);

    const coldAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: coldAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let rePaused: { reason?: string; checkpointContext?: CheckpointContext; error?: WorkflowError } | undefined;
    manager2.on("paused", (event: typeof rePaused) => {
      rePaused = event;
    });

    const resumed = await manager2.resumeInBackground(first.runId);
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the resume should be accepted");
    await assert.rejects(
      resumed.promise,
      (error: unknown) =>
        error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_REQUIRED,
    );

    assert.deepEqual(coldAgent.prompts, [], "the step before the question replays, and no agent runs");
    assert.equal(rePaused?.reason, "checkpoint_required");
    assert.equal(rePaused?.error?.code, WorkflowErrorCode.CHECKPOINT_REQUIRED);
    // The live context's choices come from the script's realm, so the check compares plain copies.
    assert.deepEqual(JSON.parse(JSON.stringify(rePaused?.checkpointContext)), structuredClone(first.checkpointContext));
    const saved = store.persistence.load(first.runId);
    assert.equal(saved?.status, "paused");
    assert.equal(saved?.pauseReason, "checkpoint_required");
    assert.deepEqual(saved?.checkpointContext, structuredClone(first.checkpointContext));
  }),
);

test(
  "durable checkpoint: cold resume can answer through a live confirm channel",
  withTempPersistenceRoot(async (persistenceRoot) => {
    const store = memoryPersistence();
    const manager1 = new WorkflowManager({
      agent: recordingAgent().runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    const first = await manager1.runSync(DURABLE_SCRIPT);
    assert.equal(first.status, "paused");

    const liveAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: liveAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let asks = 0;
    const resumed = await manager2.resumeInBackground(first.runId, {
      confirm: async (prompt) => {
        asks++;
        assert.equal(prompt, DURABLE_PROMPT);
        return "hold";
      },
    });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the live-confirm resume should be accepted");
    const completed = await resumed.promise;

    assert.equal(completed.status, "completed");
    assert.equal(field(completed.result, "decision"), "hold");
    assert.equal(asks, 1);
    assert.deepEqual(completed.checkpointsTaken, [
      { callIndex: first.checkpointContext?.callIndex, kind: "select", decision: "hold", source: "live" },
    ]);
    assert.deepEqual(liveAgent.prompts, ["after:hold"]);
    const context = first.checkpointContext;
    assert.ok(context);
    assert.equal(
      store.persistence.load(first.runId)?.journal?.find((entry) => entry.index === context.callIndex)?.result,
      "hold",
    );
  }),
);

// Piece 8, questions. Who may answer stays out of the call hash, as the breakpoint mark does: a
// question asked before an author set answeredBy keeps its hash, and its answer still counts. The
// mark reaches the host as the purpose { answeredBy: "anyone" }.
test("piece 8: the call hash is the same with and without answeredBy, and ask anyone reaches confirm marked", async () => {
  const seen: Array<{ hash?: string; purpose?: unknown }> = [];
  const confirm = async (_prompt: string, _options: unknown, context?: { hash: string; purpose?: unknown }) => {
    seen.push({ hash: context?.hash, purpose: context?.purpose === undefined ? undefined : JSON.parse(JSON.stringify(context.purpose)) });
    return "blue";
  };
  for (const options of ["{ choices: ['red', 'blue'] }", "{ choices: ['red', 'blue'], answeredBy: 'anyone' }"]) {
    await runWorkflow(`export const meta = { name: 'p8-hash', description: 'p8' }
return await ask('Which color?', ${options})`, { agent: noopAgent, persistLogs: false, confirm });
  }
  const expected = createHash("sha256").update(JSON.stringify({ promptText: "Which color?", kind: "select", choices: ["red", "blue"] })).digest("hex");
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.hash, expected, "the hash of a people question is the one it had before piece 8");
  assert.equal(seen[1]!.hash, seen[0]!.hash, "answeredBy stays out of the hash");
  assert.equal((seen[0]!.purpose as { answeredBy?: string } | undefined)?.answeredBy, undefined);
  assert.deepEqual(seen[1]!.purpose, { answeredBy: "anyone" });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSessionRecord, WorkflowCallRecord } from "../src/workflow-result.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { continuationCandidates } from "../src/continuation-candidates.js";
import { continuationKey, type PreparedContinuation } from "../src/resume.js";
import type { PersistedAgentState, PersistedRunState } from "../src/runs/persistence/run-persistence.js";

// A resumed turn goes on in its session whatever stopped it (DESIGN.md, "Resume and the journal"):
// the person, a budget pause, a time limit, the usage limit, a lost login or a kill. So every pause
// reason but a failed step, and every error code, gives a candidate, and so does a call of a
// nested run, keyed by its own scope. A failed step runs its own prompt again.

const runId = "paused-source";
const NESTED = "paused-source-nested1";

function session(index = 0): AgentSessionRecord {
  return {
    sessionId: `session-${index}`,
    backendId: "test-backend",
    poolKey: "test-backend",
    cwd: "/workspace",
    reopen: { load: true, resume: true, list: true },
    callIndex: index,
    label: `agent-${index}`,
    keptOpen: true,
  };
}

function agent(index = 0): PersistedAgentState {
  return {
    id: index,
    label: `agent-${index}`,
    prompt: "task",
    status: "error",
    errorCode: WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    session: session(index),
    callIndex: index,
    scope: runId,
  };
}

function call(index = 0): WorkflowCallRecord {
  return {
    index,
    kind: "agent",
    hash: `hash-${index}`,
    inputsHash: `inputs-${index}`,
    outcome: "error",
    origin: "runner",
    error: {
      form: "workflow-error",
      message: "pause",
      code: WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    },
    attempts: 1,
    label: `agent-${index}`,
    backendId: "test-backend",
    resolvedCwd: "/workspace",
    settlementOrdinal: index + 1,
    scope: runId,
  };
}

function state(overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    runId,
    workflowName: "candidate",
    script: "return null",
    status: "paused",
    pauseReason: "usage_limit",
    phases: [],
    agents: [agent()],
    logs: [],
    calls: [call()],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function build(persisted: PersistedRunState): PreparedContinuation | undefined {
  return continuationCandidates(persisted);
}

function candidate(persisted: PersistedRunState, index = 0, scope = runId) {
  return build(persisted)?.candidates.get(continuationKey(scope, index));
}

describe("continuation candidates", () => {
  it("require a paused source, an error outcome, an agent row in error, and reopen support, with any pause reason and any error code", () => {
    assert.ok(candidate(state()));
    assert.ok(candidate(state({ pauseReason: "auth_required", agents: [{
      ...agent(),
      errorCode: WorkflowErrorCode.AUTH_REQUIRED,
    }] })));

    for (const pauseReason of ["checkpoint_required", undefined, "time_limit", "budget", "requested", "interrupted", "step_stopped"]) {
      assert.ok(candidate(state({ pauseReason })), `pause reason ${String(pauseReason)}`);
    }
    assert.equal(build(state({ pauseReason: "step_failed" })), undefined, "a failed step runs its own prompt again");
    for (const errorCode of Object.values(WorkflowErrorCode)) {
      assert.ok(candidate(state({ agents: [{ ...agent(), errorCode }] })), `error code ${errorCode}`);
    }
    for (const status of ["completed", "failed", "aborted"] as const) {
      assert.equal(build(state({ status })), undefined);
    }
    for (const outcome of ["result", "null"] as const) {
      assert.equal(candidate(state({ calls: [{ ...call(), outcome } as WorkflowCallRecord] })), undefined);
    }
    assert.equal(candidate(state({ agents: [{
      ...agent(),
      session: { ...session(), reopen: { load: false, resume: false, list: true } },
    }] })), undefined);

    const disagreeingCall = {
      ...call(),
      error: { ...call().error, code: WorkflowErrorCode.AGENT_EXECUTION_ERROR },
    } as WorkflowCallRecord;
    assert.ok(candidate(state({ calls: [disagreeingCall] })), "the call row's error code does not decide");
  });

  it("is a total fail-to-fresh projection for malformed persistence while retaining well-formed siblings", () => {
    const malformed: Array<PersistedRunState> = [
      state({ agents: undefined as unknown as PersistedAgentState[] }),
      state({ calls: undefined }),
      state({ agents: {} as unknown as PersistedAgentState[] }),
      state({ calls: {} as unknown as WorkflowCallRecord[] }),
      state({ agents: [{ ...agent(), callIndex: 1 }] }),
      state({ agents: [{ ...agent(), callIndex: -1 }] }),
      state({ agents: [{ ...agent(), callIndex: 0.5 }] }),
      state({ agents: [{ ...agent(), session: null as unknown as AgentSessionRecord }] }),
      state({ calls: [{ ...call(), index: -1 }] }),
      state({ calls: [{ ...call(), index: 0.5 }] }),
    ];
    for (const persisted of malformed) {
      assert.doesNotThrow(() => build(persisted));
      assert.equal(build(persisted), undefined);
    }

    const goodAgent = agent(1);
    const goodCall = call(1);
    const mixed = state({
      agents: [{ ...agent(), callIndex: 9 }, goodAgent],
      calls: [call(), goodCall],
    });
    assert.deepEqual([...build(mixed)!.candidates.keys()], [continuationKey(runId, 1)]);
  });

  it("enforces row status and record/session backend and cwd coherence, tolerating a missing cwd side", () => {
    assert.equal(candidate(state({ agents: [{ ...agent(), status: "done" }] })), undefined);
    assert.equal(candidate(state({ calls: [{ ...call(), backendId: "other" }] })), undefined);
    assert.equal(candidate(state({ calls: [{ ...call(), resolvedCwd: "/different" }] })), undefined);

    const noRecordCwd = call();
    delete noRecordCwd.resolvedCwd;
    assert.equal(candidate(state({ calls: [noRecordCwd] }))?.recordedCwd, "/workspace");

    const noSessionCwd: Omit<AgentSessionRecord, "cwd"> & { cwd?: string } = session();
    delete noSessionCwd.cwd;
    assert.equal(candidate(state({ agents: [{ ...agent(), session: noSessionCwd as AgentSessionRecord }] }))?.recordedCwd, "/workspace");
  });

  it("joins an agent row only to the call row of its own scope, uses later rows, and never reads the journal", () => {
    const nested = {
      ...agent(),
      scope: "nested-run",
      session: { ...session(), sessionId: "nested-session" },
    };
    const root = {
      ...agent(),
      session: { ...session(), sessionId: "root-session" },
    };
    assert.equal(candidate(state({ agents: [nested, root] }))?.sessionRef.sessionId, "root-session");
    assert.equal(candidate(state({ agents: [root, nested] }))?.sessionRef.sessionId, "root-session");
    assert.equal(candidate(state({ agents: [nested] })), undefined, "a nested agent row does not pair with a root call row");
    assert.equal(candidate(state({ agents: [nested] }), 0, "nested-run"), undefined, "nor with no call row of its own scope");

    const earlier = { ...root, session: { ...session(), sessionId: "earlier" } };
    const later = { ...root, session: { ...session(), sessionId: "later" } };
    assert.equal(candidate(state({ agents: [earlier, later] }))?.sessionRef.sessionId, "later");

    assert.ok(candidate(state({ journal: [] })), "the interrupted call needs no journal row");
    assert.equal(candidate(state({
      agents: [],
      journal: [{
        index: 0,
        hash: "hash-0",
        result: "event-derived",
        session: session(),
      }],
    })), undefined, "journal/event state never supplies the session join");
  });

  it("keeps duplicate hashes as distinct index-keyed candidates", () => {
    const firstCall = call(0);
    const secondCall = { ...call(1), hash: firstCall.hash };
    const projected = build(state({
      agents: [agent(0), agent(1)],
      calls: [firstCall, secondCall],
    }));
    assert.deepEqual([...projected!.candidates.keys()], [continuationKey(runId, 0), continuationKey(runId, 1)]);
    assert.equal(projected!.candidates.get(continuationKey(runId, 0))?.callIndex, 0);
    assert.equal(projected!.candidates.get(continuationKey(runId, 1))?.callIndex, 1);
  });

  it("come from a nested run's calls, each under its own scope", () => {
    const nestedAgent = (index: number): PersistedAgentState => ({ ...agent(index), scope: NESTED, session: { ...session(index), sessionId: `nested-${index}` } });
    const nestedCall = (index: number): WorkflowCallRecord => ({ ...call(index), scope: NESTED });
    const persisted = state({ pauseReason: "interrupted", agents: [agent(0), nestedAgent(0), nestedAgent(2)], calls: [call(0), nestedCall(0), nestedCall(2)] });
    assert.equal(candidate(persisted, 0)?.sessionRef.sessionId, "session-0");
    assert.equal(candidate(persisted, 0, NESTED)?.sessionRef.sessionId, "nested-0");
    assert.equal(candidate(persisted, 2, NESTED)?.sessionRef.sessionId, "nested-2");
    assert.equal(build(persisted)?.candidates.size, 3);
  });
});

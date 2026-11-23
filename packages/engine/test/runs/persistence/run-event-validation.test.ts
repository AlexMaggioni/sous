// What a reader of a run's event log accepts: the shape of each saved event, the byte limit of a
// record, and the limit of a read. A log is written by the engine, but a reader checks every line,
// since a crash, an old build or another tool can leave one that is wrong.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PersistableEngineRunEvent } from "../../../src/run-events.js";
import {
  RUN_EVENT_MAX_RECORD_BYTES,
  RUN_EVENT_READ_LIMIT_MAX,
  RunEventLogError,
  type RunEventPersistence,
} from "../../../src/runs/persistence/run-event-persistence.js";
import { workflowProjectPaths } from "../../../src/runs/persistence/project-paths.js";
import { createRunPersistence, type PersistedRunState } from "../../../src/runs/persistence/run-persistence.js";

const STREAM = "a".repeat(32);
const TIMESTAMP = "2026-01-02T03:04:05.000Z";
const RUN = "validation";

function state(runId: string): PersistedRunState {
  return {
    runId,
    workflowName: "event-validation",
    script: "export const meta = { name: 'events', description: 'events' }",
    status: "running",
    phases: [],
    agents: [],
    logs: [],
    startedAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    eventStreamId: STREAM,
    eventSeq: 0,
  };
}

/** A store in a folder of its own, with the run saved, and the path of its event log. */
function withStore(fn: (store: { persistence: RunEventPersistence; eventPath: string; at: (runId: string) => string }) => void): () => void {
  return () => {
    const cwd = mkdtempSync(join(tmpdir(), "run-event-validation-cwd-"));
    const root = mkdtempSync(join(tmpdir(), "run-event-validation-root-"));
    try {
      const persistence = createRunPersistence(cwd, undefined, { persistenceRoot: root });
      const { runsDir } = workflowProjectPaths(cwd, { persistenceRoot: root });
      const at = (runId: string) => join(runsDir, `${runId}.events.jsonl`);
      persistence.save(state(RUN));
      fn({ persistence, eventPath: at(RUN), at });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** One line of the log, as the writer saves it, for an event already in its saved shape. */
function line(event: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const record = {
    version: 1,
    streamId: STREAM,
    runId: RUN,
    seq: 1,
    timestamp: TIMESTAMP,
    event: { runId: RUN, scope: RUN, ...event },
    projection: { redacted: false, truncated: false },
    ...extra,
  };
  return `${JSON.stringify(record)}\n`;
}

function codeOf(read: () => unknown): string | undefined {
  try {
    read();
  } catch (error) {
    assert.ok(error instanceof RunEventLogError, `expected a RunEventLogError, got ${String(error)}`);
    return error.code;
  }
  return undefined;
}

// A saved paused event needs the error it paused on, in the shape the writer gives it.
const errorRecord = { form: "error", name: "Error", message: "the step failed" };
const authContext = { backendId: "claude", methods: [{ id: "login", type: "terminal" }] };
const checkpointContext = { callIndex: 3, hash: "abc", prompt: "Which one?", kind: "select", choices: ["a", "b"] };
const agentStart = { type: "agentStart", label: "writer", prompt: "write it", callIndex: 0 };
const paused = (fields: Record<string, unknown>) => ({ type: "paused", ...fields });

/** Each row is one saved event and whether a reader takes it. */
const rows: Array<{ name: string; event: Record<string, unknown>; ok: boolean }> = [
  { name: "agentStart with a timeout of 1500 ms", event: { ...agentStart, timeoutMs: 1500 }, ok: true },
  { name: "agentStart with a timeout of null", event: { ...agentStart, timeoutMs: null }, ok: true },
  { name: "agentStart with an idle timeout of null", event: { ...agentStart, idleTimeoutMs: null }, ok: true },
  { name: "agentStart with a negative timeout", event: { ...agentStart, timeoutMs: -1 }, ok: false },
  { name: "agentStart with a timeout that is text", event: { ...agentStart, timeoutMs: "10m" }, ok: false },
  { name: "agentStart with a negative idle timeout", event: { ...agentStart, idleTimeoutMs: -1 }, ok: false },
  { name: "agentStart with an idle timeout that is text", event: { ...agentStart, idleTimeoutMs: "10m" }, ok: false },
  { name: "agentStart with no prompt", event: { type: "agentStart", label: "writer", callIndex: 0 }, ok: false },

  { name: "paused with no reason and nothing else", event: paused({}), ok: true },
  { name: "paused with no reason and an error record", event: paused({ errorRecord }), ok: false },
  { name: "paused with the old error field", event: paused({ reason: "requested", error: "x", errorRecord }), ok: false },
  { name: "paused for a reason no run gives", event: paused({ reason: "tired", errorRecord }), ok: false },

  ...["requested", "step_failed", "step_stopped", "time_limit"].flatMap((reason) => [
    { name: `paused as ${reason} with its error record`, event: paused({ reason, errorRecord }), ok: true },
    { name: `paused as ${reason} with no error record`, event: paused({ reason }), ok: false },
    { name: `paused as ${reason} with a reset hint`, event: paused({ reason, errorRecord, resetHint: "in 2h" }), ok: false },
    { name: `paused as ${reason} with a login context`, event: paused({ reason, errorRecord, authContext }), ok: false },
  ]),

  { name: "paused at a usage limit with its error record", event: paused({ reason: "usage_limit", errorRecord }), ok: true },
  { name: "paused at a usage limit with a reset hint", event: paused({ reason: "usage_limit", errorRecord, resetHint: "in 2h" }), ok: true },
  { name: "paused at a usage limit with no error record", event: paused({ reason: "usage_limit" }), ok: false },
  { name: "paused at a usage limit with a reset hint and no error record", event: paused({ reason: "usage_limit", resetHint: "in 2h" }), ok: false },
  { name: "paused at a usage limit with a reset hint that is a number", event: paused({ reason: "usage_limit", errorRecord, resetHint: 7200 }), ok: false },
  { name: "paused at a usage limit with a login context", event: paused({ reason: "usage_limit", errorRecord, authContext }), ok: false },
  { name: "paused at a usage limit with a checkpoint context", event: paused({ reason: "usage_limit", errorRecord, checkpointContext }), ok: false },

  { name: "paused for a login with its error record", event: paused({ reason: "auth_required", errorRecord }), ok: true },
  { name: "paused for a login with a login context", event: paused({ reason: "auth_required", errorRecord, authContext }), ok: true },
  { name: "paused for a login with no error record", event: paused({ reason: "auth_required", authContext }), ok: false },
  { name: "paused for a login with a login method of a type no harness has", event: paused({ reason: "auth_required", errorRecord, authContext: { methods: [{ id: "x", type: "carrier-pigeon" }] } }), ok: false },
  { name: "paused for a login with a reset hint", event: paused({ reason: "auth_required", errorRecord, resetHint: "in 2h" }), ok: false },
  { name: "paused for a login with a checkpoint context", event: paused({ reason: "auth_required", errorRecord, checkpointContext }), ok: false },

  { name: "paused for a question with its error record", event: paused({ reason: "checkpoint_required", errorRecord }), ok: true },
  { name: "paused for a question with its checkpoint context", event: paused({ reason: "checkpoint_required", errorRecord, checkpointContext }), ok: true },
  { name: "paused for a question with no error record", event: paused({ reason: "checkpoint_required", checkpointContext }), ok: false },
  { name: "paused for a question with a kind no question has", event: paused({ reason: "checkpoint_required", errorRecord, checkpointContext: { ...checkpointContext, kind: "riddle" } }), ok: false },
  { name: "paused for a question with a reset hint", event: paused({ reason: "checkpoint_required", errorRecord, resetHint: "in 2h" }), ok: false },
  { name: "paused for a question with a login context", event: paused({ reason: "checkpoint_required", errorRecord, authContext }), ok: false },
];

describe("a reader of the event log checks the shape of each saved event", () => {
  for (const { name, event, ok } of rows) {
    it(`${ok ? "takes" : "refuses"} ${name}`, withStore(({ persistence, eventPath }) => {
      writeFileSync(eventPath, line(event));
      if (ok) {
        assert.deepEqual(persistence.readEvents(RUN).events[0]?.event, { runId: RUN, scope: RUN, ...event });
      } else {
        assert.equal(codeOf(() => persistence.readEvents(RUN)), "CORRUPT_LOG");
      }
    }));
  }
});

describe("the byte limit of a record", () => {
  const LIMIT = RUN_EVENT_MAX_RECORD_BYTES;

  /** A record that is `size` bytes with its line feed, padded with a field a reader keeps as it is. */
  const lineOfSize = (size: number): string => {
    const bare = line({ type: "stopped" }, { padding: "" }).length;
    return line({ type: "stopped" }, { padding: "x".repeat(size - bare) });
  };

  it("a reader takes a record of exactly the limit, line feed included", withStore(({ persistence, eventPath }) => {
    const text = lineOfSize(LIMIT);
    assert.equal(Buffer.byteLength(text), LIMIT);
    writeFileSync(eventPath, text);
    assert.equal(persistence.readEvents(RUN).events.length, 1);
  }));

  it("a reader refuses a record one byte over the limit", withStore(({ persistence, eventPath }) => {
    const text = lineOfSize(LIMIT + 1);
    assert.equal(Buffer.byteLength(text), LIMIT + 1);
    writeFileSync(eventPath, text);
    assert.equal(codeOf(() => persistence.readEvents(RUN)), "RECORD_TOO_LARGE");
  }));

  // A configOptions of 20 long keys is the largest event the projection lets through. A NUL
  // character is one byte in the text limit and six in the JSON line, so a count of NULs sets
  // the size of the line to within 5 bytes, and plain characters make up the rest.
  const bigEvent = (runId: string, nuls: number, plain: number): PersistableEngineRunEvent => {
    const configOptions: Record<string, string> = {};
    let left = nuls;
    for (let index = 0; index < 20; index++) {
      const give = Math.min(left, 512);
      left -= give;
      configOptions[`${"\0".repeat(510)}${String(index).padStart(2, "0")}`] = "\0".repeat(give);
    }
    return { type: "agentStart", runId, scope: runId, label: "x", prompt: "p".repeat(plain), configOptions, callIndex: 0 };
  };

  it("the writer saves a record of exactly the limit, a reader takes it back, and a byte more is refused", withStore(({ persistence, at }) => {
    // Three runs with an id of one length, so a record differs only in its padding.
    const [probe, exact, over] = ["size-probe", "size-exact", "size-over!"];
    for (const runId of [probe, exact, over]) persistence.save(state(runId));
    persistence.appendEvent(probe, { seq: 1, timestamp: TIMESTAMP, event: bigEvent(probe, 0, 0) });
    const extra = LIMIT - statSync(at(probe)).size;
    assert.ok(extra > 0 && extra < 6 * 20 * 512, `the base record is ${LIMIT - extra} bytes, within reach of the limit`);

    persistence.appendEvent(exact, { seq: 1, timestamp: TIMESTAMP, event: bigEvent(exact, Math.floor(extra / 6), extra % 6) });
    assert.equal(statSync(at(exact)).size, LIMIT);
    assert.equal(persistence.readEvents(exact).events.length, 1);

    const tooBig = bigEvent(over, Math.floor(extra / 6), (extra % 6) + 1);
    assert.equal(codeOf(() => persistence.appendEvent(over, { seq: 1, timestamp: TIMESTAMP, event: tooBig })), "RECORD_TOO_LARGE");
  }));
});

describe("the limit of a read", () => {
  it("a read of 1000 records at most is taken, and one of 1001 is refused", withStore(({ persistence }) => {
    persistence.appendEvent(RUN, { seq: 1, timestamp: TIMESTAMP, event: { type: "stopped", runId: RUN, scope: RUN } });
    assert.equal(persistence.readEvents(RUN, { limit: RUN_EVENT_READ_LIMIT_MAX }).events.length, 1);
    assert.equal(codeOf(() => persistence.readEvents(RUN, { limit: RUN_EVENT_READ_LIMIT_MAX + 1 })), "INVALID_LIMIT");
  }));

  it("a limit that is not a whole number, or under 1, is refused", withStore(({ persistence }) => {
    persistence.appendEvent(RUN, { seq: 1, timestamp: TIMESTAMP, event: { type: "stopped", runId: RUN, scope: RUN } });
    for (const limit of [0, -5, 1.5, Number.NaN]) {
      assert.equal(codeOf(() => persistence.readEvents(RUN, { limit })), "INVALID_LIMIT", String(limit));
    }
  }));
});

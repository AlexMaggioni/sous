import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowErrorCode } from "../../../src/errors.js";
import type { PersistableEngineRunEvent, RunEventLogRecord } from "../../../src/run-events.js";
import {
  RUN_EVENT_MAX_RECORD_BYTES,
  RUN_EVENT_READ_LIMIT_DEFAULT,
  RUN_EVENT_READ_LIMIT_MAX,
  RunEventLogError,
  withRunEvents,
  type RunEventPersistence,
} from "../../../src/runs/persistence/run-event-persistence.js";
import {
  createRunPersistence,
  type FsLayer,
  type PersistedRunState,
  type RunPersistence,
} from "../../../src/runs/persistence/run-persistence.js";

const STREAM_A = "a".repeat(32);
const STREAM_B = "b".repeat(32);
const TIMESTAMP = "2026-01-02T03:04:05.000Z";

function state(runId: string, overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    runId,
    workflowName: "event-persistence",
    script: "export const meta = { name: 'events', description: 'events' }",
    status: "running",
    phases: [],
    agents: [],
    logs: [],
    startedAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    eventStreamId: STREAM_A,
    eventSeq: 0,
    ...overrides,
  };
}

function stopped(runId: string): PersistableEngineRunEvent {
  return { type: "stopped", runId, scope: runId };
}

function expectCode(action: () => unknown, code: RunEventLogError["code"]): RunEventLogError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunEventLogError);
    assert.equal(error.name, "RunEventLogError");
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

function withPersistence(
  fn: (context: {
    persistence: RunEventPersistence;
    cwd: string;
    root: string;
    eventPath: (runId: string) => string;
  }) => void | Promise<void>,
  fsOverride?: Partial<FsLayer>,
) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-run-events-cwd-"));
    const root = mkdtempSync(join(tmpdir(), "ap-run-events-root-"));
    const persistence = createRunPersistence(cwd, fsOverride, { persistenceRoot: root });
    try {
      await fn({
        persistence,
        cwd,
        root,
        eventPath: (runId) => join(persistence.getRunsDir(), `${runId}.events.jsonl`),
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("event constants and RunEventLogError expose the frozen public contract", () => {
  assert.equal(RUN_EVENT_MAX_RECORD_BYTES, 65_536);
  assert.equal(RUN_EVENT_READ_LIMIT_DEFAULT, 100);
  assert.equal(RUN_EVENT_READ_LIMIT_MAX, 1_000);
  const cause = new Error("disk");
  const error = new RunEventLogError("failed", "IO_ERROR", {
    runId: "raw-run-id",
    seq: 7,
    path: "/absolute/run.events.jsonl",
    cause,
  });
  assert.equal(error.runId, "raw-run-id");
  assert.equal(error.seq, 7);
  assert.equal(error.path, "/absolute/run.events.jsonl");
  assert.equal(error.cause, cause);
});

test(
  "appendEvent writes one canonical line and readEvents provides stable cursors over a log-ahead snapshot",
  withPersistence(({ persistence, eventPath }) => {
    const runId = "append-read";
    persistence.save(state(runId));
    const first = persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });
    const second = persistence.appendEvent(runId, {
      seq: 2,
      timestamp: TIMESTAMP,
      event: { type: "log", runId, scope: runId, message: "Bearer secret-token-value-01234567890123456789" },
    });

    assert.equal(first.streamId, STREAM_A);
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    const bytes = readFileSync(eventPath(runId));
    assert.equal(bytes.at(-1), 0x0a);
    assert.equal(bytes.toString("utf8").split("\n").length, 3);
    assert.equal(bytes.includes(Buffer.from("secret-token-value")), false);

    const page = persistence.readEvents(runId, { after: 0, limit: 1 });
    assert.deepEqual(page.events.map((record) => record.seq), [1]);
    assert.equal(page.streamId, STREAM_A);
    assert.equal(page.cursor, 1);
    assert.equal(page.endCursor, 2);
    assert.equal(page.hasMore, true);
    const continuation = persistence.readEvents(runId, { after: page.cursor, streamId: page.streamId });
    assert.deepEqual(continuation.events.map((record) => record.seq), [2]);
    assert.equal(continuation.cursor, 2);
    assert.equal(continuation.endCursor, 2);
    assert.equal(continuation.hasMore, false);
  }),
);

test(
  "continuation journal markers and live provenance survive projection and validation",
  withPersistence(({ persistence }) => {
    const runId = "continuation-validation";
    persistence.save(state(runId));
    persistence.appendEvent(runId, {
      seq: 1,
      timestamp: TIMESTAMP,
      event: {
        type: "journal",
        runId,
        scope: runId,
        entry: {
          index: 0,
          hash: "hash",
          result: "continued",
          kind: "agent",
          call: {
            kind: "agent",
            label: "worker",
            continuation: { method: "resume" },
          },
        },
      },
    });
    persistence.appendEvent(runId, {
      seq: 2,
      timestamp: TIMESTAMP,
      event: {
        type: "agentEnd",
        runId,
        scope: runId,
        label: "worker",
        result: "continued",
        callIndex: 0,
        provenance: {
          source: "live",
          continuation: { reattached: false, reason: "runner-declined" },
        },
      },
    });
    const events = persistence.readEvents(runId).events;
    const journal = events[0]?.event;
    assert.equal(journal?.type, "journal");
    if (journal?.type === "journal") {
      assert.deepEqual(
        journal.entry.call?.kind === "agent" ? journal.entry.call.continuation : undefined,
        { method: "resume" },
      );
    }
    const agentEnd = events[1]?.event;
    assert.equal(agentEnd?.type, "agentEnd");
    if (agentEnd?.type === "agentEnd") {
      assert.deepEqual(
        agentEnd.provenance?.source === "live" ? agentEnd.provenance.continuation : undefined,
        { reattached: false, reason: "runner-declined" },
      );
    }

    expectCode(() => persistence.appendEvent(runId, {
      seq: 3,
      timestamp: TIMESTAMP,
      event: {
        type: "agentEnd",
        runId,
        scope: runId,
        label: "worker",
        result: null,
        callIndex: 0,
        provenance: {
          source: "live",
          continuation: { reattached: false, reason: "future-reason" as never },
        },
      } as PersistableEngineRunEvent,
    }), "CORRUPT_LOG");
  }),
);

test(
  "legacy call-record events read successfully and omit historical debit metadata",
  withPersistence(({ persistence, eventPath }) => {
    const runId = "legacy-budget-event";
    persistence.save(state(runId));
    const current = persistence.appendEvent(runId, {
      seq: 1,
      timestamp: TIMESTAMP,
      event: {
        type: "callRecord",
        runId,
        scope: runId,
        record: {
          index: 0,
          kind: "agent",
          hash: "hash",
          outcome: "result",
          origin: "runner",
          usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0.01 },
        },
      },
    });
    assert.equal(current.event.type, "callRecord");
    if (current.event.type !== "callRecord") throw new Error("expected projected call record");
    const legacy = {
      ...current,
      event: {
        ...current.event,
        record: { ...current.event.record, budgetDebit: 5 },
      },
    };
    writeFileSync(eventPath(runId), `${JSON.stringify(legacy)}\n`);

    const event = persistence.readEvents(runId).events[0]?.event;
    assert.equal(event?.type, "callRecord");
    if (event?.type === "callRecord") {
      assert.equal(Object.hasOwn(event.record, "budgetDebit"), false);
      assert.equal(event.record.usage?.total, 5);
    }
  }),
);

test(
  "a resumed start after a crash-dangling agentStart reads back in order",
  withPersistence(async ({ persistence }) => {
    const runId = "crash-resumed-events";
    persistence.save(state(runId));

    persistence.appendEvent(runId, {
      seq: 1,
      timestamp: TIMESTAMP,
      event: { type: "agentStart", runId, scope: runId, label: "worker", prompt: "work", callIndex: 0 },
    });

    // A hard crash leaves the first execution without agentEnd. Same-ID resume
    // retains the stream and deterministically starts the logical call again.
    persistence.appendEvent(runId, {
      seq: 2,
      timestamp: TIMESTAMP,
      event: { type: "resumed", runId, scope: runId },
    });
    persistence.appendEvent(runId, {
      seq: 3,
      timestamp: TIMESTAMP,
      event: { type: "agentStart", runId, scope: runId, label: "worker", prompt: "work", callIndex: 0 },
    });

    const page = persistence.readEvents(runId, { limit: 100 });
    assert.deepEqual(page.events.map((record) => record.seq), [1, 2, 3]);

    const tail = persistence.readEvents(runId, { after: 1, streamId: page.streamId });
    assert.equal(tail.events[0]?.event.type, "resumed");
    assert.equal(tail.events[1]?.event.type, "agentStart");
  }),
);

test(
  "read validation uses the exact option and snapshot classification precedence",
  withPersistence(({ persistence, eventPath }) => {
    expectCode(() => persistence.readEvents("missing", { after: -1, limit: 0, streamId: "bad" }), "INVALID_CURSOR");
    expectCode(() => persistence.readEvents("missing", { after: 0, limit: 0, streamId: "bad" }), "INVALID_LIMIT");
    expectCode(() => persistence.readEvents("missing", { after: 0, limit: 1, streamId: "bad" }), "INVALID_STREAM_ID");
    expectCode(() => persistence.readEvents("missing"), "RUN_NOT_FOUND");

    mkdirSync(persistence.getRunsDir(), { recursive: true });
    writeFileSync(eventPath("orphan"), "partial");
    const orphan = expectCode(() => persistence.readEvents("orphan"), "ORPHANED_LOG");
    assert.equal(orphan.path, eventPath("orphan"));

    persistence.save(state("legacy", { eventStreamId: undefined, eventSeq: undefined }));
    expectCode(() => persistence.readEvents("legacy"), "EVENT_LOG_UNAVAILABLE");
    writeFileSync(eventPath("legacy"), "partial");
    expectCode(() => persistence.readEvents("legacy"), "WATERMARK_MISSING");

    persistence.save(state("stream-missing", { eventStreamId: undefined, eventSeq: 0 }));
    expectCode(() => persistence.readEvents("stream-missing"), "STREAM_ID_MISSING");

    persistence.save(state("incomplete", { eventLogIncomplete: true }));
    expectCode(
      () => persistence.readEvents("incomplete", { streamId: STREAM_B }),
      "STREAM_MISMATCH",
    );
    expectCode(() => persistence.readEvents("incomplete"), "EVENT_LOG_INCOMPLETE");

    persistence.save(state("empty"));
    assert.deepEqual(persistence.readEvents("empty"), {
      events: [],
      streamId: STREAM_A,
      cursor: 0,
      endCursor: 0,
      hasMore: false,
    });
    expectCode(() => persistence.readEvents("empty", { after: 1 }), "CURSOR_AHEAD");
  }),
);

test(
  "terminated corrupt, oversized, unknown-version, sequence, generation, and watermark failures are never ignored",
  withPersistence(({ persistence, eventPath }) => {
    const cases = [
      { runId: "corrupt", bytes: "not-json\n", code: "CORRUPT_LOG" as const },
      { runId: "oversized", bytes: `${"x".repeat(RUN_EVENT_MAX_RECORD_BYTES)}\n`, code: "RECORD_TOO_LARGE" as const },
    ];
    for (const fixture of cases) {
      persistence.save(state(fixture.runId));
      writeFileSync(eventPath(fixture.runId), fixture.bytes);
      expectCode(() => persistence.readEvents(fixture.runId), fixture.code);
    }

    const runId = "record-validation";
    persistence.save(state(runId));
    const valid = persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });

    writeFileSync(eventPath(runId), `${JSON.stringify({ ...valid, version: 2 })}\n`);
    expectCode(() => persistence.readEvents(runId), "UNSUPPORTED_VERSION");

    writeFileSync(eventPath(runId), `${JSON.stringify({ ...valid, event: { ...valid.event, scope: 4 } })}\n`);
    expectCode(() => persistence.readEvents(runId), "CORRUPT_LOG");

    writeFileSync(eventPath(runId), `${JSON.stringify({ ...valid, seq: 2 })}\n`);
    expectCode(() => persistence.readEvents(runId), "CORRUPT_LOG");

    writeFileSync(eventPath(runId), `${JSON.stringify({ ...valid, streamId: STREAM_B })}\n`);
    expectCode(() => persistence.readEvents(runId), "STREAM_MISMATCH");

    const additive = { ...valid, futureTopLevel: "retained", event: { ...valid.event, futureEventField: 9 } };
    writeFileSync(eventPath(runId), `${JSON.stringify(additive)}\n`);
    const additiveRead = persistence.readEvents(runId).events[0] as RunEventLogRecord & {
      futureTopLevel: string;
      event: RunEventLogRecord["event"] & { futureEventField: number };
    };
    assert.equal(additiveRead.futureTopLevel, "retained");
    assert.equal(additiveRead.event.futureEventField, 9);

    writeFileSync(eventPath(runId), `${JSON.stringify(valid)}\n`);
    persistence.save(state(runId, { eventSeq: 2 }));
    expectCode(() => persistence.readEvents(runId), "SNAPSHOT_AHEAD");
  }),
);

test(
  "an old log keeps reading with an error code no run makes now, and an unknown code is still corrupt",
  withPersistence(({ persistence, eventPath }) => {
    const runId = "retired-codes";
    persistence.save(state(runId));
    const record = persistence.appendEvent(runId, {
      seq: 1,
      timestamp: TIMESTAMP,
      event: { type: "agentEnd", runId, scope: runId, label: "step", result: null, errorCode: WorkflowErrorCode.AUTH_REQUIRED, callIndex: 0 },
    });
    const withCode = (code: string) => `${JSON.stringify({ ...record, event: { ...record.event, errorCode: code } })}\n`;
    for (const code of ["AGENT_TIMEOUT", "AGENT_IDLE_TIMEOUT", "RECORDING_UNUSABLE", "REPLAY_TARGET_INVALID", "REPLAY_DIVERGENCE"]) {
      writeFileSync(eventPath(runId), withCode(code));
      const event = persistence.readEvents(runId).events[0]!.event;
      assert.equal(event.type === "agentEnd" ? (event.errorCode as string) : undefined, code);
    }
    writeFileSync(eventPath(runId), withCode("NOT_A_CODE"));
    expectCode(() => persistence.readEvents(runId), "CORRUPT_LOG");
  }),
);

test(
  "an unterminated suffix is ignored by readers and repaired before the next lease epoch reuses its sequence",
  withPersistence(({ persistence, eventPath }) => {
    const runId = "tail-repair";
    persistence.save(state(runId));
    persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });
    persistence.save(state(runId, { eventSeq: 1 }));
    persistence.releaseRunLease({ runId, token: "test-epoch" });

    const partial = Buffer.from('{"version":1,"seq":2', "utf8");
    const descriptor = openSync(eventPath(runId), "a");
    writeSync(descriptor, partial);
    closeSync(descriptor);
    const before = persistence.readEvents(runId, { after: 1 });
    assert.equal(before.endCursor, 1);
    assert.deepEqual(before.events, []);

    const second = persistence.appendEvent(runId, { seq: 2, timestamp: TIMESTAMP, event: stopped(runId) });
    assert.equal(second.seq, 2);
    const records = readFileSync(eventPath(runId), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as RunEventLogRecord);
    assert.deepEqual(records.map((record) => record.seq), [1, 2]);
  }),
);

test(
  "append validates candidates, wraps projection and filesystem failures, and detects short writes",
  withPersistence(({ persistence, eventPath }) => {
    const runId = "append-errors";
    persistence.save(state(runId));
    expectCode(
      () => persistence.appendEvent(runId, { seq: 2, timestamp: TIMESTAMP, event: stopped(runId) }),
      "SEQUENCE_MISMATCH",
    );
    expectCode(
      () => persistence.appendEvent(runId, { seq: 1, timestamp: "not-a-timestamp", event: stopped(runId) }),
      "CORRUPT_LOG",
    );
    expectCode(
      () => persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped("different") }),
      "CORRUPT_LOG",
    );
    expectCode(
      () => persistence.appendEvent(runId, {
        seq: 1,
        timestamp: TIMESTAMP,
        event: { type: "agentHistory", runId, scope: runId, label: "x", history: [], callIndex: 0 } as never,
      }),
      "CORRUPT_LOG",
    );

    const throwingResult = {};
    Object.defineProperty(throwingResult, "value", {
      enumerable: true,
      get() {
        throw new Error("projector exploded");
      },
    });
    const projection = expectCode(
      () => persistence.appendEvent(runId, {
        seq: 1,
        timestamp: TIMESTAMP,
        event: { type: "agentEnd", runId, scope: runId, label: "x", result: throwingResult, callIndex: 0 },
      }),
      "PROJECTION_ERROR",
    );
    assert.ok(projection.cause instanceof Error);
    assert.equal(projection.path, eventPath(runId));

    const escaped = "\0".repeat(512);
    const configOptions = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`${"\0".repeat(510)}${index.toString().padStart(2, "0")}`, escaped]),
    );
    expectCode(
      () => persistence.appendEvent(runId, {
        seq: 1,
        timestamp: TIMESTAMP,
        event: { type: "agentStart", runId, scope: runId, label: "x", prompt: "x", configOptions, callIndex: 0 },
      }),
      "RECORD_TOO_LARGE",
    );
  }),
);

test(
  "the writer performs one verified write and leaves sequence state unchanged after a short write",
  async () => {
    let writes = 0;
    let closes = 0;
    const cwd = mkdtempSync(join(tmpdir(), "ap-run-events-short-cwd-"));
    const root = mkdtempSync(join(tmpdir(), "ap-run-events-short-root-"));
    const persistence = createRunPersistence(
      cwd,
      {
        writeSync: ((_fd: number, buffer: Uint8Array) => {
          writes++;
          return buffer.byteLength - 1;
        }) as typeof writeSync,
        closeSync: ((fd: number) => {
          closes++;
          closeSync(fd);
        }) as typeof closeSync,
      },
      { persistenceRoot: root },
    );
    try {
      const runId = "short-write";
      persistence.save(state(runId));
      expectCode(
        () => persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) }),
        "IO_ERROR",
      );
      assert.equal(writes, 1);
      assert.equal(closes, 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "non-ENOENT sidecar failures are IO_ERROR with their original cause",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ap-run-events-io-cwd-"));
    const root = mkdtempSync(join(tmpdir(), "ap-run-events-io-root-"));
    const cause = Object.assign(new Error("denied"), { code: "EACCES" });
    const persistence = createRunPersistence(
      cwd,
      {
        readFileSync: ((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
          if (String(path).endsWith(".events.jsonl")) throw cause;
          return (readFileSync as (...inner: unknown[]) => unknown)(path, ...args);
        }) as typeof readFileSync,
      },
      { persistenceRoot: root },
    );
    try {
      persistence.save(state("io-error"));
      const error = expectCode(() => persistence.readEvents("io-error"), "IO_ERROR");
      assert.equal(error.cause, cause);
      assert.ok(error.path?.endsWith("io-error.events.jsonl"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "createRunPersistence is already event-capable and default deletion removes its sidecar",
  withPersistence(({ persistence, eventPath }) => {
    assert.equal(withRunEvents(persistence), persistence);
    const runId = "delete-order";
    persistence.save(state(runId));
    persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });
    assert.equal(statSync(eventPath(runId)).isFile(), true);
    assert.equal(persistence.delete(runId), true);
    assert.throws(() => statSync(eventPath(runId)), (error) => (error as { code?: string }).code === "ENOENT");
  }),
);

test(
  "list() surfaces the snapshot run but never its .events.jsonl sidecar",
  withPersistence(({ persistence, eventPath }) => {
    const runId = "sidecar-excluded";
    persistence.save(state(runId));
    persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });

    // The sidecar is genuinely on disk beside the snapshot.
    assert.equal(statSync(eventPath(runId)).isFile(), true);
    assert.equal(readdirSync(persistence.getRunsDir()).includes(`${runId}.events.jsonl`), true);

    // list() reads the directory back through the public API. The implementation filters on
    // `.endsWith(".json")`, which the `.jsonl` sidecar fails, so exactly the snapshot run appears
    // and no phantom entry is minted from the sidecar file name.
    const listed = persistence.list();
    assert.deepEqual(listed.map((snapshot) => snapshot.runId), [runId]);
    assert.equal(
      listed.some((snapshot) => snapshot.runId.endsWith(".events") || snapshot.runId.endsWith(".jsonl")),
      false,
    );
  }),
);

// A COMPLETE legacy `FsLayer` value: every pre-existing member and NONE of the four hooks
// (openSync/writeSync/closeSync/truncateSync) added for the event sidecar. It must
// still satisfy `FsLayer` — the new members are optional — so a pre-contract override annotated as
// `FsLayer` stays source-compatible; making them required would be a type-level breaking change.
const legacyFsLayer: FsLayer = {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
};

test(
  "a complete legacy FsLayer omitting the four new hooks compiles and falls back to node:fs",
  withPersistence(({ persistence, eventPath }) => {
    const runId = "legacy-fslayer";
    persistence.save(state(runId));
    // append/read exercise openSync/writeSync/closeSync — none supplied by legacyFsLayer,
    // so the factory's node:fs fallback carries the verified append and the cursor read.
    const record = persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });
    assert.equal(record.seq, 1);
    assert.equal(statSync(eventPath(runId)).isFile(), true);
    const page = persistence.readEvents(runId);
    assert.deepEqual(page.events.map((entry) => entry.seq), [1]);
  }, legacyFsLayer),
);

{
  const deletions: string[] = [];
  test(
    "default deletion orders the event sidecar before snapshots and removes the writer lock last",
    withPersistence(
      ({ persistence }) => {
        const runId = "ordered-delete";
        persistence.save(state(runId));
        const lease = persistence.acquireRunLease(runId);
        assert.ok(lease);
        persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) });
        assert.equal(persistence.delete(runId), true);
        const eventIndex = deletions.findIndex((path) => path.endsWith(`${runId}.events.jsonl`));
        const snapshotIndex = deletions.findIndex((path) => path.endsWith(`${runId}.json`));
        const backupIndex = deletions.findIndex((path) => path.endsWith(`${runId}.json.bak`));
        const lockIndex = deletions.findIndex((path) => path.endsWith(`${runId}.lock`));
        assert.ok(eventIndex >= 0 && snapshotIndex > eventIndex);
        assert.ok(backupIndex > snapshotIndex);
        assert.equal(lockIndex, deletions.length - 1);
      },
      {
        unlinkSync: ((path: Parameters<typeof unlinkSync>[0]) => {
          deletions.push(String(path));
          unlinkSync(path);
        }) as typeof unlinkSync,
      },
    ),
  );
}

test("withRunEvents wraps structural persistence once, delegates it, and deletes the sidecar first", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "ap-run-events-custom-"));
  const snapshots = new Map<string, PersistedRunState>();
  let sidecarPresentWhenDelete: boolean | undefined;
  let releaseCalls = 0;
  const custom: RunPersistence & { appendEvent(): never } = {
    save(snapshot) {
      snapshots.set(snapshot.runId, structuredClone(snapshot));
    },
    load(runId) {
      const snapshot = snapshots.get(runId);
      return snapshot === undefined ? null : structuredClone(snapshot);
    },
    list() {
      return [...snapshots.values()].map((snapshot) => structuredClone(snapshot));
    },
    delete(runId) {
      sidecarPresentWhenDelete = existsSync(join(runsDir, `${runId}.events.jsonl`));
      snapshots.delete(runId);
      return false;
    },
    acquireRunLease(runId) {
      return { runId, token: "custom" };
    },
    releaseRunLease() {
      releaseCalls++;
    },
    getRunsDir() {
      return runsDir;
    },
    appendEvent() {
      throw new Error("structural lookalike must not be trusted");
    },
  };
  try {
    const persistence = withRunEvents(custom);
    assert.notEqual(persistence, custom);
    assert.equal(withRunEvents(persistence), persistence);
    const runId = "custom-wrapper";
    persistence.save(state(runId));
    assert.equal(persistence.appendEvent(runId, { seq: 1, timestamp: TIMESTAMP, event: stopped(runId) }).seq, 1);
    persistence.releaseRunLease({ runId, token: "custom" });
    assert.equal(releaseCalls, 1);
    assert.equal(persistence.appendEvent(runId, { seq: 2, timestamp: TIMESTAMP, event: stopped(runId) }).seq, 2);
    assert.equal(persistence.delete(runId), false);
    assert.equal(sidecarPresentWhenDelete, false);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

// A read parses the whole log, so its cost grows with the log. This bounds it on a large one.
// The log is written in one go, since 20,000 appends spend most of a minute opening the file.
test(
  "a read of a 20,000-record log returns its page within a second",
  withPersistence(({ persistence, eventPath }) => {
    const runId = "r0-bounded";
    persistence.save(state(runId));
    const first = persistence.appendEvent(runId, {
      seq: 1,
      timestamp: TIMESTAMP,
      event: { type: "log", runId, scope: runId, message: "bounded-1" },
    });
    const total = 20_000;
    const lines = Array.from({ length: total }, (_, index) =>
      JSON.stringify({ ...first, seq: index + 1, event: { ...first.event, message: `bounded-${index + 1}` } }));
    writeFileSync(eventPath(runId), `${lines.join("\n")}\n`);
    // The snapshot's watermark trails the log by 5,000 records.
    const after = total - 5_000;
    persistence.save(state(runId, { eventSeq: after }));

    const readStart = Date.now();
    const page = persistence.readEvents(runId, { after, limit: 100 });
    const readMs = Date.now() - readStart;
    assert.deepEqual(
      page.events.map((record) => record.seq),
      Array.from({ length: 100 }, (_, index) => after + index + 1),
    );
    assert.equal(page.endCursor, total);
    assert.equal(page.hasMore, true);
    assert.ok(readMs < 1_000, `readEvents of a 5k-lagging page took ${readMs}ms (expected < 1000ms)`);
  }),
);

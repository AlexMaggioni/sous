import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judge, parseResetHint, type RunFacts, type Verdict } from "../../src/runs/rule.js";

const pausedAt = "2026-11-21T10:00:00.000Z";

type Saved = NonNullable<RunFacts["state"]>;
const saved = (status: Saved["status"], pauseReason?: string): Saved => ({ status, ...(pauseReason === undefined ? {} : { pauseReason }), updatedAt: pausedAt });

/** The verdict in one flat line, so a row of the table reads as one object. */
function answers(verdict: Verdict) {
  return {
    status: verdict.status,
    word: verdict.word,
    exit: verdict.exit,
    unfinished: verdict.unfinished,
    pause: verdict.pause?.reason,
    resume: verdict.resume.ok ? "ok" : verdict.resume.why,
    reuse: verdict.reuse.ok ? "ok" : verdict.reuse.why,
  };
}

type Answers = ReturnType<typeof answers>;

const gone = { alive: false, openQuestions: 0 };
const alive = { alive: true, openQuestions: 0 };

/** One row per row of the rule's table, with today's answers. */
const TABLE: Array<{ row: string; facts: RunFacts } & Answers> = [
  { row: "asks",                        facts: { state: saved("running"), alive: true, openQuestions: 2 },  status: "asks",        word: "asks",                  exit: 4,         unfinished: true,  pause: undefined,       resume: "running",       reuse: "running" },
  { row: "starting",                    facts: { ...alive },                                                 status: "starting",    word: "starting",              exit: undefined, unfinished: true,  pause: undefined,       resume: "running",       reuse: "running" },
  { row: "not started",                 facts: { ...gone },                                                  status: "not started", word: "not started",           exit: 1,         unfinished: true,  pause: undefined,       resume: "never-started", reuse: "ok" },
  { row: "pending",                     facts: { state: saved("pending"), ...alive },                        status: "pending",     word: "pending",               exit: undefined, unfinished: true,  pause: undefined,       resume: "running",       reuse: "running" },
  { row: "pending, worker gone",        facts: { state: saved("pending"), ...gone },                         status: "interrupted", word: "interrupted",           exit: 2,         unfinished: true,  pause: "interrupted",   resume: "ok",            reuse: "paused" },
  { row: "running",                     facts: { state: saved("running"), ...alive },                        status: "running",     word: "running",               exit: undefined, unfinished: true,  pause: undefined,       resume: "running",       reuse: "running" },
  { row: "running, worker gone",        facts: { state: saved("running"), ...gone },                         status: "interrupted", word: "interrupted",           exit: 2,         unfinished: true,  pause: "interrupted",   resume: "ok",            reuse: "paused" },
  { row: "paused, usage_limit",         facts: { state: saved("paused", "usage_limit"), ...gone },           status: "paused",      word: "paused: limit",         exit: 2,         unfinished: true,  pause: "usage_limit",   resume: "ok",            reuse: "paused" },
  { row: "paused, auth_required",       facts: { state: saved("paused", "auth_required"), ...gone },         status: "paused",      word: "paused: login",         exit: 2,         unfinished: true,  pause: "auth_required", resume: "ok",            reuse: "paused" },
  { row: "paused, checkpoint_required", facts: { state: saved("paused", "checkpoint_required"), ...gone },   status: "paused",      word: "paused: asks",          exit: 2,         unfinished: true,  pause: "asks",          resume: "ok",            reuse: "paused" },
  { row: "paused, requested",           facts: { state: saved("paused", "requested"), ...gone },             status: "paused",      word: "paused",                exit: 2,         unfinished: true,  pause: "requested",     resume: "ok",            reuse: "paused" },
  { row: "paused, step_failed",         facts: { state: saved("paused", "step_failed"), ...gone },           status: "paused",      word: "paused: failed step",   exit: 2,         unfinished: true,  pause: "step_failed",   resume: "ok",            reuse: "paused" },
  { row: "paused, step_stopped",        facts: { state: saved("paused", "step_stopped"), ...gone },          status: "paused",      word: "paused: stopped step",  exit: 2,         unfinished: true,  pause: "step_stopped",  resume: "ok",            reuse: "paused" },
  { row: "paused, time_limit",          facts: { state: saved("paused", "time_limit"), ...gone },            status: "paused",      word: "paused: time limit",    exit: 2,         unfinished: true,  pause: "time_limit",    resume: "ok",            reuse: "paused" },
  { row: "paused, budget",              facts: { state: saved("paused", "budget"), ...gone },                status: "paused",      word: "paused: budget",        exit: 2,         unfinished: true,  pause: "budget",        resume: "ok",            reuse: "paused" },
  { row: "paused, interrupted",         facts: { state: saved("paused", "interrupted"), ...gone },           status: "interrupted", word: "interrupted",           exit: 2,         unfinished: true,  pause: "interrupted",   resume: "ok",            reuse: "paused" },
  { row: "paused, other text",          facts: { state: saved("paused", "disk_full"), ...gone },             status: "paused",      word: "paused: disk_full",     exit: 2,         unfinished: true,  pause: "other",         resume: "ok",            reuse: "paused" },
  { row: "completed",                   facts: { state: saved("completed"), ...gone },                       status: "completed",   word: "completed",             exit: 0,         unfinished: false, pause: undefined,       resume: "completed",     reuse: "ok" },
  { row: "failed",                      facts: { state: saved("failed"), ...gone },                          status: "failed",      word: "failed",                exit: 1,         unfinished: false, pause: undefined,       resume: "ok",            reuse: "ok" },
  { row: "aborted",                     facts: { state: saved("aborted"), ...gone },                         status: "stopped",     word: "stopped",               exit: 3,         unfinished: false, pause: undefined,       resume: "stopped",       reuse: "ok" },
];

describe("the pause rule", () => {
  for (const { row, facts, ...expected } of TABLE) {
    it(`${row}: ${expected.word}`, () => assert.deepEqual(answers(judge(facts)), expected));
  }

  it("a live worker on a saved state keeps its word, and holds the wait, resume and reuse", () => {
    const live = { exit: undefined, unfinished: true, resume: "running", reuse: "running" };
    for (const [state, status, word, pause] of [
      [saved("pending"), "pending", "pending", undefined],
      [saved("paused", "usage_limit"), "paused", "paused: limit", "usage_limit"],
      [saved("paused", "interrupted"), "interrupted", "interrupted", "interrupted"],
      [saved("completed"), "completed", "completed", undefined],
      [saved("aborted"), "stopped", "stopped", undefined],
    ] as const) {
      assert.deepEqual(answers(judge({ state, ...alive })), { ...live, status, word, pause });
    }
  });

  it("open questions only count while the worker runs", () => {
    assert.equal(judge({ state: saved("paused", "checkpoint_required"), alive: false, openQuestions: 1 }).word, "paused: asks");
    assert.equal(judge({ alive: true, openQuestions: 1 }).word, "asks");
  });

  it("the pause comes from the state alone, even while the run asks", () => {
    const verdict = judge({ state: saved("paused", "usage_limit"), alive: true, openQuestions: 1 });
    assert.equal(verdict.word, "asks");
    assert.equal(verdict.pause?.reason, "usage_limit");
  });

  it("keeps the text of a reason it does not know, and prints ? when there is none", () => {
    assert.deepEqual(judge({ state: saved("paused", "disk_full"), ...gone }).pause, { reason: "other", text: "disk_full" });
    const none = judge({ state: saved("paused"), ...gone });
    assert.equal(none.word, "paused: ?");
    assert.deepEqual(none.pause, { reason: "other" });
  });
});

describe("the reset time", () => {
  it("reads today's two hint forms", () => {
    assert.deepEqual(parseResetHint("Resets at 2026-11-21T12:00:00.000Z", pausedAt), new Date("2026-11-21T12:00:00.000Z"));
    assert.deepEqual(parseResetHint("Resets in ~2h", pausedAt), new Date("2026-11-21T12:00:00.000Z"));
    assert.equal(parseResetHint("Resets at noon", pausedAt), undefined);
    assert.equal(parseResetHint(undefined, pausedAt), undefined);
  });

  it("gives a run at the limit its reset time and its resume time, and a typed resetAt wins", () => {
    const limit = (fields: Partial<Saved>) => judge({ state: { ...saved("paused", "usage_limit"), ...fields }, ...gone }).pause;
    assert.deepEqual(limit({ resetHint: "Resets at 2026-11-21T12:00:00.000Z" }), {
      reason: "usage_limit",
      resetAt: new Date("2026-11-21T12:00:00.000Z"),
      resumeAt: new Date("2026-11-21T12:00:30.000Z"),
    });
    assert.deepEqual(limit({}), { reason: "usage_limit", resumeAt: new Date("2026-11-21T10:30:00.000Z") });
    // A typed resetAt wins over the hint.
    assert.deepEqual(limit({ resetAt: "2026-11-21T11:00:00.000Z", resetHint: "Resets at 2026-11-21T12:00:00.000Z" }), {
      reason: "usage_limit",
      resetAt: new Date("2026-11-21T11:00:00.000Z"),
      resumeAt: new Date("2026-11-21T11:00:30.000Z"),
    });
  });

  it("counts the wait from pausedAt, which a later save does not move, and from updatedAt in a state saved before pausedAt", () => {
    const limit = (fields: Partial<Saved>) => judge({ state: { ...saved("paused", "usage_limit"), ...fields }, ...gone }).pause;
    const later = { pausedAt: "2026-11-21T09:00:00.000Z" };
    assert.deepEqual(limit(later), { reason: "usage_limit", resumeAt: new Date("2026-11-21T09:30:00.000Z") });
    assert.deepEqual(limit({ ...later, resetHint: "Resets in ~2h" }), {
      reason: "usage_limit",
      resetAt: new Date("2026-11-21T11:00:00.000Z"),
      resumeAt: new Date("2026-11-21T11:00:30.000Z"),
    });
    assert.deepEqual(limit({}), { reason: "usage_limit", resumeAt: new Date("2026-11-21T10:30:00.000Z") });
  });

  it("gives no resume time to any other pause", () => {
    for (const reason of ["auth_required", "checkpoint_required", "requested", "step_failed", "step_stopped", "time_limit", "budget", "interrupted"]) {
      assert.equal(judge({ state: { ...saved("paused", reason), resetHint: "Resets at 2026-11-21T12:00:00.000Z" }, ...gone }).pause?.resumeAt, undefined, reason);
    }
  });
});

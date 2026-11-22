import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAnswer, type Question } from "../../src/runs/inbox.js";

describe("questions", () => {
  it("turns an answer into the question's kind", () => {
    const base: Question = { id: "q", runId: "r", scope: "r", callIndex: 1, hash: "h", workflow: "w", prompt: "?", kind: "confirm", breakpoint: false, askedAt: "" };
    assert.equal(normalizeAnswer(base, "yes"), true);
    assert.equal(normalizeAnswer(base, "no"), false);
    assert.equal(normalizeAnswer({ ...base, kind: "input" }, "blue"), "blue");
  });
});

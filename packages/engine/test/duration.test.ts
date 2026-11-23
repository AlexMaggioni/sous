import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDurationSeconds } from "../src/duration.js";

describe("parseDurationSeconds", () => {
  it("reads numbers and units", () => {
    assert.equal(parseDurationSeconds(90), 90);
    assert.equal(parseDurationSeconds("90s"), 90);
    assert.equal(parseDurationSeconds("10m"), 600);
    assert.equal(parseDurationSeconds("2h"), 7200);
    assert.equal(parseDurationSeconds("500ms"), 0.5);
    assert.equal(parseDurationSeconds("soon"), undefined);
    assert.equal(parseDurationSeconds(-1), undefined);
  });
});

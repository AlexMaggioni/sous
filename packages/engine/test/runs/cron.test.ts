import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cronMatches, nextRun, parseCron } from "../../src/runs/cron.js";

describe("cron", () => {
  it("matches minutes, ranges, steps and weekdays in local time", () => {
    const weekdays9 = parseCron("0 9 * * 1-5");
    assert.equal(cronMatches(weekdays9, new Date(2026, 10, 23, 9, 0)), true, "Monday 9:00");
    assert.equal(cronMatches(weekdays9, new Date(2026, 10, 22, 9, 0)), false, "Sunday");
    assert.equal(cronMatches(weekdays9, new Date(2026, 10, 23, 9, 1)), false);
    const every15 = parseCron("*/15 * * * *");
    assert.equal(cronMatches(every15, new Date(2026, 0, 1, 3, 45)), true);
    assert.equal(cronMatches(every15, new Date(2026, 0, 1, 3, 46)), false);
    assert.equal(cronMatches(parseCron("0 0 * * 7"), new Date(2026, 10, 22, 0, 0)), true, "7 is Sunday");
  });

  it("takes either day field when both are set, and the short forms", () => {
    const either = parseCron("0 0 1 * 1");
    assert.equal(cronMatches(either, new Date(2026, 10, 1, 0, 0)), true, "the 1st, a Sunday");
    assert.equal(cronMatches(either, new Date(2026, 10, 2, 0, 0)), true, "a Monday");
    assert.equal(cronMatches(either, new Date(2026, 10, 3, 0, 0)), false);
    assert.deepEqual(parseCron("@daily").fields, parseCron("0 0 * * *").fields);
  });

  it("finds the next run and refuses bad fields", () => {
    assert.deepEqual(nextRun(parseCron("30 14 * * *"), new Date(2026, 10, 21, 15, 0)), new Date(2026, 10, 22, 14, 30));
    assert.throws(() => parseCron("61 * * * *"), /minute/);
    assert.throws(() => parseCron("* * *"), /five fields/);
  });
});

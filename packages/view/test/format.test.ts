import { describe, expect, test } from "vitest";
import { clock, formatAgo, formatCost, formatDuration, formatTokens, lineCount, plural } from "../src/format.ts";

describe("formats, as DESIGN.md writes them", () => {
  test("durations read 840ms, 12s, 4m 08s and 1h 12m", () => {
    expect([840, 12_000, 248_000, 4_320_000].map(formatDuration)).toEqual(["840ms", "12s", "4m 08s", "1h 12m"]);
  });

  test("tokens read 980, 12.4k, 12k and 1.25M", () => {
    expect([980, 12_400, 12_000, 1_250_000].map(formatTokens)).toEqual(["980", "12.4k", "12k", "1.25M"]);
  });

  test("cost reads $0.42", () => {
    expect(formatCost(0.42)).toBe("$0.42");
    expect(formatCost(0.0024)).toBe("<$0.01");
    expect(formatCost(0)).toBe("$0.00");
  });

  test("times are relative under a day, then a date", () => {
    const now = Date.UTC(2026, 10, 25, 15, 0, 0);
    expect(formatAgo(now - 20_000, now)).toBe("just now");
    expect(formatAgo(now - 3 * 60_000, now)).toBe("3m ago");
    expect(formatAgo(now - 5 * 3_600_000, now)).toBe("5h ago");
    expect(formatAgo(now + 4 * 60_000, now)).toBe("in 4m");
    expect(formatAgo(now - 2 * 86_400_000, now)).toMatch(/^Nov 2[23]$/);
  });
});

describe("counts and clocks", () => {
  test("plural says one in the singular, and takes an odd plural", () => {
    expect([plural(1, "call"), plural(0, "call"), plural(3, "call"), plural(2, "branch", "branches")]).toEqual(["1 call", "0 calls", "3 calls", "2 branches"]);
  });

  test("a newline at the end closes the last line and starts no new one", () => {
    expect([lineCount("a"), lineCount("a\nb"), lineCount("a\nb\n"), lineCount("a\n\n"), lineCount("")]).toEqual([1, 2, 2, 2, 1]);
  });

  test("a clock reads 24 hours with seconds", () => {
    const at = new Date(2026, 10, 25, 14, 5, 9);
    expect(clock(at)).toBe("14:05:09");
    expect(clock(at.getTime())).toBe("14:05:09");
    expect(clock(at.toISOString())).toBe("14:05:09");
  });
});

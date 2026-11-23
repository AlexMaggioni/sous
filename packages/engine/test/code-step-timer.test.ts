// The time limit of a code step is a timer. It is cleared as soon as the step reports, so a step
// that ended early does not keep the process alive for the rest of its limit.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runCodeStep } from "../src/code-steps.js";

const LIMIT_MS = 123_457;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let limits: unknown[] = [];
let cleared: unknown[] = [];

beforeEach(() => {
  limits = [];
  cleared = [];
  globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
    const handle = (realSetTimeout as (...args: unknown[]) => unknown)(handler, ms, ...rest);
    if (ms === LIMIT_MS) limits.push(handle);
    return handle;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    cleared.push(handle);
    return realClearTimeout(handle);
  }) as typeof clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  for (const handle of limits) realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
});

describe("the time limit timer of a code step", () => {
  it("is cleared by the time a step that ended in time reports", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-timer-"));
    const result = await runCodeStep({ kind: "sh", command: "exit 0" }, { cwd, timeoutMs: LIMIT_MS });
    assert.equal(result.code, 0);
    assert.equal(limits.length, 1, "the step set one timer for its limit");
    assert.ok(cleared.includes(limits[0]), "the limit's timer was cleared");
  });

  it("is cleared by the time a step that could not start reports", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-timer-"));
    // A file without the right to run. The program cannot start, and the step fails at once.
    const file = join(cwd, "not-runnable");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o644);
    await assert.rejects(runCodeStep({ kind: "file", file }, { cwd, timeoutMs: LIMIT_MS }), /could not start/);
    assert.equal(limits.length, 1, "the step set one timer for its limit");
    assert.ok(cleared.includes(limits[0]), "the limit's timer was cleared before the failure was reported");
  });
});

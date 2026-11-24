import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readActions } from "../../src/runs/actions.js";
import { createRun } from "../../src/runs/launch.js";
import { updateRecord } from "../../src/runs/records.js";
import { tick } from "../../src/runs/service.js";
import { PERSON } from "../../src/testing.js";
import { plantState, setup } from "./fixture.js";

// Piece 7, review fixes. The service's own writes go into events.jsonl too, by sous, through the
// service: an automatic resume, and a prune or a gc that removes something. A chore that removes
// nothing adds no line.

const job = `export const meta = { name: 'job', description: 'j' }\nreturn 'done'`;
const NOW = new Date("2026-11-21T12:00:00.000Z");
const SERVICE = { kind: "service" };

function state(runId: string, status: "completed" | "paused", extra: Record<string, unknown> = {}) {
  const at = "2026-11-21T10:00:00.000Z";
  return { runId, status, startedAt: at, updatedAt: at, agents: [], logs: [], phases: [], ...extra };
}

const deps = { log: () => {}, notify: () => {}, now: NOW };

describe("piece 7: the service's own writes", () => {
  it("an automatic resume at the usage limit adds one resume line by sous through the service", () => {
    const { paths, projectDir } = setup({ job });
    const run = createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {} });
    const script = readFileSync(run.file, "utf8");
    plantState(paths, state(run.runId, "paused", { script, pauseReason: "usage_limit", resetHint: "Resets at 2026-11-21T10:30:00.000Z" }));
    const before = readActions(paths).length;
    tick(paths, () => {}, deps);
    const added = readActions(paths).slice(before);
    assert.deepEqual(
      added.map(({ act, by, through, runId, workflow }) => ({ act, by, through, runId, workflow })),
      [{ act: "resume", by: "sous", through: SERVICE, runId: run.runId, workflow: "job" }],
    );
  });

  it("a prune by the service that removes a run adds one prune line, and one that removes nothing adds none", () => {
    const { paths, projectDir } = setup({ job });
    writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder", keepDays: 7 }));
    tick(paths, () => {}, { ...deps, now: new Date(NOW.getTime() - 2 * 3600_000) });
    assert.deepEqual(readActions(paths, { act: "prune" }), [], "nothing to prune, no line");
    const record = createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {} });
    updateRecord(paths, record.runId, { createdAt: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() });
    plantState(paths, state(record.runId, "completed"));
    tick(paths, () => {}, deps);
    const pruned = readActions(paths, { act: "prune" });
    assert.equal(pruned.length, 1, JSON.stringify(pruned));
    assert.equal(pruned[0]!.by, "sous");
    assert.deepEqual(pruned[0]!.through, SERVICE);
    assert.deepEqual(pruned[0]!.value, [record.runId]);
  });

  it("a gc by the service that removes a worktree adds one gc line", () => {
    const { paths, projectDir } = setup({ job }, { defaultPlace: "worktree" });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
    tick(paths, () => {}, { ...deps, now: new Date(NOW.getTime() - 2 * 3600_000) });
    assert.deepEqual(readActions(paths, { act: "gc" }), [], "nothing to remove, no line");
    const record = createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {} });
    plantState(paths, state(record.runId, "completed"));
    tick(paths, () => {}, deps);
    const gc = readActions(paths, { act: "gc" });
    assert.equal(gc.length, 1, JSON.stringify(gc));
    assert.equal(gc[0]!.by, "sous");
    assert.deepEqual(gc[0]!.through, SERVICE);
    assert.deepEqual(gc[0]!.value, [record.branch]);
  });
});

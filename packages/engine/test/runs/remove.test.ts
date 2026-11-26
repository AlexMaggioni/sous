// The two removals of the page sous serve opens: one ended run, and one saved workflow to the
// home's trash. Each records its action with the person's write through the page.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readActions, type Who } from "../../src/runs/actions.js";
import { updateRecord } from "../../src/runs/records.js";
import { Refusal } from "../../src/runs/refusal.js";
import { removeRun, trashWorkflow } from "../../src/runs/remove.js";
import { readRun } from "../../src/runs/run.js";
import { readState } from "../../src/runs/store.js";
import { layout, plantState, plantTodayRun, setup, TODAY_ID } from "./fixture.js";

/** The person, through the page `sous serve` opens. */
const VIEW: Who = { by: "person", through: { kind: "person", via: "view" } };

/** The refusal a call throws, with its code, change and call. */
function refusalOf(call: () => unknown): Refusal {
  try {
    call();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  assert.fail("the call was not refused");
}

describe("removeRun", () => {
  it("removes a run that ended, keeps its worktree, and records the person's write through the view", () => {
    const { paths } = setup({});
    const record = plantTodayRun(paths, { worktree: true });
    assert.deepEqual(removeRun(paths, TODAY_ID, VIEW), { removed: TODAY_ID });
    assert.equal(refusalOf(() => readRun(paths, TODAY_ID)).code, "no_such_run");
    assert.ok(layout(paths, record.runId, record.cwd).includes("home/worktrees/<id>/"));
    const lines = readActions(paths, { act: "remove-run" });
    assert.equal(lines.length, 1);
    assert.deepEqual({ ...lines[0], at: undefined }, { at: undefined, act: "remove-run", by: "person", through: { kind: "person", via: "view" }, runId: TODAY_ID, workflow: "today" });
  });

  it("finds the run by a unique start of its id", () => {
    const { paths } = setup({});
    plantTodayRun(paths);
    assert.deepEqual(removeRun(paths, TODAY_ID.slice(0, 6), VIEW), { removed: TODAY_ID });
  });

  it("refuses a run a worker runs, and removes nothing", () => {
    const { paths } = setup({});
    const record = plantTodayRun(paths);
    updateRecord(paths, TODAY_ID, { pid: process.pid });
    const before = layout(paths, record.runId, record.cwd);
    const refusal = refusalOf(() => removeRun(paths, TODAY_ID, VIEW));
    assert.equal(refusal.code, "run_is_running");
    assert.equal(refusal.change, "Stop the run, then remove it.");
    assert.equal(refusal.call, `sous stop ${TODAY_ID} --json`);
    assert.deepEqual(layout(paths, record.runId, record.cwd), before);
    assert.deepEqual(readActions(paths), []);
  });

  it("refuses a paused run, which has not ended", () => {
    const { paths } = setup({});
    plantTodayRun(paths);
    const state = readState(paths, TODAY_ID)!;
    plantState(paths, { ...state, status: "paused", pausedAt: new Date().toISOString() });
    const refusal = refusalOf(() => removeRun(paths, TODAY_ID, VIEW));
    assert.equal(refusal.code, "run_not_ended");
    assert.match(refusal.message, /only a run that ended can be removed/);
    assert.equal(refusal.call, `sous stop ${TODAY_ID} --json`);
    assert.equal(readRun(paths, TODAY_ID).runId, TODAY_ID);
  });

  it("refuses a run whose lease another process holds", () => {
    const { paths } = setup({});
    plantTodayRun(paths, { liveLock: true });
    assert.equal(refusalOf(() => removeRun(paths, TODAY_ID, VIEW)).code, "run_is_running");
    assert.equal(readRun(paths, TODAY_ID).runId, TODAY_ID);
  });

  it("refuses an id no run has", () => {
    const { paths } = setup({});
    const refusal = refusalOf(() => removeRun(paths, "nope", VIEW));
    assert.equal(refusal.code, "no_such_run");
    assert.equal(refusal.call, "sous status --json");
  });
});

describe("trashWorkflow", () => {
  const script = "export const meta = { name: 'review', description: 'reviews' }\nreturn 1\n";

  it("moves the file to the home's trash, and a second one of the same name beside it", () => {
    const { paths, projectDir } = setup({ review: script });
    const file = join(projectDir, ".sous", "workflows", "review.js");
    assert.deepEqual(trashWorkflow(paths, projectDir, "review", VIEW), { removed: file, trash: join(paths.home, "trash", "review.js") });
    assert.equal(existsSync(file), false);
    writeFileSync(file, `${script}// the second\n`);
    assert.deepEqual(trashWorkflow(paths, projectDir, "review", VIEW), { removed: file, trash: join(paths.home, "trash", "review-2.js") });
    assert.equal(readFileSync(join(paths.home, "trash", "review.js"), "utf8"), script);
    assert.equal(readFileSync(join(paths.home, "trash", "review-2.js"), "utf8"), `${script}// the second\n`);
    const lines = readActions(paths, { act: "trash-workflow" });
    assert.deepEqual(
      lines.map(({ by, through, workflow, value }) => ({ by, through, workflow, value })),
      [
        { by: "person", through: { kind: "person", via: "view" }, workflow: "review", value: "review.js" },
        { by: "person", through: { kind: "person", via: "view" }, workflow: "review", value: "review-2.js" },
      ],
    );
  });

  it("trashes a file that does not parse", () => {
    const { paths, projectDir } = setup({ broken: "this is not a workflow (" });
    assert.equal(trashWorkflow(paths, projectDir, "broken", VIEW).trash, join(paths.home, "trash", "broken.js"));
  });

  it("refuses a name no folder has, and a path", () => {
    const { paths, projectDir } = setup({ review: script });
    for (const name of ["nope", join(projectDir, ".sous", "workflows", "review.js")]) {
      const refusal = refusalOf(() => trashWorkflow(paths, projectDir, name, VIEW));
      assert.equal(refusal.code, "no_such_workflow");
      assert.equal(refusal.call, "sous workflows --json");
    }
    assert.ok(existsSync(join(projectDir, ".sous", "workflows", "review.js")));
    assert.deepEqual(readActions(paths), []);
  });
});

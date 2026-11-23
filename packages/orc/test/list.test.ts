import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { loadRecord } from "@orchestrator/engine";
import { createRun, testHome, updateRecord } from "@orchestrator/engine/testing";
import { describe, it } from "node:test";
import { orc } from "./orc.js";
import "./harness-home.js";

// orc list: how many runs it shows, and the place column. The runs here never start, since the
// list reads only their records.

const ONE_STEP = `export const meta = { name: 'one', description: 'one step' }\nreturn await agent('go', { label: 'go' })`;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The ids of the rows `orc list` prints, in order. */
const rows = (out: string) => out.split("\n").filter((line) => /^\S+ +one /.test(line)).map((line) => line.split(" ")[0]!);

describe("orc list", () => {
  /** Make `count` runs, a minute apart, and return their ids oldest first. */
  function makeRuns(count: number) {
    const { paths, projectDir } = testHome({ one: ONE_STEP }, { defaultPlace: "folder" });
    const start = Date.parse("2026-11-20T10:00:00.000Z");
    const ids = Array.from({ length: count }, (_, i) => {
      const { runId } = createRun(paths, { workflow: "one", projectDir, inputs: {} });
      updateRecord(paths, runId, { createdAt: new Date(start + i * 60_000).toISOString() });
      return runId;
    });
    return { paths, ids };
  }

  it("shows the newest 20 runs and says how many are older, and --all shows every run", async () => {
    const { paths, ids } = makeRuns(22);
    const newest = [...ids].reverse();

    const shown = await orc(paths, ["list"]);
    assert.equal(shown.code, 0);
    assert.deepEqual(rows(shown.out), newest.slice(0, 20));
    assert.match(shown.out, /^\(2 older runs: orc list --all\)$/m);

    const all = await orc(paths, ["list", "--all"]);
    assert.equal(all.code, 0);
    assert.deepEqual(rows(all.out), newest);
    assert.doesNotMatch(all.out, /older runs/);
  });

  it("shows no hint when 20 runs or fewer exist", async () => {
    const { paths, ids } = makeRuns(20);
    const shown = await orc(paths, ["list"]);
    assert.deepEqual(rows(shown.out), [...ids].reverse());
    assert.doesNotMatch(shown.out, /older runs/);
  });

  it("limits --json to the newest 20 runs too, and --all --json lists every run", async () => {
    const { paths, ids } = makeRuns(21);
    const newest = [...ids].reverse();
    const ofRuns = async (...flags: string[]) => (JSON.parse((await orc(paths, ["list", "--json", ...flags])).out) as Array<{ runId: string }>).map((run) => run.runId);
    assert.deepEqual(await ofRuns(), newest.slice(0, 20));
    assert.deepEqual(await ofRuns("--all"), newest);
  });

  it("names the branch of a run in a worktree, the folder of a run in a folder, and scratch for a run with no place", async () => {
    const { paths, projectDir } = testHome({ one: ONE_STEP }, { defaultPlace: "folder" });
    git(projectDir, "init", "-q", "-b", "main");
    git(projectDir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
    const made = (place: "worktree" | "folder" | "none") => createRun(paths, { workflow: "one", projectDir, inputs: {}, place });
    const worktree = made("worktree");
    const folder = made("folder");
    const scratch = made("none");
    assert.ok(worktree.branch && worktree.cwd !== projectDir, "the worktree run has a branch and a folder of its own");

    const shown = await orc(paths, ["list", "--all"]);
    const where = (runId: string) => shown.out.split("\n").find((line) => line.startsWith(runId))?.replace(/^\S+ +\S+ +not started +\S+ +/, "");
    assert.deepEqual(
      { worktree: where(worktree.runId), folder: where(folder.runId), scratch: where(scratch.runId) },
      { worktree: worktree.branch, folder: loadRecord(paths, folder.runId)!.cwd, scratch: "scratch" },
    );
  });
});

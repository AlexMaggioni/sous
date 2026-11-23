import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadRecord, logFile, type HomePaths } from "@orchestrator/engine";
import { fakeRunner, inProcess, testHome } from "@orchestrator/engine/testing";
import { orc } from "./orc.js";

// orc run, orc resume and orc rerun, through main, with a launcher that runs each worker in this
// process. They start their workers the way they do for a user, with a fake runner for the steps.

// The agent lookup reads the harnesses' home folders. These tests give it empty ones.
const harnessHome = mkdtempSync(join(tmpdir(), "orc-harness-home-"));
process.env.CLAUDE_CONFIG_DIR = join(harnessHome, ".claude");
process.env.CODEX_HOME = join(harnessHome, ".codex");
process.env.XDG_CONFIG_HOME = join(harnessHome, ".config");
delete process.env.AGENTPRISM_DEFAULT_BACKEND;
// orc run asks the environment who starts it. These runs start as from a user's terminal.
for (const name of ["CLAUDECODE", "ORC_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete process.env[name];

const one = (prompt: string) => `export const meta = { name: 'one', description: 'one step' }
return await agent('${prompt}', { label: 'go' })`;
const two = (second: string) => `export const meta = { name: 'two', description: 'two steps' }
await agent('first', { label: 'first' })
return await agent('${second}', { label: 'second' })`;

/** What orc run, resume and rerun print when they start a worker. */
function started(paths: HomePaths, runId: string, word: "started" | "resumed"): string {
  const record = loadRecord(paths, runId)!;
  return `${word} ${runId}  ${record.workflow}  in ${record.cwd}\n  follow: orc wait ${runId}    log: orc log ${runId} -f\n`;
}

describe("orc starts workers through the launcher main takes", () => {
  it("orc run starts the run's worker and says how to follow it", async () => {
    const { paths, projectDir } = testHome({ one: one("go") });
    const { runner, calls } = fakeRunner(() => "done");
    const workers = inProcess({ inner: runner });
    const run = await orc(paths, ["run", "one", "--project", projectDir], { launch: workers.launch });
    assert.equal(workers.launched.length, 1);
    const { runId, mode } = workers.launched[0]!;
    assert.equal(mode, "start");
    assert.deepEqual(run, { code: 0, out: started(paths, runId, "started") });
    assert.equal(loadRecord(paths, runId)?.workflow, "one");
    assert.equal((await workers.ended(runId))?.status, "completed");
    assert.deepEqual(
      calls.map((call) => call.prompt),
      ["go"],
    );
  });

  it("orc run --wait starts the worker, prints its log, and then the result", async () => {
    const { paths, projectDir } = testHome({ one: one("go") });
    const workers = inProcess({ inner: fakeRunner(() => "done").runner });
    const run = await orc(paths, ["run", "one", "--wait", "--project", projectDir], { launch: workers.launch });
    const { runId } = workers.launched[0]!;
    assert.equal((await workers.ended(runId))?.status, "completed");
    const log = readFileSync(logFile(paths, runId), "utf8");
    assert.match(log, / completed {2}one\n$/);
    assert.deepEqual(run, { code: 0, out: `${log}result:\ndone\n` });
  });

  for (const [flag, prompt] of [
    ["--latest", "go again"],
    ["--same", "go"],
  ] as const) {
    it(`orc resume ${flag} starts a resume worker that runs the ${flag === "--latest" ? "edited" : "first"} workflow`, async () => {
      const { paths, projectDir } = testHome({ one: one("go") });
      let fail = true;
      const { runner, calls } = fakeRunner(() => {
        if (fail) throw new Error("the step failed");
        return "done";
      });
      const workers = inProcess({ inner: runner });
      assert.equal((await orc(paths, ["run", "one", "--project", projectDir], { launch: workers.launch })).code, 0);
      const { runId } = workers.launched[0]!;
      assert.equal((await workers.ended(runId))?.status, "paused");
      // The engine tries a failed step more than once before the run pauses.
      const tries = calls.length;
      assert.ok(calls.every((call) => call.prompt === "go"));

      writeFileSync(join(projectDir, ".orchestrator", "workflows", "one.js"), one("go again"));
      fail = false;
      const resumed = await orc(paths, ["resume", runId, flag], { launch: workers.launch });
      assert.deepEqual(resumed, { code: 0, out: started(paths, runId, "resumed") });
      assert.deepEqual(workers.launched, [
        { runId, mode: "start" },
        { runId, mode: "resume" },
      ]);
      assert.equal((await workers.ended(runId))?.status, "completed");
      assert.deepEqual(
        calls.slice(tries).map((call) => call.prompt),
        [prompt],
      );
    });
  }

  it("orc rerun --reuse starts a new run whose worker keeps the earlier run's unchanged steps", async () => {
    const { paths, projectDir } = testHome({ two: two("second") });
    const { runner, calls } = fakeRunner((call) => `${call.label} done`);
    const workers = inProcess({ inner: runner });
    assert.equal((await orc(paths, ["run", "two", "--project", projectDir], { launch: workers.launch })).code, 0);
    const earlier = workers.launched[0]!.runId;
    assert.equal((await workers.ended(earlier))?.status, "completed");

    writeFileSync(join(projectDir, ".orchestrator", "workflows", "two.js"), two("second, shorter"));
    const rerun = await orc(paths, ["rerun", earlier, "--reuse"], { launch: workers.launch });
    assert.equal(workers.launched.length, 2);
    const { runId, mode } = workers.launched[1]!;
    assert.notEqual(runId, earlier);
    assert.equal(mode, "start");
    assert.deepEqual(rerun, { code: 0, out: started(paths, runId, "started") });
    assert.equal(loadRecord(paths, runId)?.reuseFrom, earlier);
    assert.equal((await workers.ended(runId))?.status, "completed");
    assert.deepEqual(
      calls.map((call) => call.prompt),
      ["first", "second", "second, shorter"],
    );
  });
});

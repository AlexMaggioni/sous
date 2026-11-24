import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRecords, loadRecord } from "@sous/engine";
import { fakeRunner, inProcess, testHome } from "@sous/engine/testing";
import { sous } from "./sous.js";

// sous run --model, --set and --concurrency, through main with a launcher that runs the worker in
// this process. The fake runner notes what each step got, and how many steps ran at once.

// sous run asks the environment who starts it. These runs start as from a user's terminal.
for (const name of ["CLAUDECODE", "SOUS_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete process.env[name];

const FAN = `export const meta = { name: 'fan', description: 'three steps at once, and one that names its model' }
return await parallel([
  () => agent('a', { label: 'a' }),
  () => agent('b', { label: 'b' }),
  () => agent('c', { label: 'c' }),
  () => agent('d', { label: 'd', model: 'claude/haiku' }),
])`;

/**
 * Run `sous run fan` with these flags. Each step holds for `hold` ms, or with "together" until two
 * steps have run at once, for up to 10 seconds. Returns what the run did and the steps' calls.
 */
async function runFan(flags: string[], hold: number | "together" = 0) {
  const { paths, projectDir } = testHome({ fan: FAN });
  let live = 0;
  let peak = 0;
  const { runner, calls } = fakeRunner(async () => {
    live++;
    peak = Math.max(peak, live);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    if (hold === "together") for (let waited = 0; peak < 2 && waited < 10_000; waited += 5) await sleep(5);
    else await sleep(hold);
    live--;
    return "ok";
  });
  const workers = inProcess({ inner: runner });
  const run = await sous(paths, ["run", "fan", "--project", projectDir, ...flags], { launch: workers.launch });
  const runId = workers.launched[0]?.runId;
  const result = runId ? await workers.ended(runId) : undefined;
  const byLabel = (key: string) => Object.fromEntries(calls.map((call) => [call.label, call.options[key]]));
  return { paths, run, runId, result, calls, peak: () => peak, byLabel };
}

describe("sous run --model", () => {
  it("sets the model of each step that names none, and keeps the model a step names", async () => {
    const fan = await runFan(["--model", "codex/gpt-9"]);
    assert.equal(fan.run.code, 0, fan.run.out);
    assert.equal(fan.result?.status, "completed");
    assert.equal(loadRecord(fan.paths, fan.runId!)?.defaultModel, "codex/gpt-9");
    assert.deepEqual(fan.byLabel("model"), { a: "codex/gpt-9", b: "codex/gpt-9", c: "codex/gpt-9", d: "claude/haiku" });
  });

  it("leaves each step on its program's own model without the flag", async () => {
    const fan = await runFan([]);
    assert.equal(loadRecord(fan.paths, fan.runId!)?.defaultModel, undefined);
    assert.deepEqual(fan.byLabel("model"), { a: undefined, b: undefined, c: undefined, d: "claude/haiku" });
  });
});

describe("sous run --set", () => {
  it("sets an option of the steps with that label, and merges the options of one label", async () => {
    const fan = await runFan(["--set", "b.model=claude/opus", "--set", "b.effort=high", "--set", "c.effort=low", "--set", "d.model=codex/gpt-9"]);
    assert.equal(fan.run.code, 0, fan.run.out);
    assert.deepEqual(loadRecord(fan.paths, fan.runId!)?.overrides, { b: { model: "claude/opus", effort: "high" }, c: { effort: "low" }, d: { model: "codex/gpt-9" } });
    assert.deepEqual(fan.byLabel("model"), { a: undefined, b: "claude/opus", c: undefined, d: "codex/gpt-9" });
    assert.deepEqual(fan.byLabel("effort"), { a: undefined, b: "high", c: "low", d: undefined });
  });

  it("wins over --model for the step it names", async () => {
    const fan = await runFan(["--model", "codex/gpt-9", "--set", "a.model=claude/opus"]);
    assert.deepEqual(fan.byLabel("model"), { a: "claude/opus", b: "codex/gpt-9", c: "codex/gpt-9", d: "claude/haiku" });
  });

  it("refuses a value with no label.key=value form, and starts nothing", async () => {
    for (const bad of ["effort=high", "b.effort", "=high", ".effort=high"]) {
      const fan = await runFan(["--set", bad]);
      assert.deepEqual(fan.run, { code: 64, out: `usage: --set needs label.key=value, got "${bad}"\n  change: Fix the command line. sous help lists the commands and their flags.\n` });
      assert.equal(fan.runId, undefined, "no worker started");
      assert.deepEqual(listRecords(fan.paths), [], "no run was made");
    }
  });
});

describe("sous run --concurrency", () => {
  it("runs at most that many steps at once", async () => {
    const fan = await runFan(["--concurrency", "1"], 30);
    assert.equal(fan.run.code, 0, fan.run.out);
    assert.equal(fan.result?.status, "completed");
    assert.equal(loadRecord(fan.paths, fan.runId!)?.concurrency, 1);
    assert.equal(fan.peak(), 1);
    assert.equal(fan.calls.length, 4);
  });

  it("lets the steps of a parallel step run together without the flag", async () => {
    const fan = await runFan([], "together");
    assert.equal(fan.result?.status, "completed");
    assert.equal(loadRecord(fan.paths, fan.runId!)?.concurrency, undefined);
    assert.ok(fan.peak() > 1, `peak was ${fan.peak()}`);
  });
});

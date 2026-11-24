// A resume of a run whose workflow changed, with neither --latest nor --same, refuses with
// bad_argument. Its call is the first of its next calls, and no call it offers is refused in turn:
// --latest comes first when this caller's --latest would go through, which a person's does, and an
// agent's does once the person approved the new text. Else the diff to show the person comes
// first, and --latest is not offered. --same comes last.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startRun, type HomePaths } from "@sous/engine";
import { fakeRunner, inProcess, testHome, WorkflowError, WorkflowErrorCode, PERSON } from "@sous/engine/testing";
import { sous } from "./sous.js";

const PERSON_ENV: NodeJS.ProcessEnv = {};
const CLAUDE_ENV: NodeJS.ProcessEnv = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };

const one = (version: string) => `export const meta = { name: 'one', description: 'one step' }\nreturn await agent('${version}', { label: 'build' })`;

interface Next {
  call: string;
  does: string;
}
interface ErrorBody {
  code: string;
  message: string;
  change: string;
  call: string | null;
  next?: Next[];
}

/** A run of `one` paused at its failed step, with its file edited since it started. */
async function editedRun() {
  const { paths, projectDir } = testHome({ one: one("v1") }, { retries: 1 });
  let broken = true;
  const { runner, calls } = fakeRunner((call) => {
    if (broken) throw new WorkflowError("the tests fail", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
    return `${call.prompt} done`;
  });
  const workers = inProcess({ inner: runner });
  const record = startRun(paths, workers.launch, { who: PERSON, workflow: "one", projectDir, inputs: {} });
  assert.equal((await workers.ended(record.runId))?.status, "paused");
  writeFileSync(join(projectDir, ".sous", "workflows", "one.js"), one("v2"));
  return { paths, projectDir, runId: record.runId, workers, calls, fix: () => (broken = false) };
}

/** The error of a call that must fail with 64. */
function errorOf(called: { code: number; out: string }): ErrorBody {
  assert.equal(called.code, 64, called.out);
  return (JSON.parse(called.out) as { error: ErrorBody }).error;
}

/** Run a call an error offers, as an argv. */
const argv = (call: string): string[] => call.replace(/^sous /, "").split(" ");

/** The resume the person typed, in the same env. */
const resume = (paths: HomePaths, runId: string, env: NodeJS.ProcessEnv, launch: ReturnType<typeof inProcess>["launch"], ...more: string[]) =>
  sous(paths, ["resume", runId, ...more, "--json"], { env, launch });

describe("sous resume of a run whose workflow changed", () => {
  it("offers a person --latest first, then --same, and its call is --latest", async () => {
    const { paths, runId, workers, calls, fix } = await editedRun();
    const error = errorOf(await resume(paths, runId, PERSON_ENV, workers.launch));
    assert.equal(error.code, "bad_argument");
    assert.deepEqual(error.next?.map((next) => next.call), [`sous resume ${runId} --latest --json`, `sous resume ${runId} --same --json`]);
    assert.equal(error.call, error.next?.[0]?.call, "the call is the first next call");
    assert.ok(error.next?.every((next) => next.does.length > 0), "each next call says what it does");
    assert.equal(workers.launched.length, 1, "a resume that must choose starts no worker");

    fix();
    const taken = await sous(paths, argv(error.call!), { env: PERSON_ENV, launch: workers.launch });
    assert.equal(taken.code, 0, `the call is not refused: ${taken.out}`);
    assert.equal((await workers.ended(runId))?.result, "v2 done", "--latest takes the new version");
    assert.equal(calls.at(-1)?.prompt, "v2");
  });

  it("offers an agent the diff first when the new text has no yes, and no --latest, which would be refused", async () => {
    const { paths, projectDir, runId, workers } = await editedRun();
    const error = errorOf(await resume(paths, runId, CLAUDE_ENV, workers.launch));
    const diff = `sous workflows show one --diff --json --project ${projectDir}`;
    assert.deepEqual(error.next?.map((next) => next.call), [diff, `sous resume ${runId} --same --json`]);
    assert.equal(error.call, diff);
    assert.match(error.change, /sous workflows approve one --by person --json/, "the change says how the person's yes is recorded");
    assert.match(error.change, new RegExp(`sous resume ${runId} --latest --json`), "the change gives --latest for after the yes");

    // No call offered is refused in turn.
    const shown = await sous(paths, argv(diff), { env: CLAUDE_ENV });
    assert.equal(shown.code, 0, shown.out);
    const latest = await resume(paths, runId, CLAUDE_ENV, workers.launch, "--latest");
    assert.equal(latest.code, 66, `the --latest left out is the one refused: ${latest.out}`);
  });

  it("offers an agent --latest first once the person approved the new text", async () => {
    const { paths, projectDir, runId, workers, fix } = await editedRun();
    const approved = await sous(paths, ["workflows", "approve", "one", "--by", "person", "--json", "--project", projectDir], { env: CLAUDE_ENV });
    assert.equal(approved.code, 0, approved.out);
    const error = errorOf(await resume(paths, runId, CLAUDE_ENV, workers.launch));
    assert.deepEqual(error.next?.map((next) => next.call), [`sous resume ${runId} --latest --json`, `sous resume ${runId} --same --json`]);
    fix();
    const taken = await sous(paths, argv(error.call!), { env: CLAUDE_ENV, launch: workers.launch });
    assert.equal(taken.code, 0, `the call is not refused: ${taken.out}`);
    assert.equal((await workers.ended(runId))?.result, "v2 done");
  });

  it("keeps the note in each resume it offers, and prints the next calls in text", async () => {
    const { paths, runId, workers } = await editedRun();
    const error = errorOf(await resume(paths, runId, PERSON_ENV, workers.launch, "--note", "use the new linter"));
    assert.deepEqual(error.next?.map((next) => next.call), [
      `sous resume ${runId} --latest --note 'use the new linter' --json`,
      `sous resume ${runId} --same --note 'use the new linter' --json`,
    ]);
    const text = await sous(paths, ["resume", runId], { env: PERSON_ENV, launch: workers.launch });
    assert.equal(text.code, 64);
    const tries = text.out.split("\n").filter((line) => line.startsWith("  try: "));
    assert.deepEqual(tries.map((line) => line.split("  (")[0]), [`  try: sous resume ${runId} --latest --json`, `  try: sous resume ${runId} --same --json`]);
  });
});

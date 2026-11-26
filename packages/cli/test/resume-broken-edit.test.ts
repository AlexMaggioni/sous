// A resume of a run whose workflow changed into a text that does not load, with neither --latest
// nor --same, refuses with bad_argument and names what is wrong with the new text. --latest cannot
// take that text, and sous check on it is refused too, so the only call it offers is --same, which
// goes on with the text the run started with.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startRun } from "@sous-run/engine";
import { fakeRunner, inProcess, testHome, WorkflowError, WorkflowErrorCode, PERSON } from "@sous-run/engine/testing";
import { sous } from "./sous.js";

const PERSON_ENV: NodeJS.ProcessEnv = {};
const CLAUDE_ENV: NodeJS.ProcessEnv = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };

const META = "export const meta = { name: 'one', description: 'one step' }";
const one = (version: string) => `${META}\nreturn await agent('${version}', { label: 'build' })`;
const BROKEN = {
  "a syntax error": `${META}\nreturn await agent('v2', { label: 'build' }`,
  "an API a workflow may not use": `${META}\nconst at = Date.now()\nreturn await agent('v2', { label: 'build' })`,
};

interface ErrorBody {
  code: string;
  message: string;
  change: string;
  call: string | null;
  next?: Array<{ call: string; does: string }>;
}

/** A run of `one` paused at its failed step, with its file since edited to `text`. */
async function editedRun(text: string) {
  const { paths, projectDir } = testHome({ one: one("v1") }, { retries: 1 });
  let broken = true;
  const { runner } = fakeRunner((call) => {
    if (broken) throw new WorkflowError("the tests fail", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
    return `${call.prompt} done`;
  });
  const workers = inProcess({ inner: runner });
  const record = startRun(paths, workers.launch, { who: PERSON, workflow: "one", projectDir, inputs: {} });
  assert.equal((await workers.ended(record.runId))?.status, "paused");
  writeFileSync(join(projectDir, ".sous", "workflows", "one.js"), text);
  return { paths, runId: record.runId, workers, fix: () => (broken = false) };
}

const argv = (call: string): string[] => call.replace(/^sous /, "").split(" ");

describe("sous resume of a run whose workflow changed into a text that does not load", () => {
  for (const [what, text] of Object.entries(BROKEN)) {
    for (const [who, env] of [["a person", PERSON_ENV], ["an agent", CLAUDE_ENV]] as const) {
      it(`after ${what}, offers ${who} --same alone, and it runs the text the run started with`, async () => {
        const { paths, runId, workers, fix } = await editedRun(text);
        const printed = await sous(paths, ["resume", runId, "--json"], { env, launch: workers.launch });
        assert.equal(printed.code, 64, printed.out);
        const error = (JSON.parse(printed.out) as { error: ErrorBody }).error;
        assert.equal(error.code, "bad_argument");
        const same = `sous resume ${runId} --same --json`;
        assert.equal(error.call, same);
        assert.deepEqual(error.next ?? [], [], "one call is offered, so there is no list");
        assert.match(error.message, /one\.js does not parse/, "the message says the new text does not load");
        assert.match(error.change, new RegExp(`sous resume ${runId} --latest --json`), "the change gives --latest for after the fix");

        fix();
        const ran = await sous(paths, argv(error.call!), { env, launch: workers.launch });
        assert.equal(ran.code, 0, `the call is not refused: ${ran.out}`);
        assert.equal((await workers.ended(runId))?.result, "v1 done", "--same runs the text the run started with");
      });
    }
  }
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRecord, workerProcess, type HomePaths, type Launcher } from "@sous/engine";
import { readState, testHome } from "@sous/engine/testing";
import { sous } from "./sous.js";
import { callProblem, words } from "./helpers/calls.js";

// The review of piece 13, `sous resume --note`: a note never goes to a step that takes no
// message, reaches the nested run that runs again, checks its step against the text the resume
// runs, and never outlives the go it was for.

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKES = resolve(HERE, "../../../test/fakes");
const CLI = resolve(HERE, "../dist/cli.js");
for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "SOUS_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];

const NOTE = "Use the v2 API.";
const wf = (name: string, body: string) => `export const meta = { name: '${name}', description: '${name}', place: 'none' }\n${body}`;
const ag = (label: string, text: string) => `await agent('${text}', { label: '${label}', model: 'claude/haiku' })`;
const steps = (labels: string[]) => labels.map((label) => ag(label, `Do ${label.toUpperCase()}.`)).join("\n") + "\nreturn 'done'";
/** A code step that fails once, then passes: the project keeps a mark of the first go. */
const flaky = (label: string) => `await sh('test -f "$SOUS_PROJECT/ok" || { touch "$SOUS_PROJECT/ok"; exit 3; }', { label: '${label}' })`;

/** The fakes' rules, and the prompts they got, in a folder of their own. */
function fakes(rules: object[]) {
  const dir = mkdtempSync(join(tmpdir(), "sous-note-review-"));
  process.env.FAKE_LOG = join(dir, "fake.log");
  process.env.FAKE_RULES = join(dir, "rules.json");
  writeFileSync(process.env.FAKE_RULES, JSON.stringify(rules));
  const log = process.env.FAKE_LOG;
  return {
    prompts: (): string[] =>
      (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { prompt?: string }) : []).flatMap((line) =>
        line.prompt === undefined ? [] : [line.prompt],
      ),
  };
}

function printedJson(printed: { code: number; out: string }): Record<string, any> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  return parsed as Record<string, any>;
}

async function untilHolds(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const workerGone = (paths: HomePaths, runId: string) => loadRecord(paths, runId)?.pid === undefined;

/** Start a workflow on a worker process of its own, and wait for it to pause. */
async function paused(workflows: Record<string, string>, start: string, rules: object[]) {
  const fake = fakes(rules);
  const { paths, projectDir } = testHome(workflows, { claudePath: join(FAKES, "claude"), codexPath: join(FAKES, "codex"), retries: 0 });
  const run = await sous(paths, ["run", start, "--json", "--project", projectDir]);
  assert.equal(run.code, 0, run.out);
  const runId = printedJson(run).runId as string;
  await untilHolds(() => readState(paths, runId)?.status === "paused" && workerGone(paths, runId), "the run to pause");
  return { paths, projectDir, runId, fake, ran: fake.prompts().length };
}

/** Wait for a resumed run to end, and stop it when it does not. */
async function ended(paths: HomePaths, runId: string): Promise<void> {
  try {
    await untilHolds(() => readState(paths, runId)?.status !== "paused" && workerGone(paths, runId), "the resumed run to end");
  } catch (error) {
    await sous(paths, ["stop", runId, "--json"]);
    throw error;
  }
}

/** A refused resume: the code, and the run still paused with no worker and no new prompt. */
function assertRefused(printed: { code: number; out: string }, code: string, run: { paths: HomePaths; runId: string; fake: { prompts(): string[] }; ran: number }): void {
  const { error } = printedJson(printed);
  assert.equal(error?.code, code, printed.out);
  assert.equal(callProblem(error.call), undefined, callProblem(error.call));
  assert.equal(readState(run.paths, run.runId)?.status, "paused", "the run did not resume");
  assert.ok(workerGone(run.paths, run.runId), "no worker started");
  assert.equal(run.fake.prompts().length, run.ran, "no step ran");
}

describe("piece 13 review: sous resume --note", () => {
  it("--step naming a code step, one the run had or one its text writes, is refused with step_takes_no_message", async () => {
    const run = await paused({ code: wf("code", `${ag("a", "Do A.")}\n${flaky("boom")}\n${ag("c", "Do C.")}\nawait sh('true', { label: 'tidy' })\nreturn 'done'`) }, "code", []);
    for (const step of ["boom", "tidy"]) {
      const printed = await sous(run.paths, ["resume", run.runId, "--note", NOTE, "--step", step, "--json"]);
      assert.equal(printed.code, 66, `--step ${step}: ${printed.out}`);
      assertRefused(printed, "step_takes_no_message", run);
    }
  });

  it("the resume call tell gives for a name two parallel nested runs share reaches the one that runs again", async () => {
    const child = wf("child", "return await agent('Build part ' + args.i + '.', { label: 'impl', model: 'claude/haiku' })");
    const par = wf(
      "par",
      `const r = await Promise.allSettled([1, 2].map((i) => workflow('child', { i }, { label: 'sub' })))\nif (r.some((x) => x.status === 'rejected')) throw new Error('a sub failed')\n${ag("after", "Do after.")}\nreturn 'done'`,
    );
    const { paths, runId, fake, ran } = await paused({ child, par }, "par", [
      { match: "Build part 1", fail: "broken", times: 1 },
      { match: "Build part 2", delayMs: 300, answer: "ok" },
    ]);
    const refusal = await sous(paths, ["tell", runId, "--step", "sub: impl", NOTE, "--json"]);
    assert.equal(refusal.code, 65, refusal.out);
    const call = printedJson(refusal).error.call as string;
    assert.match(call, new RegExp(`^sous resume ${runId} --note `), call);
    const printed = await sous(paths, words(call).slice(1));
    assert.equal(printed.code, 0, `${call} runs as given:\n${printed.out}`);
    await ended(paths, runId);
    assert.equal(readState(paths, runId)?.status, "completed");
    const live = fake.prompts().slice(ran);
    const part = live.filter((prompt) => prompt.includes("Build part 1"));
    assert.equal(part.length, 1, `part 1 ran again: ${JSON.stringify(live)}`);
    assert.ok(part[0]!.trimEnd().endsWith(NOTE), `part 1's prompt ends with the note:\n${part[0]}`);
    assert.ok(live.every((prompt) => prompt.includes("Build part 1") || !prompt.includes(NOTE)), `no other call got the note: ${JSON.stringify(live)}`);
  });

  it("resume --latest checks --step against the new text: a label only the old text wrote is refused, and one only the new text writes gets the note", async () => {
    const run = await paused({ abc: wf("abc", steps(["a", "b", "c"])) }, "abc", [{ match: "Do B", fail: "broken", times: 1 }]);
    const { paths, projectDir, runId, fake, ran } = run;
    writeFileSync(join(projectDir, ".sous", "workflows", "abc.js"), wf("abc", steps(["a", "b", "d"])));
    const old = await sous(paths, ["resume", runId, "--latest", "--note", NOTE, "--step", "c", "--json"]);
    assert.equal(old.code, 65, old.out);
    assertRefused(old, "no_such_step", run);

    const printed = await sous(paths, ["resume", runId, "--latest", "--note", NOTE, "--step", "d", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    await ended(paths, runId);
    assert.equal(readState(paths, runId)?.status, "completed");
    const live = fake.prompts().slice(ran);
    assert.equal(live.length, 2, `the resume ran B and D: ${JSON.stringify(live)}`);
    assert.ok(!live[0]!.includes(NOTE), `B got no note:\n${live[0]}`);
    assert.match(live[1]!, /Do D\./);
    assert.ok(live[1]!.trimEnd().endsWith(NOTE), `D's prompt ends with the note:\n${live[1]}`);
  });

  it("a note whose worker refused to start never reaches a later resume", async () => {
    const abc = wf("abc", steps(["a", "b", "c"]));
    const { paths, projectDir, runId, fake, ran } = await paused({ abc }, "abc", [{ match: "Do B", fail: "broken", times: 1 }]);
    const file = join(projectDir, ".sous", "workflows", "abc.js");
    writeFileSync(file, `${abc}\n// edit 1\n`);
    const real = workerProcess(() => CLI);
    // The file changes again between the resume's check and the worker's read, so the worker refuses.
    const launch: Launcher = (home, id, mode) => {
      writeFileSync(file, `${abc}\n// edit 2\n`);
      real(home, id, mode);
    };
    const first = await sous(paths, ["resume", runId, "--latest", "--note", "FIRST NOTE", "--json"], { launch });
    assert.equal(first.code, 0, first.out);
    await untilHolds(() => workerGone(paths, runId) && loadRecord(paths, runId)?.refused !== undefined, "the worker to refuse");

    const second = await sous(paths, ["resume", runId, "--same", "--json"]);
    assert.equal(second.code, 0, second.out);
    await ended(paths, runId);
    const live = fake.prompts().slice(ran);
    assert.ok(live.length > 0, "the second resume ran the steps");
    assert.ok(live.every((prompt) => !prompt.includes("FIRST NOTE")), `no call got the first resume's note: ${JSON.stringify(live)}`);
  });

  it("a note no agent call took says so in sous log, and an empty --note is a usage error", async () => {
    const { paths, runId } = await paused({ code: wf("code", `${ag("a", "Do A.")}\n${flaky("boom")}\nreturn 'done'`) }, "code", []);
    const empty = await sous(paths, ["resume", runId, "--note", "", "--json"]);
    assert.equal(empty.code, 64, empty.out);
    assert.equal(printedJson(empty).error?.code, "bad_argument", empty.out);
    assert.equal(readState(paths, runId)?.status, "paused", "the run did not resume");

    const printed = await sous(paths, ["resume", runId, "--note", NOTE, "--json"]);
    assert.equal(printed.code, 0, printed.out);
    await ended(paths, runId);
    const log = await sous(paths, ["log", runId]);
    assert.equal(log.code, 0, log.out);
    assert.match(log.out, /note .*reached no step/, log.out);
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { listRecords, logFile } from "@orchestrator/engine";
import { testHome } from "@orchestrator/engine/testing";
import { orc } from "./orc.js";
import "./harness-home.js";

// The note line in a run's log: a step asks for something its program cannot do, and the log
// says so beside the step. The run is a worker process of its own on the fake programs in
// test/fakes, as a user's run is, so the line goes through the worker's real log file.

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
for (const name of ["CLAUDECODE", "ORC_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];

const noted = `export const meta = { name: 'noted', description: 'steps that ask for more than their program does' }
await agent('plain', { label: 'plain', model: 'codex/gpt-fake' })
await agent('with skills', { label: 'skilled', model: 'codex/gpt-fake', skills: ['review'] })
await agent('careful', { label: 'careful', model: 'claude/haiku', mode: 'careful' })
return 'done'`;

describe("the note line in a run's log", () => {
  it("names the step and what its program could not do, once, between the step's start and its end", async () => {
    const { paths, projectDir } = testHome({ noted }, { claudePath: join(FAKES, "claude"), codexPath: join(FAKES, "codex") });
    const dir = mkdtempSync(join(tmpdir(), "orc-note-"));
    process.env.FAKE_LOG = join(dir, "fake.log");
    process.env.FAKE_RULES = join(dir, "rules.json");
    writeFileSync(process.env.FAKE_RULES, "[]");

    const run = await orc(paths, ["run", "noted", "--wait", "--project", projectDir]);
    assert.equal(run.code, 0, run.out);
    const [record] = listRecords(paths);

    // The worker wrote the run's log file, which orc log reads. Drop the time at the start of each line.
    const lines = (text: string) => text.split("\n").filter(Boolean).map((line) => line.slice(9));
    const logs = lines(readFileSync(logFile(paths, record!.runId), "utf8"));
    const of = (label: string) => logs.filter((line) => new RegExp(`^(start|note|done) +${label}\\b`).test(line));
    assert.deepEqual(of("plain").map((line) => line.split(/[ ,]/)[0]), ["start", "done"], "a step that gets all it asked for has no note");
    assert.deepEqual(of("skilled").slice(0, 2), ["start      skilled (codex/gpt-fake)", "note       skilled: Codex gets no skills from a step, so review did not reach it."]);
    assert.match(of("skilled")[2]!, /^done {7}skilled/);
    assert.equal(of("skilled").length, 3);
    assert.deepEqual(of("careful").slice(0, 2), ["start      careful (claude/haiku)", "note       careful: Claude Code has no permission mode careful, so the user's default stays."]);
    assert.match(of("careful")[2]!, /^done {7}careful/);
    assert.equal(logs.filter((line) => line.startsWith("note ")).length, 2);
  });
});

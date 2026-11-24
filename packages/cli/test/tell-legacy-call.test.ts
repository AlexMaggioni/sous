// Piece 12 re-check, a tell request with no call index, as a state with no index saves it. The run
// has two calls labeled impl, both held in a tool call by the Claude fake. The request names two
// calls of impl with no index. The worker gives each the first open call of the label that no
// other call took, so each session gets the message once, and each call gets one receipt.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRecord, type HomePaths } from "@sous/engine";
import { requestTell, testHome } from "@sous/engine/testing";
import { sous } from "./sous.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "SOUS_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];

const PERSON: NodeJS.ProcessEnv = {};
const MESSAGE = "Use the v2 API.";

const WORKFLOWS = {
  pair: "export const meta = { name: 'pair', description: 'pair', place: 'none' }\nreturn await parallel([() => agent('Build part one.', { label: 'impl', model: 'claude/haiku' }), () => agent('Build part two.', { label: 'impl', model: 'claude/haiku' })])",
};

/** Each call runs one tool call and stays in it until the test writes the gate file "go". */
const HELD = [{ match: "Build", tool: "echo working", hold: "go", answer: "Done." }];

interface LogLine {
  sessionId?: string;
  prompt?: string;
  steer?: { id: string | null; text: string };
  state?: string;
}

interface Receipt {
  kind: string;
  id?: string;
  label?: string;
  callIndex?: number;
  text: string;
}

/** The fakes' log and rules, in a folder of their own. */
function fakePlace() {
  const dir = mkdtempSync(join(tmpdir(), "sous-tell-legacy-"));
  process.env.FAKE_LOG = join(dir, "fake.log");
  process.env.FAKE_RULES = join(dir, "rules.json");
  writeFileSync(process.env.FAKE_RULES, JSON.stringify(HELD));
  const log = process.env.FAKE_LOG;
  return {
    gate: (name: string) => writeFileSync(join(dir, name), ""),
    lines: (): LogLine[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine) : []),
  };
}

/** The run's saved activity, read as the file holds it. */
function activity(paths: HomePaths, runId: string): Receipt[] {
  const file = join(paths.records, `${runId}.activity.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Receipt) : [];
}

/** Poll a read until it holds, or 20 seconds pass. */
async function until(ready: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await ready()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** The call runs and is inside its tool call. */
async function inTool(paths: HomePaths, runId: string, call: number): Promise<void> {
  await until(async () => {
    const printed = await sous(paths, ["step", runId, "impl", "--call", String(call), "--json"], { env: PERSON });
    if (printed.code !== 0) return false;
    const shown = JSON.parse(printed.out) as { status?: string; activity?: Receipt[] };
    return shown.status === "running" && (shown.activity ?? []).some((line) => line.kind === "tool");
  }, `call ${call} of impl to run its tool call`);
}

describe("piece 12 re-check: a tell request with no call index", () => {
  it("gives each call the first open call of its label that no other call took", async () => {
    const place = fakePlace();
    const { paths, projectDir } = testHome(WORKFLOWS, { claudePath: join(FAKES, "claude"), codexPath: join(FAKES, "codex") });
    const run = await sous(paths, ["run", "pair", "--json", "--project", projectDir], { env: PERSON });
    assert.equal(run.code, 0, run.out);
    const runId = (JSON.parse(run.out) as { runId: string }).runId;
    try {
      await inTool(paths, runId, 1);
      await inTool(paths, runId, 2);
      const id = randomUUID();
      requestTell(paths, runId, { id, step: "impl", text: MESSAGE, calls: [{ scope: runId, label: "impl" }, { scope: runId, label: "impl" }] });
      process.kill(loadRecord(paths, runId)!.pid!, "SIGUSR2");

      // Each session gets the message once. The fake logs it as queued when it comes, and the call
      // reads it after its tool call, which ends when the gate opens.
      const sessions = place.lines().filter((line) => line.prompt?.includes("Build part") && !line.steer).map((line) => line.sessionId);
      assert.equal(new Set(sessions).size, 2, "the fakes logged two sessions");
      const queued = () => place.lines().filter((line) => line.steer?.text === MESSAGE && line.state === "queued");
      await until(() => queued().length >= 2, "both sessions to get the message");
      place.gate("go");
      await until(() => activity(paths, runId).filter((line) => line.kind === "tell" && line.id === id).length >= 2, "a receipt for each call");
      assert.deepEqual(
        queued()
          .map((line) => line.sessionId)
          .sort(),
        [...sessions].sort(),
        "each session got the message once",
      );
      const receipts = activity(paths, runId).filter((line) => line.kind === "tell" && line.id === id);
      assert.deepEqual(
        receipts.map((line) => [line.label, line.text]),
        [
          ["impl", "delivered"],
          ["impl", "delivered"],
        ],
      );
      assert.equal(new Set(receipts.map((line) => line.callIndex)).size, 2, `the two receipts name two calls: ${JSON.stringify(receipts)}`);
    } finally {
      place.gate("go");
      await until(() => loadRecord(paths, runId)?.pid === undefined, "the worker to end").catch(async () => {
        await sous(paths, ["stop", runId, "--json"], { env: PERSON });
      });
    }
  });
});

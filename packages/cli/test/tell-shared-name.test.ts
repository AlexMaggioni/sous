// Piece 12 re-check, two nested runs that share a name. The run starts two nested runs, both
// labeled "sub", so sous log names both their steps "sub: impl". One step ends at once and the
// other is held in a tool call by the Claude fake. `sous step --call` counts the calls of both
// runs, so each is reachable. A tell to "sub: impl" reaches the held one, whatever order they
// started in, and each `sous step` call in the reply shows it.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRecord, type HomePaths } from "@sous/engine";
import { testHome } from "@sous/engine/testing";
import type { MainOptions } from "../src/cli.js";
import { sous } from "./sous.js";
import { callProblem, words } from "./helpers/calls.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "SOUS_RUN_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];

const PERSON: NodeJS.ProcessEnv = {};
const MESSAGE = "Use the v2 API.";
const NAME = "sub: impl";

const WORKFLOWS = {
  slow: "export const meta = { name: 'slow', description: 'slow', place: 'none' }\nreturn await agent('Slow part.', { label: 'impl', model: 'claude/haiku' })",
  quick: "export const meta = { name: 'quick', description: 'quick', place: 'none' }\nreturn await agent('Quick part.', { label: 'impl', model: 'claude/haiku' })",
  twins: "export const meta = { name: 'twins', description: 'twins', place: 'none' }\nreturn await parallel([() => workflow('slow', {}, { label: 'sub' }), () => workflow('quick', {}, { label: 'sub' })])",
};

/** The slow step runs one tool call and stays in it until the test writes the gate file "go". The quick one ends at once. */
const RULES = [
  { match: "Slow part", tool: "echo working", hold: "go", answer: "Done." },
  { match: "Quick part", answer: "Done." },
];

interface LogLine {
  sessionId?: string;
  prompt?: string;
  steer?: { id: string | null; text: string };
}

interface StepReply {
  step?: string;
  scope?: string;
  status?: string;
  prompt?: string;
  call?: number;
  calls?: number;
  activity?: Array<{ kind: string; text: string }>;
}

/** The fakes' log and rules, in a folder of their own. */
function fakePlace() {
  const dir = mkdtempSync(join(tmpdir(), "sous-tell-shared-"));
  process.env.FAKE_LOG = join(dir, "fake.log");
  process.env.FAKE_RULES = join(dir, "rules.json");
  writeFileSync(process.env.FAKE_RULES, JSON.stringify(RULES));
  const log = process.env.FAKE_LOG;
  return {
    gate: (name: string) => writeFileSync(join(dir, name), ""),
    lines: (): LogLine[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine) : []),
  };
}

/** The JSON sous printed. */
function json(printed: { code: number; out: string }): Record<string, any> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  return parsed as Record<string, any>;
}

/** Poll a read until it holds, or 20 seconds pass. */
async function until(ready: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await ready()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** What a `sous step` call prints, run as the reply gives it. */
async function stepByCall(paths: HomePaths, call: string): Promise<StepReply> {
  assert.equal(callProblem(call), undefined, callProblem(call));
  const printed = await sous(paths, words(call).slice(1), { env: PERSON });
  assert.equal(printed.code, 0, `${call} runs as it is:\n${printed.out}`);
  return json(printed) as StepReply;
}

/** What `sous step --call n --json` shows, or undefined while it shows nothing. */
async function callOf(paths: HomePaths, runId: string, call: number): Promise<StepReply | undefined> {
  const printed = await sous(paths, ["step", runId, NAME, "--call", String(call), "--json"], { env: PERSON });
  return printed.code === 0 ? (JSON.parse(printed.out) as StepReply) : undefined;
}

describe("piece 12 re-check: two nested runs that share a name", () => {
  it("sous step --call reaches each, and a tell reaches the one that runs", async () => {
    const place = fakePlace();
    const { paths, projectDir } = testHome(WORKFLOWS, { claudePath: join(FAKES, "claude"), codexPath: join(FAKES, "codex") });
    const run = await sous(paths, ["run", "twins", "--json", "--project", projectDir], { env: PERSON });
    assert.equal(run.code, 0, run.out);
    const runId = json(run).runId as string;
    try {
      // Both calls show under the one name: the quick one done, the slow one in its tool call.
      let shown: StepReply[] = [];
      await until(async () => {
        // One sous call at a time: each prints to the output the test reads.
        const first = await callOf(paths, runId, 1);
        const second = await callOf(paths, runId, 2);
        shown = [first, second].filter((view): view is StepReply => view !== undefined);
        const quick = shown.find((view) => view.prompt?.includes("Quick part"));
        const slow = shown.find((view) => view.prompt?.includes("Slow part"));
        return quick?.status === "done" && slow?.status === "running" && (slow.activity ?? []).some((line) => line.kind === "tool");
      }, "sous step --call 1 and 2 to show the quick call done and the slow one in its tool call");
      assert.deepEqual(
        shown.map((view) => [view.step, view.call, view.calls]),
        [
          [NAME, 1, 2],
          [NAME, 2, 2],
        ],
      );
      assert.notEqual(shown[0]!.scope, shown[1]!.scope, "the two calls ran in two nested runs");
      const slow = shown.find((view) => view.prompt?.includes("Slow part"))!;

      const options = { env: PERSON, tellWaitMs: 300 } as MainOptions & { tellWaitMs: number };
      const printed = await sous(paths, ["tell", runId, "--step", NAME, MESSAGE, "--json"], options);
      assert.equal(printed.code, 0, printed.out);
      const reply = json(printed);
      assert.deepEqual(
        reply.calls.map((told: { step: string; call: number }) => [told.step, told.call]),
        [[NAME, slow.call]],
        "the tell went to the running call only, named as sous step --call counts it",
      );

      // Every sous step call the reply gives, in its next and its notes.
      const calls: string[] = [
        ...reply.next.map((next: { call: string }) => next.call).filter((call: string) => call.startsWith("sous step ")),
        ...reply.notes.flatMap((note: string) => [...note.matchAll(/sous step \S+ (?:'[^']*'|\S+)(?: --call \d+)?/g)].map((found) => `${found[0]} --json`)),
      ];
      assert.ok(calls.length >= 1, `the reply gives a sous step call: ${printed.out}`);
      for (const call of calls) {
        const view = await stepByCall(paths, call);
        assert.equal(view.scope, slow.scope, `${call} shows the running call: ${JSON.stringify(view)}`);
        assert.match(view.prompt ?? "", /Slow part/, `${call} shows the running call's prompt`);
      }

      // Only the slow call's session got the message.
      const session = place.lines().find((line) => line.prompt?.includes("Slow part") && !line.steer)?.sessionId;
      assert.ok(session, "the fakes logged the slow call's prompt");
      place.gate("go");
      await until(async () => (await stepByCall(paths, calls[0]!)).activity?.some((line) => line.kind === "tell" && line.text.includes(MESSAGE)) ?? false, "the slow call to show the tell");
      const steered = place.lines().filter((line) => line.steer?.text === MESSAGE);
      assert.ok(steered.length > 0 && steered.every((line) => line.sessionId === session), `only the slow session got the message: ${JSON.stringify(steered)}`);
    } finally {
      place.gate("go");
      await until(() => loadRecord(paths, runId)?.pid === undefined, "the worker to end").catch(async () => {
        await sous(paths, ["stop", runId, "--json"], { env: PERSON });
      });
    }
  });
});

// Piece 12 review, tell to a step of a nested run. The run has a top-level step impl and a nested
// run "sub" with a step impl of its own, both on the Claude fake and held in a tool call. A tell
// to "sub: impl", the name sous log gives the nested step, reaches only that call. Every
// `sous step` call in the reply runs as it is and shows the call told, not the top-level impl.

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
const NESTED = "sub: impl";

const WORKFLOWS = {
  child: "export const meta = { name: 'child', description: 'child', place: 'none' }\nreturn await agent('Build the part.', { label: 'impl', model: 'claude/haiku' })",
  nest: "export const meta = { name: 'nest', description: 'nest', place: 'none' }\nreturn await parallel([() => agent('Build the top.', { label: 'impl', model: 'claude/haiku' }), () => workflow('child', {}, { label: 'sub' })])",
};

/** Each agent step runs one tool call and stays in it until the test writes the gate file "go". */
const HELD = [{ match: "Build", tool: "echo working", hold: "go", answer: "Done." }];

interface LogLine {
  program: string;
  sessionId?: string;
  prompt?: string;
  steer?: { id: string | null; text: string };
  state?: string;
}

interface StepReply {
  step?: string;
  scope?: string;
  status?: string;
  prompt?: string;
  activity?: Array<{ kind: string; text: string }>;
}

/** The fakes' log and rules, in a folder of their own. */
function fakePlace() {
  const dir = mkdtempSync(join(tmpdir(), "sous-tell-nested-"));
  process.env.FAKE_LOG = join(dir, "fake.log");
  process.env.FAKE_RULES = join(dir, "rules.json");
  writeFileSync(process.env.FAKE_RULES, JSON.stringify(HELD));
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

/** What `sous step --json` shows of a step, or undefined while it shows nothing. */
async function stepOf(paths: HomePaths, runId: string, step: string): Promise<StepReply | undefined> {
  const printed = await sous(paths, ["step", runId, step, "--json"], { env: PERSON });
  return printed.code === 0 ? (JSON.parse(printed.out) as StepReply) : undefined;
}

/** The step runs and is inside its tool call. */
async function inTool(paths: HomePaths, runId: string, step: string): Promise<void> {
  await until(async () => {
    const shown = await stepOf(paths, runId, step);
    return shown?.status === "running" && (shown.activity ?? []).some((line) => line.kind === "tool");
  }, `${step} to run its tool call`);
}

describe("piece 12 review: tell to a step of a nested run", () => {
  it("reaches only the nested call, and each sous step call in the reply shows that call", async () => {
    const place = fakePlace();
    const { paths, projectDir } = testHome(WORKFLOWS, { claudePath: join(FAKES, "claude"), codexPath: join(FAKES, "codex") });
    const run = await sous(paths, ["run", "nest", "--json", "--project", projectDir], { env: PERSON });
    assert.equal(run.code, 0, run.out);
    const runId = json(run).runId as string;
    try {
      await inTool(paths, runId, "impl");
      await inTool(paths, runId, NESTED);
      const nested = await stepOf(paths, runId, NESTED);
      assert.notEqual(nested?.scope, runId, "sous step takes the nested step's name in the log");
      assert.match(nested?.prompt ?? "", /Build the part/);

      const options = { env: PERSON, tellWaitMs: 300 } as MainOptions & { tellWaitMs: number };
      const printed = await sous(paths, ["tell", runId, "--step", NESTED, MESSAGE, "--json"], options);
      assert.equal(printed.code, 0, printed.out);
      const reply = json(printed);
      assert.deepEqual(
        reply.calls.map((told: { step: string; call: number }) => [told.step, told.call]),
        [[NESTED, 1]],
        "the reply names the call by its name in the log and its number as sous step --call counts it",
      );

      // Every sous step call the reply gives, in its next and its notes.
      const calls: string[] = [
        ...reply.next.map((next: { call: string }) => next.call).filter((call: string) => call.startsWith("sous step ")),
        ...reply.notes.flatMap((note: string) => [...note.matchAll(/sous step \S+ (?:'[^']*'|\S+)(?: --call \d+)?/g)].map((found) => `${found[0]} --json`)),
      ];
      assert.ok(calls.length >= 1, `the reply gives a sous step call: ${printed.out}`);
      for (const call of calls) {
        const shown = await stepByCall(paths, call);
        assert.equal(shown.scope, nested?.scope, `${call} shows the nested call: ${JSON.stringify(shown)}`);
        assert.match(shown.prompt ?? "", /Build the part/, `${call} shows the nested call's prompt`);
      }

      // Only the nested call's session got the message.
      const session = place.lines().find((line) => line.prompt?.includes("Build the part") && !line.steer)?.sessionId;
      assert.ok(session, "the fakes logged the nested call's prompt");
      place.gate("go");
      await until(async () => (await stepByCall(paths, calls[0]!)).activity?.some((line) => line.kind === "tell" && line.text.includes(MESSAGE)) ?? false, "the nested step to show the tell");
      const steered = place.lines().filter((line) => line.steer?.text === MESSAGE);
      assert.ok(steered.length > 0 && steered.every((line) => line.sessionId === session), `only the nested session got the message: ${JSON.stringify(steered)}`);
      const top = await stepOf(paths, runId, "impl");
      assert.deepEqual((top?.activity ?? []).filter((line) => line.kind === "tell"), [], "the top-level impl shows no tell");
    } finally {
      place.gate("go");
      await until(() => loadRecord(paths, runId)?.pid === undefined, "the worker to end").catch(async () => {
        await sous(paths, ["stop", runId, "--json"], { env: PERSON });
      });
    }
  });
});

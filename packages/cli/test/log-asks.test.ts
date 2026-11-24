import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runQuestions } from "@sous/engine";
import { inProcess, testHome, type InnerRunner } from "@sous/engine/testing";
import { sous, waitFor } from "./sous.js";

// A question waits for its answer while the run's worker lives. sous log --json shows it as an
// asks event, then the answer as an answered event of the same call.

delete process.env.SOUS_RUN_ID;
delete process.env.CLAUDECODE;

const ASKING = `export const meta = { name: 'asking', description: 'an agent step that may ask', place: 'none' }
return await agent('Pick a color for the logo', { label: 'picker', ask: true })`;
const ASKS = `export const meta = { name: 'asks', description: 'ask a person to pick a color', place: 'none' }
const color = await ask('Which color?', { choices: ['red', 'blue'] })
return { color }`;

interface LogEvent { seq: number; kind: string; call?: number; prompt?: string; step?: string; scope?: string }

async function events(paths: Parameters<typeof sous>[0], runId: string): Promise<LogEvent[]> {
  const printed = await sous(paths, ["log", runId, "--json"]);
  assert.equal(printed.code, 0, printed.out);
  return (JSON.parse(printed.out) as { events: LogEvent[] }).events;
}

/** Start the workflow, wait for its question, and hand it to `check`. Whatever `check` does, the
 *  question gets an answer and the run ends, so a failed check does not leave the run waiting. */
async function asked(workflow: string, answers: string[], check: (seen: { paths: Parameters<typeof sous>[0]; runId: string; question: ReturnType<typeof runQuestions>[number] }) => Promise<void>) {
  const { paths, projectDir } = testHome({ asking: ASKING, asks: ASKS });
  let turn = 0;
  const workers = inProcess({ inner: { run: async () => answers[turn++] ?? "done" } as unknown as InnerRunner });
  const run = await sous(paths, ["run", workflow, "--json", "--project", projectDir], { launch: workers.launch });
  assert.equal(run.code, 0, run.out);
  const runId = (JSON.parse(run.out) as { runId: string }).runId;
  await waitFor(() => runQuestions(paths, runId).length > 0, "the run's question");
  const [question] = runQuestions(paths, runId);
  try {
    await check({ paths, runId, question: question! });
  } finally {
    for (const open of runQuestions(paths, runId)) await sous(paths, ["answer", open.id, "blue"]);
    await workers.ended(runId);
  }
  const all = await events(paths, runId);
  const at = (kind: string) => all.findIndex((event) => event.kind === kind && event.call === question!.callIndex);
  assert.ok(at("asks") >= 0 && at("answered") > at("asks"), `the asks event comes before the answered one: ${JSON.stringify(all)}`);
}

describe("a live question in sous log --json", () => {
  it("an agent step's question gives an asks event with its call, step and question while it waits, before its answered event", async () => {
    await asked("asking", ["QUESTION: red or blue?", "Blue it is."], async ({ paths, runId, question }) => {
      const waiting = await events(paths, runId);
      const asks = waiting.filter((event) => event.kind === "asks");
      assert.equal(asks.length, 1, JSON.stringify(waiting));
      assert.equal(asks[0]!.call, question.callIndex);
      assert.equal(asks[0]!.step, "picker");
      assert.match(asks[0]!.prompt ?? "", /red or blue\?/);
      assert.equal(asks[0]!.scope, undefined, "the root run's question has no scope");
    });
  });

  it("an ask() question gives an asks event too", async () => {
    await asked("asks", [], async ({ paths, runId, question }) => {
      const asks = (await events(paths, runId)).filter((event) => event.kind === "asks");
      assert.deepEqual(asks.map((event) => [event.call, event.prompt, event.step]), [[question.callIndex, "Which color?", undefined]]);
    });
  });
});

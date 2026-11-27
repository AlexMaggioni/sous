// Scenario 12, the agent needs you, and you step in. Two branches run at once. The implementer's
// first turn answers with the status "question", so the step waits for the person, and the run
// asks. The docs branch holds its turn open meanwhile. The person runs `sous join <run> impl` in
// a terminal of their own, and the fake program types the person's line into the session. The
// docs branch's turn ends while the person is in. Once the person leaves, the implementer goes on
// in the same session with "Continue the task.", and the recall rule shows that the session kept
// the person's line. The journal has one join row, and no call ran twice.

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readRun } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, type FakeLine, type FakeRule, type FakeWorld } from "../helpers/fake-world.js";

const CANARY = "PELICAN-4417";
const PERSON = "Use the v2 API. Keep this word in mind: KESTREL-5150.";
const PROMPT = `Build it. Keep this word in mind: ${CANARY}.`;
const DOCS = "Write the docs.";
const CONTINUE = "Continue the task.";
const QUESTION = "Which API should I call?";

/** The implementer asks on its first turn. The docs turn runs a tool call, then holds until the
 *  file "release" exists. The continuation recalls the words the session heard. */
const RULES: FakeRule[] = [
  { match: "^Build it", status: [{ status: "question", message: QUESTION }] },
  { match: "^Write the docs", tool: "echo working", hold: "release", answer: "Docs done." },
  { match: CONTINUE, recall: true },
];

const script = (model: string) => `export const meta = { name: 'asks', description: 'An implementer that asks, beside a docs writer' }
const [impl, docs] = await parallel([
  () => agent(${JSON.stringify(PROMPT)}, { label: 'impl', model: '${model}' }),
  () => agent(${JSON.stringify(DOCS)}, { label: 'docs', model: '${model}' }),
])
return { impl, docs }`;

/** The fakes' turns: the log lines that carry a prompt. */
const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

/** The journal rows of the run's steps with this label. */
const rows = (world: FakeWorld, runId: string, label: string) => (readState(world.paths, runId)?.journal ?? []).filter((entry) => entry.call?.kind === "agent" && entry.call.label === label);

async function until(what: string, ok: () => boolean, world: FakeWorld, runId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`${what} never happened:\n${JSON.stringify(readState(world.paths, runId), null, 2)}\n${JSON.stringify(world.log(), null, 2)}`);
}

for (const [program, model, name] of [
  ["claude", "claude/haiku", "Claude Code"],
  ["codex", "codex/gpt-fake", "Codex"],
] as const) {
  describe(`an agent that needs the person on the fake ${program}`, () => {
    it("waits for the person, who steps into its session with sous join while the other branch runs on", async (t) => {
      const world = fakeWorld(t, { rules: RULES, person: PERSON });
      world.workflow("asks", script(model));
      const started = await world.sous("run", "asks", "--json");
      assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
      const runId = (JSON.parse(started.stdout) as { runId: string }).runId;

      await until("the question and the held docs turn", () => readRun(world.paths, runId).status === "asks" && turns(world.log()).some((line) => line.prompt === DOCS), world, runId);
      const asked = turns(world.log()).find((line) => line.prompt === PROMPT)!;

      const status = await world.sous("status", runId);
      assert.ok(status.stdout.includes(`"impl" needs you in its session.`), status.stdout);
      assert.ok(status.stdout.includes(`sous join ${runId} impl`), status.stdout);
      assert.ok(!status.stdout.includes(QUESTION), "the agent's message stays in its session");

      // The person steps in from a terminal of their own, and stays until the test lets them go.
      const joining = world.sousWith({ terminal: true, env: { FAKE_PERSON_WAIT: "leave" } }, "join", runId, "impl");
      await until("the person in the session", () => existsSync(join(world.dir, "leave.in")), world, runId);
      assert.deepEqual(rows(world, runId, "docs"), [], "the docs turn still runs");

      // The docs branch's turn ends while the person is in.
      writeFileSync(join(world.dir, "release"), "");
      await until("the docs turn's end", () => rows(world, runId, "docs").length === 1, world, runId);
      assert.equal(existsSync(join(world.dir, "leave")), false, "the person is still in");

      writeFileSync(join(world.dir, "leave"), "");
      const joined = await joining;
      assert.equal(joined.code, 0, joined.stdout);
      assert.ok(joined.stdout.includes(`"impl" asked you a question in its session.`), joined.stdout);
      assert.ok(joined.stdout.includes(`${name} shows it as declined or interrupted, because sous ended the turn there. Answer it in your own words.`), joined.stdout);
      assert.ok(joined.stdout.includes(`opening ${name} in ${asked.cwd}, in the session of "impl".`), joined.stdout);
      assert.ok(joined.stdout.includes(`left the session of "impl" in ${runId}.`), joined.stdout);
      assert.ok(joined.stdout.includes(`"impl" has its answer and goes on in its session.`), joined.stdout);

      const end = await world.sous("wait", runId, "--timeout", "30", "--json");
      assert.equal(end.code, 0, `${end.stdout}\n${end.stderr}`);
      const result = (JSON.parse(end.stdout) as { result: { impl: unknown; docs: unknown } }).result;
      assert.deepEqual(result, { impl: `${CANARY} KESTREL-5150`, docs: "Docs done." }, "the session kept the prompt and the person's line");

      // The person's program opened the implementer's session in its folder.
      assert.deepEqual(
        world.log().filter((line) => line.byHand).map((line) => [line.program, line.sessionId, line.cwd, line.person]),
        [[program, asked.sessionId, asked.cwd, PERSON]],
      );
      // The step went on once, in its session, and no call ran twice.
      const lines = turns(world.log());
      assert.deepEqual(lines.map((line) => line.prompt).sort(), [CONTINUE, DOCS, PROMPT].sort());
      const next = lines.find((line) => line.prompt === CONTINUE)!;
      assert.deepEqual([next.sessionId, next.resume, next.cwd], [asked.sessionId, true, asked.cwd], "a new program resumed the session in its folder");

      const journal = readState(world.paths, runId)?.journal ?? [];
      assert.equal(journal.filter((entry) => entry.kind === "checkpoint").length, 1, "one join row");
      assert.deepEqual(
        rows(world, runId, "impl").map((row) => (row.result as { status?: unknown }).status),
        ["question", "done"],
      );
    });
  });
}

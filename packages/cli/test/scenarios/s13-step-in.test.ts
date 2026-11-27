// Scenario 13, step into a running session. Two branches hold their turns open. The person runs
// `sous join <run> impl` in a terminal of their own. That stops only the implementer's turn,
// which settles as "working", and the fake program types the person's line into the session.
// The docs branch's turn runs on throughout, in the same program, and ends once the test lets it.
// Once the person leaves, the implementer goes on in the same session with "Continue the task.",
// and the recall rule shows that the session kept the person's line.

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, type FakeLine, type FakeRule, type FakeWorld } from "../helpers/fake-world.js";

const CANARY = "PELICAN-4417";
const PERSON = "Use the v2 API. Keep this word in mind: KESTREL-5150.";
const PROMPT = `Build it. Keep this word in mind: ${CANARY}.`;
const DOCS = "Write the docs.";
const CONTINUE = "Continue the task.";

/** Each turn runs a tool call, then holds: the implementer's until the person stops it, the docs
 *  writer's until the file "release" exists. The tool call's message tells the engine the program
 *  has the prompt. The continuation recalls the words the session heard. */
const RULES: FakeRule[] = [
  { match: "^Build it", tool: "echo working", hold: "never", answer: "Built." },
  { match: "^Write the docs", tool: "echo working", hold: "release", answer: "Docs done." },
  { match: CONTINUE, recall: true },
];

const script = (model: string) => `export const meta = { name: 'busy', description: 'An implementer and a docs writer at work' }
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

/** Both turns run, and each program has its prompt. */
function bothHeld(world: FakeWorld, runId: string): boolean {
  const held = (readState(world.paths, runId)?.agents ?? []).filter((row) => row.status === "running" && row.session !== undefined && row.session.delivered !== false);
  const asked = turns(world.log()).map((line) => line.prompt);
  return held.length === 2 && asked.includes(PROMPT) && asked.includes(DOCS);
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const [program, model, name] of [
  ["claude", "claude/haiku", "Claude Code"],
  ["codex", "codex/gpt-fake", "Codex"],
] as const) {
  describe(`a person who steps into a running turn on the fake ${program}`, () => {
    it("stops only that turn, and the other branch's turn runs on throughout", async (t) => {
      const world = fakeWorld(t, { rules: RULES, person: PERSON });
      world.workflow("busy", script(model));
      const started = await world.sous("run", "busy", "--json");
      assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
      const runId = (JSON.parse(started.stdout) as { runId: string }).runId;

      await until("both turns held", () => bothHeld(world, runId), world, runId);
      const impl = turns(world.log()).find((line) => line.prompt === PROMPT)!;
      const docs = turns(world.log()).find((line) => line.prompt === DOCS)!;

      // The person steps in from a terminal of their own, and stays until the test lets them go.
      const joining = world.sousWith({ terminal: true, env: { FAKE_PERSON_WAIT: "leave" } }, "join", runId, "impl");
      await until("the person in the session", () => existsSync(join(world.dir, "leave.in")), world, runId);

      // The implementer's turn stopped and settled as working. The docs turn still runs.
      assert.deepEqual(rows(world, runId, "impl").map((row) => (row.result as { status?: unknown }).status), ["working"]);
      assert.deepEqual(rows(world, runId, "docs"), [], "the docs turn still runs");
      assert.ok(alive(docs.pid), "the docs turn's program still runs");

      writeFileSync(join(world.dir, "leave"), "");
      const joined = await joining;
      assert.equal(joined.code, 0, joined.stdout);
      assert.ok(joined.stdout.includes(`opening ${name} in ${impl.cwd}, in the session of "impl".`), joined.stdout);
      assert.ok(joined.stdout.includes(`left the session of "impl" in ${runId}.`), joined.stdout);
      assert.ok(joined.stdout.includes(`"impl" goes on in its session.`), joined.stdout);

      // The implementer goes on, and the docs turn ends once the test lets it.
      await until("the implementer's next turn", () => turns(world.log()).some((line) => line.prompt === CONTINUE), world, runId);
      assert.deepEqual(rows(world, runId, "docs"), [], "the docs turn ran on while the person was in and after");
      writeFileSync(join(world.dir, "release"), "");

      const end = await world.sous("wait", runId, "--timeout", "30", "--json");
      assert.equal(end.code, 0, `${end.stdout}\n${end.stderr}`);
      const result = (JSON.parse(end.stdout) as { result: { impl: unknown; docs: unknown } }).result;
      assert.deepEqual(result, { impl: `${CANARY} KESTREL-5150`, docs: "Docs done." }, "the session kept the prompt and the person's line");

      assert.deepEqual(
        world.log().filter((line) => line.byHand).map((line) => [line.program, line.sessionId, line.cwd, line.person]),
        [[program, impl.sessionId, impl.cwd, PERSON]],
      );
      // Each prompt went out once. The docs turn ran in one program from start to end.
      const lines = turns(world.log());
      assert.deepEqual(lines.map((line) => line.prompt).sort(), [CONTINUE, DOCS, PROMPT].sort());
      const next = lines.find((line) => line.prompt === CONTINUE)!;
      assert.deepEqual([next.sessionId, next.resume, next.cwd], [impl.sessionId, true, impl.cwd], "a new program resumed the session in its folder");
      assert.deepEqual(
        rows(world, runId, "impl").map((row) => (row.result as { status?: unknown }).status),
        ["working", "done"],
      );
      assert.equal(rows(world, runId, "docs").length, 1);
    });
  });
}

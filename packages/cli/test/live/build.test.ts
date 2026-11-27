// Live test of scenario 15: the build workflow of examples/build runs a small stage end to end.
// The stage adds slugify and countWords to a new textkit project, with two gates. Stand-in agents
// with the owner's agent names plan it, build each ticket in its own worktree, review it, and
// prove the gates. The test then checks out the run's branch and reruns the stage's tests and each
// gate's proof with no agent.
//
// It is off by default. It needs Claude Code and your own login, so run it from packages/cli
// without test/with-temp-home.mjs, after pnpm build:
//
//   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID SOUS_LIVE_BUILD=1 ../../node_modules/.bin/tsx --test test/live/build.test.ts
//
// Every agent runs on haiku at low effort. Two runs each took 7 agent steps, 160 to 200 seconds,
// and $0.03 to $0.05.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { listRecords } from "@sous-run/engine";
import { liveWorld } from "../helpers/live-run.js";

const ON = process.env.SOUS_LIVE_BUILD === "1";
const BUILD = readFileSync(fileURLToPath(new URL("../../../../examples/build/.sous/workflows/build.js", import.meta.url)), "utf8");

const DESIGN = `# Stage 1: two text helpers

textkit is a small ES module library with no dependencies. This stage adds two functions to
\`src/index.js\`. Tests live in \`test/\` and run with \`node --test\`.

## slugify(text)

Returns \`text\` in lower case, with each run of characters that are not a letter or a digit
replaced by one hyphen, and no hyphen at the start or the end. \`slugify("Hello, World!")\` is
\`"hello-world"\`. \`slugify("")\` is \`""\`.

## countWords(text)

Returns the number of words in \`text\`, where a word is a run of characters that are not white
space. \`countWords("  one two  three ")\` is \`3\`. \`countWords("")\` is \`0\`.

## Gates

- G1: \`slugify("Hello, World!")\` returns \`"hello-world"\`, and \`slugify("  --A  b--  ")\` returns \`"a-b"\`.
- G2: \`countWords("  one two  three ")\` returns \`3\`, and \`countWords("")\` returns \`0\`.
`;

/** The stand-ins for the owner's agents, on haiku at low effort. */
const AGENTS: Record<string, [string, string]> = {
  "build-planner": [
    "Cuts a stage's design into tickets",
    "You plan the build of one stage from its design. Read the design and the code it names. Cut the stage into the fewest tickets that each build one thing with its own tests. Change no file.",
  ],
  implementer: [
    "Builds one ticket, tests first",
    "You build one ticket. Write its tests first and run them to see them fail. Then write the code until they pass. Never weaken a test.",
  ],
  reviewer: [
    "Reviews one ticket's change",
    "You review one ticket's change. Read the diff and run the tests. A blocker is a real bug or a missing test the ticket asks for. Change no file.",
  ],
  verifier: [
    "Proves one gate with a script",
    "You prove one gate. Write a small script that checks the gate on the code and exits 0 only when it holds. Run it, and report its output as the evidence. Change no code outside the proofs folder.",
  ],
};

interface Result {
  tickets: Array<{ id: string; title: string; status: string; why?: string; commit?: string; reviews?: number }>;
  gates: Array<{ id: string; verdict: string; evidence: string; rerun: string }>;
  gaps: string[];
}

/** Runs a command in a folder, outside this test's own node --test, and gives its exit code and output. */
function run(cwd: string, command: string): { code: number; output: string } {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const ran = spawnSync("sh", ["-c", command], { cwd, env, encoding: "utf8" });
  return { code: ran.status ?? 1, output: `${ran.stdout}${ran.stderr}` };
}

describe("the build workflow, live on a small stage", { skip: ON ? false : "set SOUS_LIVE_BUILD=1 to run it, on your own login" }, () => {
  test("its tickets land on the run's branch, and the stage's tests and each gate's proof pass there", { timeout: 1_800_000 }, async (t) => {
    const world = liveWorld(t, "build");
    world.write("package.json", `${JSON.stringify({ name: "textkit", version: "0.0.0", type: "module", private: true, scripts: { test: "node --test" } }, null, 2)}\n`);
    world.write("src/index.js", "// textkit: small text helpers. The stage design in docs/stage-1.md lists what goes here.\nexport {}\n");
    world.write("docs/stage-1.md", DESIGN);
    world.git("add", "-A");
    world.git("commit", "-qm", "The textkit skeleton and the stage 1 design");
    world.write(".git/info/exclude", ".sous/\n.rulesync/\n");
    world.write(".sous/workflows/build.js", BUILD);
    for (const [name, [description, body]] of Object.entries(AGENTS)) {
      world.write(`.rulesync/subagents/${name}.md`, `---\nname: ${name}\ndescription: ${description}\ntargets: ["*"]\nclaudecode:\n  model: haiku\n  effort: low\n---\n${body}\n`);
    }
    const main = world.git("rev-parse", "main");
    t.diagnostic(`home ${world.home}, project ${world.project}`);
    const start = Date.now();

    const ran = await world.sous("run", "build", "--design", "docs/stage-1.md", "--test", "node --test", "--wait", "--json");

    const state = world.state();
    for (const agent of state.agents) t.diagnostic(`${agent.label}: ${agent.status}, ${agent.session?.model ?? "code"}, $${agent.usage?.cost ?? "-"}`);
    t.diagnostic(`run ${state.status}: ${Date.now() - start} ms`);
    assert.equal(ran.code, 0, `${ran.stdout}\n${ran.stderr}`);
    const out = JSON.parse(ran.stdout) as { status: string; branch: string; result?: Result; review?: { result: Result } };
    const result = out.review?.result ?? out.result!;
    t.diagnostic(JSON.stringify(result, null, 2));
    assert.equal(out.status, "completed");
    // Each ticket and gate runs as steps of the one build run, not as runs of their own.
    assert.equal(listRecords(world.paths).length, 1, "the build ran as one run");

    // Each agent step ran on haiku, as its stand-in asks.
    const agents = state.agents.filter((agent) => agent.session);
    assert.ok(agents.length >= 5, `${agents.length} agent steps`);
    for (const agent of agents) assert.equal(agent.session?.model, "claude/haiku", agent.label);

    assert.ok(result.tickets.length >= 1);
    for (const ticket of result.tickets) assert.equal(ticket.status, "landed", JSON.stringify(ticket));
    assert.deepEqual(result.gates.map((gate) => gate.id).sort(), ["G1", "G2"]);
    for (const gate of result.gates) assert.equal(gate.verdict, "passed", JSON.stringify(gate));

    // The run's branch holds each ticket's commit and the proofs, on top of main.
    const commits = world.git("log", "--format=%s", `main..${out.branch}`).split("\n");
    for (const ticket of result.tickets) assert.ok(commits.some((subject) => subject.startsWith(`${ticket.id} `)), `${ticket.id} in:\n${commits.join("\n")}`);
    assert.ok(commits.includes("The proofs of the stage's gates"), commits.join("\n"));

    // The stage's tests and each gate's proof pass on that branch, with no agent.
    const checkout = join(world.home, "..", "checkout");
    world.git("worktree", "add", "--detach", "-q", checkout, out.branch);
    const tests = run(checkout, "node --test");
    assert.equal(tests.code, 0, tests.output);
    for (const gate of result.gates) {
      const proof = run(checkout, gate.rerun);
      t.diagnostic(`${gate.id}: ${gate.rerun}\n${proof.output}`);
      assert.equal(proof.code, 0, `${gate.id}: ${proof.output}`);
    }

    // The person's checkout did not move.
    assert.equal(world.git("rev-parse", "main"), main);
    assert.equal(world.git("status", "--porcelain"), "");
  });
});

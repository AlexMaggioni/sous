// Scenario 15, the capstone, in a dry run. examples/build holds the owner's build process as one
// workflow: a planner cuts a stage into tickets, each ticket gets an implementer in a worktree of
// its own and a reviewer, and verifiers prove the stage's gates. The stand-in agents follow a
// script, and the stage's tests are a real command that runs in each ticket's worktree. It counts
// its runs and writes a file per ticket, so each ticket has a commit to land on the run's branch.
// The real stage this workflow should run hands-off waits on the owner's pick.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { fakeWorld, type FakeWorld } from "../helpers/fake-world.js";

const BUILD = readFileSync(fileURLToPath(new URL("../../../../examples/build/.sous/workflows/build.js", import.meta.url)), "utf8");

// The stage's tests. A ticket's worktree is named <run>-<label>-<suffix>, so the folder names the
// ticket. With "shared", every ticket also writes shared.txt, so two tickets conflict.
const TESTS = `marks="$1"
ticket=$(basename "$PWD" | sed -E 's/^.*-(t[0-9]+|g[0-9]+-fix)-implementer-.*$/\\1/')
n=$(( $(cat "$marks/$ticket" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$marks/$ticket"
echo "$ticket" > "built-$ticket.txt"
[ "$2" = shared ] && echo "$ticket" > shared.txt
if [ "$ticket" = t1 ] && [ "$n" -eq 1 ]; then echo "t1 fails its first run"; exit 1; fi
exit 0
`;

// G1's proof script. It runs in the run's folder after the fix lands, keeps the run's history, and fails.
const RERUN = `git log --format=%s > "$1/history"
echo "G1 still fails"
exit 1
`;

interface Ticket {
  id: string;
  title: string;
  status: string;
  why?: string;
  branch?: string;
  commit?: string;
  reviews?: number;
}

interface Gate {
  id: string;
  verdict: string;
  evidence: string;
  steps: string[];
  fix?: Ticket;
}

interface Dry {
  status: string;
  result: { tickets: Ticket[]; gates: Gate[]; gaps: string[] };
  agents: string[];
}

/** A project with the build workflow, the stage's test script and its marks folder. */
function buildWorld(t: Parameters<typeof fakeWorld>[0]): FakeWorld & { marks: string; tests: string; rerun: string } {
  const world = fakeWorld(t);
  world.workflow("build", BUILD);
  // The owner's agents live in their own home. Stand-ins with the same names fill their place.
  for (const name of ["build-planner", "implementer", "reviewer", "verifier"]) {
    world.agent(name, `---\nname: ${name}\ndescription: The stage's ${name}.\n---\n\nDo your part of the build.\n`);
  }
  const tests = join(world.dir, "tests.sh");
  const rerun = join(world.dir, "rerun.sh");
  writeFileSync(tests, TESTS);
  writeFileSync(rerun, RERUN);
  const marks = join(world.dir, "marks");
  mkdirSync(marks);
  return Object.assign(world, { marks, tests, rerun });
}

async function dryBuild(world: FakeWorld, answers: unknown, ...flags: string[]): Promise<Dry> {
  world.write("answers.json", JSON.stringify(answers));
  const run = await world.sous("check", "build", "--design", "A stand-in stage.", ...flags, "--dry-run", "--json", "--answers", join(world.projectDir, "answers.json"));
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const out = JSON.parse(run.stdout) as { problems: string[]; notes: string[]; dryRun: Dry };
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.notes, []);
  return out.dryRun;
}

const ticket = (id: string, title: string, needs: string[], gates: string[]) => ({ id, title, body: `Build ${title.toLowerCase()}.`, needs, gates, tested: true });
const built = (red: string) => ({ outcome: "built", reply: "It is built.", red, byDesign: false });
const stuck = (reply: string, byDesign: boolean) => ({ outcome: "stuck", reply, red: "", byDesign });
const blocker = { what: "No test for empty input.", where: "one.js", evidence: "one.test.js" };
const marked = (world: { marks: string }, name: string) => readFileSync(join(world.marks, name), "utf8").trim();
const turnsOf = (agents: string[], id: string) => agents.filter((label) => label.startsWith(`${id} `));

describe("the build workflow on a stand-in stage, in a dry run", () => {
  it("builds each ticket after those it needs, sends failures back, takes a fresh implementer, parks and skips, and proves the gates", async (t) => {
    const world = buildWorld(t);
    const dry = await dryBuild(world, {
      planner: {
        tickets: [
          ticket("T1", "One", [], ["G1"]),
          ticket("T2", "Two", ["T1"], ["G1"]),
          ticket("T3", "Three", [], ["G2"]),
          ticket("T4", "Four", [], ["G3"]),
          ticket("T5", "Five", ["T4"], ["G3"]),
        ],
        gates: [
          { id: "G1", words: "One and two work." },
          { id: "G2", words: "Three shows on the page." },
          { id: "G3", words: "Four and five work." },
        ],
        test: `sh ${world.tests} ${world.marks}`,
        gaps: ["The design names no port."],
      },
      // T1's first test run fails, then its reviewer blocks once.
      "T1 review *": [{ blockers: [blocker], warnings: [] }, { blockers: [], warnings: [] }],
      // T2 first answers with no failing output, so it is asked for one.
      "T2 build": [built(""), built("1 failing: two is missing")],
      // T3's implementer is stuck, so a fresh one takes the ticket.
      "T3 build": stuck("The tests hang.", false),
      // T4 is stuck because of the design, so it parks with no fresh implementer.
      "T4 build*": stuck("The design gives four no database.", true),
      "prove G1": { verdict: "failed", evidence: "Two fails.", rerun: `sh ${world.rerun} ${world.marks}`, steps: [], byDesign: false },
      "prove G2": { verdict: "human", evidence: "A page.", rerun: "true", steps: ["Open the page. It shows three."], byDesign: false },
    });

    assert.equal(dry.status, "completed");
    const { agents } = dry;
    assert.equal(agents[0], "planner", "the planner runs first");
    assert.deepEqual(turnsOf(agents, "T1"), ["T1 build", "T1 build", "T1 review 1", "T1 build", "T1 review 2"], "failed tests, then a blocker, go back to the implementer in its session");
    assert.deepEqual(turnsOf(agents, "T2"), ["T2 build", "T2 build", "T2 review 1"], "no failing output goes back once");
    assert.deepEqual(turnsOf(agents, "T3"), ["T3 build", "T3 build 2", "T3 review 1"], "a stuck implementer gives way to a fresh one");
    assert.deepEqual(turnsOf(agents, "T4"), ["T4 build"], "stuck by design parks at once");
    assert.deepEqual(turnsOf(agents, "T5"), [], "a ticket that needs a parked one never starts");
    assert.ok(agents.indexOf("T2 build") > agents.lastIndexOf("T1 review 2"), "T2 starts after T1 landed");
    assert.ok(agents.indexOf("T3 build") < agents.indexOf("T2 build"), "T3 needs nothing, so it does not wait");
    const lastTicket = Math.max(...["T1", "T2", "T3", "T4"].map((id) => agents.lastIndexOf(turnsOf(agents, id).at(-1)!)));
    assert.ok(agents.indexOf("prove G1") > lastTicket && agents.indexOf("prove G2") > lastTicket, "the proofs start once the tickets are done");
    assert.ok(!agents.includes("prove G3"), "a gate whose tickets did not land gets no verifier");
    assert.deepEqual(agents.slice(-3), ["G1 fix build", "G1 fix review 1", "prove G1 2"], "a failed proof gets one fix ticket, then a verifier when its rerun still fails");

    const tickets = new Map(dry.result.tickets.map((t) => [t.id, t]));
    assert.deepEqual([...tickets.keys()], ["T1", "T2", "T3", "T4", "T5"]);
    assert.equal(tickets.get("T1")!.status, "landed");
    assert.equal(tickets.get("T1")!.reviews, 2);
    assert.equal(tickets.get("T2")!.status, "landed");
    assert.equal(tickets.get("T3")!.status, "landed");
    assert.deepEqual(tickets.get("T4"), { id: "T4", title: "Four", status: "parked", why: "The design gives four no database." }, "nothing committed, so no branch");
    assert.deepEqual(tickets.get("T5"), { id: "T5", title: "Five", status: "skipped", why: "it needs T4, which did not land" });

    const gates = new Map(dry.result.gates.map((g) => [g.id, g]));
    assert.equal(gates.get("G1")!.verdict, "passed");
    assert.equal(gates.get("G1")!.fix?.status, "landed");
    assert.equal(gates.get("G2")!.verdict, "human");
    assert.deepEqual(gates.get("G2")!.steps, ["Open the page. It shows three."]);
    assert.equal(gates.get("G3")!.verdict, "blocked");
    assert.equal(gates.get("G3")!.evidence, "T4, T5 did not land");
    assert.deepEqual(dry.result.gaps, ["The design names no port."]);

    // The tests ran for real in each worktree: T1's three times, the others once.
    assert.equal(marked(world, "t1"), "3");
    assert.equal(marked(world, "t2"), "1");
    assert.equal(marked(world, "t3"), "1");
    assert.equal(marked(world, "g1-fix"), "1");
    // Each ticket landed as one commit on the run's branch, one after another.
    const history = marked(world, "history").split("\n");
    assert.equal(history[0], "G1 fix Make the proof of G1 pass");
    assert.deepEqual(new Set(history.slice(1, 4)), new Set(["T1 One", "T2 Two", "T3 Three"]));
    assert.ok(history.indexOf("T2 Two") < history.indexOf("T1 One"), "T2 landed after T1");
    assert.equal(history.at(-1), "First commit");

    assert.deepEqual(world.log(), [], "no program started");
    assert.deepEqual(listRecords(world.paths), [], "no run is left");
  });

  it("parks a ticket whose blockers stay open past its rounds, and one whose rebase on a landed ticket never finishes", async (t) => {
    const world = buildWorld(t);
    const dry = await dryBuild(
      world,
      {
        planner: {
          tickets: [ticket("T6", "Six", [], []), ticket("T7", "Seven", [], []), ticket("T8", "Eight", [], [])],
          gates: [],
          test: `sh ${world.tests} ${world.marks} shared`,
          gaps: [],
        },
        "T6 review *": { blockers: [{ what: "It loses data.", where: "six.js", evidence: "six.test.js" }], warnings: ["Slow."] },
      },
      "--rounds",
      "1",
    );

    assert.equal(dry.status, "completed");
    const six = turnsOf(dry.agents, "T6");
    assert.deepEqual(six, ["T6 build", "T6 review 1", "T6 build", "T6 review 2", "T6 build 2", "T6 review 3", "T6 build 2", "T6 review 4"]);
    const tickets = new Map(dry.result.tickets.map((t) => [t.id, t]));
    assert.equal(tickets.get("T6")!.status, "parked");
    assert.equal(tickets.get("T6")!.why, "its reviewer left blockers open after 1 round: It loses data.");
    assert.match(tickets.get("T6")!.branch ?? "", /^sous\/.+-t6-implementer-/, "its work stays on its branch");

    // T7 and T8 both write shared.txt. The first to land wins, and the other is sent to rebase.
    const second = tickets.get("T7")!.status === "landed" ? "T8" : "T7";
    const first = second === "T7" ? "T8" : "T7";
    assert.equal(tickets.get(first)!.status, "landed");
    assert.equal(tickets.get(second)!.status, "parked");
    assert.equal(tickets.get(second)!.why, "its rebase did not finish");
    assert.ok(tickets.get(second)!.branch);
    assert.deepEqual(turnsOf(dry.agents, second), [`${second} build`, `${second} review 1`, `${second} rebase 1`], "the rebase goes to the implementer in its own session");
    assert.deepEqual(listRecords(world.paths), []);
  });
});

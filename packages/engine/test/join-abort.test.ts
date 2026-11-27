// `sous join` hands a session to the person (design, decision 9). The worker calls the steps
// module's join() with the session and the pid of the `sous join`. A turn that runs in the session
// stops once its program has the prompt, closes its program, and ends as a "working" row, while
// every other step goes on. The session's next turn waits until the person leaves. A join between
// two turns closes the program the step kept open. A turn the run stops lets go of its session at
// once, so a resume never waits on a program that is still closing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AgentSessionRef } from "../src/workflow-result.js";
import { createSteps, type InnerRunner } from "../src/steps/steps.js";
import { processAlive } from "../src/process-alive.js";
import { releaseHold, sessionHolds } from "../src/runs/session-hold.js";
import { holdFile } from "../src/runs/store.js";
import { testHome } from "../src/testing.js";
import { deferred, waitUntil } from "./helpers/async.js";
import { fakePlace, onFakes, routed, wentOn } from "./helpers/fake-steps.js";

const RUN = "run-join";
/** What a turn the person stepped into ends with: a working row, so the step goes on later. */
const JOINED = { status: "working", result: null, message: "The person stepped in." };
// The person's `sous join` stands in as this test's parent process, which lives through the test.
const PERSON = process.ppid;

/** The session refs each label's turns reported, in order. */
function opens() {
  const seen: Array<{ label: string; ref: AgentSessionRef }> = [];
  return {
    seen,
    as: (label: string) => (ref: AgentSessionRef) => seen.push({ label, ref }),
    delivered: (label: string) => seen.find((open) => open.label === label && open.ref.delivered !== false)?.ref,
  };
}

const holderOf = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { pid: number; by: string };

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`a join on the fake ${program}`, () => {
    it("stops only the joined turn once its program has the prompt, and its next turn waits until the person leaves", async () => {
      const { paths } = testHome();
      const place = fakePlace([
        { match: "^Work long", tool: "echo working", hold: "never", answer: "Never." },
        { match: "^Quick", hold: "quick-go", answer: "Quick done." },
        { match: "^Go on", answer: "Went on." },
      ]);
      const waits: string[] = [];
      const steps = createSteps(onFakes(place, { holds: sessionHolds(paths, { pollMs: 10 }), onWait: ({ label }) => waits.push(label ?? "") }));
      const open = opens();
      try {
        const joined = steps.run("Work long.", routed(steps, { label: "a", model }, { runId: RUN, callIndex: 0, hold: true, onSessionOpen: open.as("a") }));
        const sibling = steps.run("Quick.", routed(steps, { label: "b", model }, { runId: RUN, callIndex: 1, hold: true, onSessionOpen: open.as("b") }));
        let siblingDone = false;
        void sibling.then(() => (siblingDone = true), () => undefined);
        await waitUntil(() => open.delivered("a") !== undefined, "the long turn's program never had its prompt");
        const session = open.delivered("a")!.sessionId;
        const file = holdFile(paths, RUN, session);
        assert.deepEqual([holderOf(file).pid, holderOf(file).by], [process.pid, "step"], "the turn holds its session");

        await steps.join(RUN, session, PERSON);

        assert.deepEqual(await joined, JOINED, "the joined turn ends as a working row");
        const [held] = place.lines().filter((line) => line.prompt === "Work long.");
        await waitUntil(() => !processAlive(held!.pid), "the joined turn's program is still running");
        assert.deepEqual([holderOf(file).pid, holderOf(file).by], [PERSON, "join"], "the session is the person's");
        assert.equal(siblingDone, false, "the sibling still runs");

        // The session's next turn waits while the person holds it. The call hears it too, so a
        // room can go on without the member.
        let callWaits = 0;
        const next = steps.run("Go on.", routed(steps, { label: "a", model }, { runId: RUN, callIndex: 2, hold: true, continueFromSession: open.delivered("a")!, continueWithPrompt: true, onWait: () => callWaits++ }));
        await waitUntil(() => waits.length > 0, "the next turn did not wait for the person");
        assert.deepEqual(waits, ["a"]);
        assert.equal(callWaits, 1, "the call's own onWait ran once");
        assert.equal(place.lines().filter((line) => line.prompt === "Go on.").length, 0, "no program got the next turn while the person worked");

        place.gate("quick-go");
        assert.equal(await sibling, "Quick done.", "the sibling finished in its own session");

        releaseHold(file, PERSON);
        assert.equal(await next, "Went on.");
        const after = place.lines().find((line) => line.prompt === "Go on.");
        assert.equal(wentOn(held, after), "resumed", "the next turn resumed the session in a new program");
      } finally {
        place.gate("never");
        place.gate("quick-go");
        await steps.dispose();
      }
    });

    it("closes the program a step kept open between two turns, and hands the session over", async () => {
      const { paths } = testHome();
      const place = fakePlace([{ match: ".", answer: "Done." }]);
      const steps = createSteps(onFakes(place, { holds: sessionHolds(paths, { pollMs: 10 }) }));
      const open = opens();
      try {
        assert.equal(await steps.run("First.", routed(steps, { label: "a", model }, { runId: RUN, callIndex: 0, hold: true, onSessionOpen: open.as("a") })), "Done.");
        const [first] = place.lines();
        assert.ok(processAlive(first!.pid), "the step kept its program open");
        const session = open.delivered("a")!.sessionId;
        const file = holdFile(paths, RUN, session);

        await steps.join(RUN, session, PERSON);

        await waitUntil(() => !processAlive(first!.pid), "the kept program is still running");
        assert.deepEqual([holderOf(file).pid, holderOf(file).by], [PERSON, "join"]);
        const second = steps.run("Second.", routed(steps, { label: "a", model }, { runId: RUN, callIndex: 1, hold: true, continueFromSession: open.delivered("a")!, continueWithPrompt: true }));
        releaseHold(file, PERSON);
        assert.equal(await second, "Done.");
        assert.equal(wentOn(first, place.lines()[1]), "resumed");
      } finally {
        await steps.dispose();
      }
    });
  });
}

const REF: AgentSessionRef = { sessionId: "s-1", backendId: "claude", poolKey: "claude", cwd: "/", reopen: { load: true, resume: true, list: true, fork: true } };

describe("a join before the program has the prompt", () => {
  it("lets the turn run until the program has it, then stops it", async () => {
    const { paths } = testHome();
    const deliver = deferred();
    const stopped: string[] = [];
    const inner: InnerRunner = {
      async run(_prompt, request) {
        request.onSessionOpen?.({ ...REF, delivered: false });
        await deliver.promise;
        request.onSessionOpen?.(REF);
        // The stop may come within the report above.
        await new Promise((_, fail) => {
          const stop = () => (stopped.push("stopped"), fail(new Error("stopped")));
          if (request.signal!.aborted) stop();
          else request.signal!.addEventListener("abort", stop);
        });
      },
    };
    const steps = createSteps({ cwd: "/", inner, holds: sessionHolds(paths, { pollMs: 10 }) });
    const turn = steps.run("Work.", routed(steps, { label: "a", model: "claude/haiku" }, { runId: RUN, callIndex: 0 }));
    await waitUntil(() => sessionHolds(paths).held(RUN, "s-1") !== undefined, "the turn never held its session");

    await steps.join(RUN, "s-1", PERSON);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(stopped, [], "the turn runs until its program has the prompt");

    deliver.resolve();
    assert.deepEqual(await turn, JOINED);
    assert.deepEqual(stopped, ["stopped"]);
    assert.equal(sessionHolds(paths).held(RUN, "s-1")?.pid, PERSON);
    await steps.dispose();
  });
});

describe("a turn the run stops", () => {
  it("lets go of its session at once, though its program never closes, so the step's next turn does not wait on it", async () => {
    const { paths } = testHome();
    const holds = sessionHolds(paths, { pollMs: 10 });
    const hangs: InnerRunner = {
      async run(_prompt, request) {
        request.onSessionOpen?.(REF);
        // A program that never closes, even once the turn is stopped.
        return new Promise(() => {});
      },
    };
    const stop = new AbortController();
    const steps = createSteps({ cwd: "/", inner: hangs, holds });
    void steps.run("Work.", routed(steps, { label: "a", model: "claude/haiku" }, { runId: RUN, callIndex: 0, signal: stop.signal }));
    await waitUntil(() => holds.held(RUN, "s-1") !== undefined, "the turn never held its session");

    stop.abort();
    assert.equal(holds.held(RUN, "s-1"), undefined, "the stopped turn still holds its session");
    // A resume's worker in this same process goes on in the session at once.
    const answers: InnerRunner = { run: async () => "Done." };
    const next = createSteps({ cwd: "/", inner: answers, holds });
    const resumed = next.run("Go on.", routed(next, { label: "a", model: "claude/haiku" }, { runId: RUN, callIndex: 1, continueFromSession: REF, continueWithPrompt: true, signal: AbortSignal.timeout(2000) }));
    assert.equal(await resumed, "Done.");
    assert.equal(holds.held(RUN, "s-1"), undefined);
  });
});

// Piece 12, tell. The steering board knows the agent calls that run now, each with the steer seam
// its program opened, and sends a tell to the calls it names. The steps module opens a call on
// the board when its turn starts and closes it when the call ends (design, "The engine side").
//
// steering.ts does not exist yet, so it comes through a dynamic import, and each test fails on
// that import alone. The steps module's own tests stay as they are.
//
// Choices the design leaves open, made here:
// - `call: n` is the nth call of that label, counted from 1 in callIndex order among the calls
//   the board has seen open, the way `sous step --call` counts them. A call that closed keeps its
//   number, so the numbers of the calls that still run never shift. The other options were the
//   position among the open calls only, which shifts as calls end, and the raw callIndex, which
//   no person or agent sees. A call number no running call has reaches nothing.
// - Every call told gets the same text and the same id. Claude Code takes the id as the message's
//   uuid, so the id stays one UUID for the whole tell.
// - A send that throws counts as "ended" for its call, and the other calls still get the tell.
// - Opening a call that is already open replaces its send, as a turn that starts again would.
// - A tell that names no open call returns an empty list and sends nothing.
// - The results come in callIndex order.
// - The steps module reports a user message after the first prompt as a `tell` activity entry,
//   so `sous step` shows when the program read it. The first prompt stays a `prompt` entry.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Account } from "@sous-run/harnesses";
import type { StepRequest } from "../src/steps/agent-run.js";
import type { StepAsk } from "../src/steps/agent-runner.js";
import { createSteps, type StepsOptions } from "../src/steps/steps.js";
import { waitUntil } from "./helpers/async.js";

type SteerOutcome = "delivered" | "not_steerable" | "ended";
type Steer = (text: string, id: string) => Promise<SteerOutcome>;
interface LiveCall {
  scope: string;
  callIndex: number;
  label?: string;
}
interface Board {
  open(call: LiveCall, send: Steer): void;
  close(call: LiveCall): void;
  tell(target: { label: string; call?: number }, text: string, id: string): Promise<Array<{ call: LiveCall; outcome: SteerOutcome }>>;
}

const steering = async () => (await import("../src/steps/steering.js" as string)) as { SteeringBoard: new () => Board };

/** A send that notes each message it gets and answers with `outcome`. */
function sender(outcome: SteerOutcome | (() => Promise<SteerOutcome>) = "delivered") {
  const got: Array<{ text: string; id: string }> = [];
  const send: Steer = async (text, id) => {
    got.push({ text, id });
    return typeof outcome === "string" ? outcome : outcome();
  };
  return { send, got };
}

const RUN = "run-tell";
const call = (callIndex: number, label = "impl"): LiveCall => ({ scope: RUN, callIndex, label });

describe("piece 12: the steering board", () => {
  it("two open calls labeled impl both get a tell, and a call of another label does not", async () => {
    const { SteeringBoard } = await steering();
    const board = new SteeringBoard();
    const first = sender();
    const second = sender();
    const review = sender();
    board.open(call(1), first.send);
    board.open(call(2, "review"), review.send);
    board.open(call(3), second.send);
    const id = randomUUID();
    const told = await board.tell({ label: "impl" }, "Use the v2 API.", id);
    assert.deepEqual(
      told.map((result) => result.call.callIndex),
      [1, 3],
    );
    assert.deepEqual(first.got, [{ text: "Use the v2 API.", id }]);
    assert.deepEqual(second.got, [{ text: "Use the v2 API.", id }]);
    assert.deepEqual(review.got, [], "a call of another label gets nothing");
  });

  it("call: 2 reaches only the second call of the label", async () => {
    const { SteeringBoard } = await steering();
    const board = new SteeringBoard();
    const first = sender();
    const second = sender();
    board.open(call(3), first.send);
    board.open(call(4, "review"), sender().send);
    board.open(call(5), second.send);
    const told = await board.tell({ label: "impl", call: 2 }, "Only you.", randomUUID());
    assert.deepEqual(told, [{ call: call(5), outcome: "delivered" }]);
    assert.equal(first.got.length, 0, "the first call gets nothing");
    assert.equal(second.got.length, 1);
  });

  it("a call keeps its number after an earlier call of its label closed", async () => {
    const { SteeringBoard } = await steering();
    const board = new SteeringBoard();
    const second = sender();
    board.open(call(3), sender().send);
    board.open(call(5), second.send);
    board.close(call(3));
    const told = await board.tell({ label: "impl", call: 2 }, "Still you.", randomUUID());
    assert.deepEqual(told, [{ call: call(5), outcome: "delivered" }]);
    assert.deepEqual(await board.tell({ label: "impl", call: 1 }, "The first ended.", randomUUID()), [], "call 1 closed, so it reaches nothing");
    assert.deepEqual(await board.tell({ label: "impl", call: 3 }, "No third.", randomUUID()), [], "no call has number 3");
    assert.equal(second.got.length, 1);
  });

  it("a closed call is not told", async () => {
    const { SteeringBoard } = await steering();
    const board = new SteeringBoard();
    const closed = sender();
    const open = sender();
    board.open(call(1), closed.send);
    board.open(call(2), open.send);
    board.close(call(1));
    const told = await board.tell({ label: "impl" }, "Hello.", randomUUID());
    assert.deepEqual(told, [{ call: call(2), outcome: "delivered" }]);
    assert.deepEqual(closed.got, []);
    board.close(call(2));
    assert.deepEqual(await board.tell({ label: "impl" }, "Anyone?", randomUUID()), [], "with every call closed, the tell reaches nothing");
    assert.equal(open.got.length, 1, "the closed call gets nothing more");
  });

  it("each result carries its call and its outcome, and a send that throws counts as ended", async () => {
    const { SteeringBoard } = await steering();
    const board = new SteeringBoard();
    board.open(call(1), sender("delivered").send);
    board.open(call(2), sender("not_steerable").send);
    board.open(call(3), sender("ended").send);
    board.open(
      call(4),
      sender(async () => {
        throw new Error("the pipe closed");
      }).send,
    );
    const told = await board.tell({ label: "impl" }, "Check the tests.", randomUUID());
    assert.deepEqual(told, [
      { call: call(1), outcome: "delivered" },
      { call: call(2), outcome: "not_steerable" },
      { call: call(3), outcome: "ended" },
      { call: call(4), outcome: "ended" },
    ]);
  });

  it("opening a call again replaces its send", async () => {
    const { SteeringBoard } = await steering();
    const board = new SteeringBoard();
    const old = sender();
    const fresh = sender();
    board.open(call(1), old.send);
    board.open(call(1), fresh.send);
    const told = await board.tell({ label: "impl" }, "Once.", randomUUID());
    assert.equal(told.length, 1, "one call, told once");
    assert.deepEqual([old.got.length, fresh.got.length], [0, 1]);
  });

  it("a label no call has reaches nothing", async () => {
    const { SteeringBoard } = await steering();
    const board = new SteeringBoard();
    const impl = sender();
    board.open(call(1), impl.send);
    assert.deepEqual(await board.tell({ label: "deploy" }, "Hello.", randomUUID()), []);
    assert.deepEqual(impl.got, []);
  });
});

interface Seam {
  readonly steer: (send: Steer | undefined) => void;
  close(): void;
}
const seamOf = async () => (await import("../src/steps/steering.js")) as unknown as { SteeringBoard: new () => Board; CallSeam: new (board: Board, call: LiveCall) => Seam };

// One program runs every turn of a step, so a call's seam outlives each turn. The adapter opens
// it at each turn's start with steer(send) and closes it at the turn's end with steer(undefined).
describe("one program per step: a call's seam across its turns", () => {
  it("sends a tell into the turn that runs now", async () => {
    const { SteeringBoard, CallSeam } = await seamOf();
    const board = new SteeringBoard();
    const seam = new CallSeam(board, call(1));
    const turn = sender();
    seam.steer(turn.send);
    const id = randomUUID();
    assert.deepEqual(await board.tell({ label: "impl" }, "Use the v2 API.", id), [{ call: call(1), outcome: "delivered" }]);
    assert.deepEqual(turn.got, [{ text: "Use the v2 API.", id }]);
  });

  it("keeps a tell sent between two turns and sends it into the next one", async () => {
    const { SteeringBoard, CallSeam } = await seamOf();
    const board = new SteeringBoard();
    const seam = new CallSeam(board, call(1));
    const first = sender();
    const second = sender();
    seam.steer(first.send);
    seam.steer(undefined);
    const id = randomUUID();
    const told = board.tell({ label: "impl" }, "Between turns.", id);
    seam.steer(second.send);
    assert.deepEqual(await told, [{ call: call(1), outcome: "delivered" }]);
    assert.deepEqual([first.got, second.got], [[], [{ text: "Between turns.", id }]]);
  });

  it("answers ended for a tell still waiting when the call ends, and takes no tell after", async () => {
    const { SteeringBoard, CallSeam } = await seamOf();
    const board = new SteeringBoard();
    const seam = new CallSeam(board, call(1));
    const turn = sender();
    seam.steer(turn.send);
    seam.steer(undefined);
    const told = board.tell({ label: "impl" }, "Too late.", randomUUID());
    seam.close();
    assert.deepEqual(await told, [{ call: call(1), outcome: "ended" }]);
    assert.deepEqual(await board.tell({ label: "impl" }, "After.", randomUUID()), [], "the ended call is off the board");
    seam.steer(sender().send);
    assert.deepEqual(await board.tell({ label: "impl" }, "Still after.", randomUUID()), [], "a closed seam does not open again");
    assert.deepEqual(turn.got, []);
  });
});

// The steps module on the fake programs, with a board in StepsOptions.steering. StepsOptions has
// no steering field yet, so the options go through a cast.

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
for (const name of ["FAKE_VERSION", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

function fakePlace(rules: object[]) {
  const dir = mkdtempSync(join(tmpdir(), "engine-steering-"));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  const accounts: Record<"claude" | "codex", Account> = { claude: { folder: join(dir, "claude-home") }, codex: { folder: join(dir, "codex-home") } };
  for (const account of Object.values(accounts)) mkdirSync(account.folder!);
  const log = join(dir, "fake.log");
  const rulesFile = join(dir, "rules.json");
  writeFileSync(rulesFile, JSON.stringify(rules));
  process.env.FAKE_LOG = log;
  process.env.FAKE_RULES = rulesFile;
  return {
    cwd,
    accounts,
    gate: (name: string) => writeFileSync(join(dir, name), ""),
    lines: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>) : []),
  };
}

function routed(steps: ReturnType<typeof createSteps>, ask: StepAsk, fields: Omit<StepRequest, "route">): StepRequest {
  const route = steps.route(ask);
  return { label: ask.label, ...fields, ...(route.requested === undefined ? {} : { model: route.requested }), route };
}

interface ActivityEntry {
  kind: string;
  text: string;
}

describe("piece 12: the steps module opens each agent call on the board", () => {
  for (const [harness, model] of [
    ["codex", "codex/gpt-6.1-sol"],
    ["claude", "claude/haiku"],
  ] as const) {
    it(`a ${harness} call is open while its turn runs, reads the tell after its tool call, reports it as a tell entry, and closes when it ends`, async () => {
      const { SteeringBoard } = await steering();
      const board = new SteeringBoard();
      const place = fakePlace([{ match: "Build it", tool: "echo building", hold: "go", answer: "Built." }]);
      const seen: Array<{ step: LiveCall; entry: ActivityEntry }> = [];
      const options = {
        cwd: place.cwd,
        programs: (name: string) => ({ path: join(FAKES, name), env: {} }),
        accounts: place.accounts,
        onActivity: (step: LiveCall, entry: ActivityEntry) => seen.push({ step, entry }),
        steering: board,
      } as unknown as StepsOptions;
      const steps = createSteps(options);
      const text = "Use the v2 API.";
      const id = randomUUID();
      try {
        const running = steps.run("Build it.", routed(steps, { label: "impl", model }, { runId: RUN, callIndex: 2 }));
        // The turn's tool call runs once its activity shows it. The seam is open by then.
        await waitUntil(() => seen.some(({ entry }) => entry.kind === "tool"), "the step's tool call to start", 15_000);
        let settled = false;
        const told = board.tell({ label: "impl" }, text, id).finally(() => (settled = true));
        if (harness === "claude") {
          // Claude Code queues the message and reads it after the tool call, so the outcome waits.
          // A tell that reached no call settles at once, and the check below says so.
          await waitUntil(() => settled || place.lines().some((line) => line.steer?.text === text && line.state === "queued"), "the message to be queued", 15_000);
        }
        place.gate("go");
        assert.deepEqual(await told, [{ call: { scope: RUN, callIndex: 2, label: "impl" }, outcome: "delivered" }]);
        assert.equal(await running, "Built.");
      } finally {
        place.gate("go");
        await steps.dispose();
      }
      assert.ok(place.lines().some((line) => line.steer?.text === text && line.state === "read"), "the program read the message");
      const tells = seen.filter(({ entry }) => entry.kind === "tell");
      assert.deepEqual(
        tells.map(({ entry }) => entry.text),
        [text],
        `the read message is one tell entry: ${JSON.stringify(seen.map(({ entry }) => entry))}`,
      );
      assert.deepEqual(tells[0]!.step, { scope: RUN, callIndex: 2, label: "impl" });
      assert.equal(seen.filter(({ entry }) => entry.kind === "prompt").length, 1, "the first prompt stays a prompt entry");
      assert.ok(!seen.some(({ entry }) => entry.kind === "tell" && /Build it\./.test(entry.text)), "the first prompt is not a tell");
      // The call ended, so the board no longer has it.
      assert.deepEqual(await board.tell({ label: "impl" }, "Too late.", randomUUID()), []);
    });
  }
});

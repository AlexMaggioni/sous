// A room in the graph: a box with a lane per member. In a run, a room's turns are the members'
// steps, each tagged with the room's name and call, and they fill the room's lanes, never the nodes
// of the members' own sends around it.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { Flow, FlowNode, FlowStep, Question, Room, Status, Step } from "../src/api/contract.ts";
import { FlowGraph } from "../src/graph/flow-graph.tsx";
import { savedGraph } from "../src/graph/model.ts";
import { runGraph } from "../src/graph/overlay.ts";
import { kidsOf, type Box, type Leaf, type Part } from "../src/graph/tree.ts";
import { planOf } from "../src/plan/plan.ts";

let n = 0;
const at = () => ({ id: `n${++n}`, line: n });
const step = (kind: FlowStep["kind"], label: string, more: Partial<FlowStep> = {}): FlowStep => ({ t: "step", ...at(), kind, label, ...more });
const flow = (...nodes: FlowNode[]): Flow => ({ nodes, notes: [] });
const NOW = Date.parse("2026-11-25T10:00:00Z");

type Turn = [label: string, status: Status, room?: [name: string, call: number]];

/** Agent steps as the engine records them, one minute apart, each 30s long unless it runs. */
function ran(list: Turn[]): Step[] {
  return list.map(([label, status, room], i) => ({
    key: `r1:${i + 1}`,
    label,
    name: label,
    scope: "r1",
    call: 1,
    kind: "agent",
    status,
    startedAt: new Date(NOW - (list.length - i) * 60_000).toISOString(),
    ...(status === "running" ? {} : { durationMs: 30_000 }),
    ...(room ? { room: { name: room[0], call: room[1] } } : {}),
  }));
}

/** The run's record of a room, two members who agreed in one round unless `more` says otherwise. */
const record = (more: Partial<Room> = {}): Room => ({
  scope: "r1",
  name: "plan",
  call: 1,
  goal: "Agree on a plan.",
  members: ["a", "b"],
  turns: "together",
  hears: "all",
  rounds: 1,
  transcript: [],
  ended: "agreed",
  ...more,
});

function boxes(p: Part): Box[] {
  return [...(p.t === "box" ? [p] : []), ...kidsOf(p).flatMap(boxes)];
}
function leaves(p: Part): Leaf[] {
  return p.t === "leaf" ? [p] : kidsOf(p).flatMap(leaves);
}
const roomIn = (p: Part) => boxes(p).find((b) => b.kind === "room");
/** Each lane of a room: its member, status, step and calls. */
const lanes = (box: Box | undefined) => (box ? leaves(box).map((l) => ({ label: l.label, status: l.status, step: l.step, calls: l.calls })) : []);

describe("a saved room", () => {
  test("is a box with a lane per member, in the order the text names them", () => {
    const room = step("room", "plan", { members: ["planner", "critic"], prompt: "Agree on a plan." });
    const box = roomIn(savedGraph(flow(room)));
    expect(box).toMatchObject({ kind: "room", title: "plan", node: room.id, foldable: true, tip: "Room plan: Agree on a plan." });
    expect(leaves(box!).map((l) => [l.label, l.kind])).toEqual([
      ["planner", "agent"],
      ["critic", "agent"],
    ]);
    // The two members sit side by side, as they talk in the same rounds.
    expect(box!.body?.items[0]?.t).toBe("par");
  });

  test("a member the text makes at run time shows as an ellipsis, and a room that takes turns in order says so", () => {
    const box = roomIn(savedGraph(flow(step("room", "room", { members: ["lead", "{reviewer}"], options: { turns: "in order" } }))));
    expect(leaves(box!).map((l) => l.label)).toEqual(["lead", "…"]);
    expect(box).toMatchObject({ title: "room", sub: "in order" });
  });

  test("a room whose list of members the text makes at run time stays one node", () => {
    const g = savedGraph(flow(step("room", "plan")));
    expect(roomIn(g)).toBeUndefined();
    expect(leaves(g).find((l) => l.label === "plan")?.kind).toBe("room");
  });
});

describe("a room in a run", () => {
  const before = step("agent", "a");
  const plan = step("room", "plan", { members: ["a", "b"], prompt: "Agree on a plan." });
  const after = step("agent", "b");
  const text = flow(before, plan, after);

  test("its turns fill the lanes, and the members' own sends around it keep their nodes", () => {
    const { graph, asRan } = runGraph({
      flow: text,
      steps: ran([
        ["a", "done"],
        ["a", "done", ["plan", 1]],
        ["b", "done", ["plan", 1]],
        ["a", "done", ["plan", 1]],
        ["b", "done", ["plan", 1]],
        ["b", "done"],
      ]),
      rooms: [record({ rounds: 2 })],
      status: "done",
      now: NOW,
    });
    expect(asRan).toBe(false);
    const box = roomIn(graph);
    expect(box).toMatchObject({ title: "plan", status: "done", sub: "agreed, 2 rounds", room: { scope: "r1", name: "plan", call: 1 } });
    expect(lanes(box)).toEqual([
      { label: "a", status: "done", step: "r1:4", calls: ["r1:2", "r1:4"] },
      { label: "b", status: "done", step: "r1:5", calls: ["r1:3", "r1:5"] },
    ]);
    // Four turns of 30s, from the first start to the last end.
    expect(box?.duration).toBe("3m 30s");
    const outside = leaves(graph).filter((l) => l.node === before.id || l.node === after.id);
    expect(outside.map((l) => [l.label, l.step])).toEqual([
      ["a", "r1:1"],
      ["b", "r1:6"],
    ]);
  });

  test("a send after the room takes its own step, not a turn of the same member", () => {
    const { graph, asRan } = runGraph({
      flow: flow(plan, step("agent", "a")),
      steps: ran([
        ["a", "done", ["plan", 1]],
        ["b", "done", ["plan", 1]],
        ["a", "running"],
      ]),
      rooms: [record()],
      status: "running",
      now: NOW,
    });
    expect(asRan).toBe(false);
    expect(lanes(roomIn(graph))[0]).toMatchObject({ label: "a", step: "r1:1" });
    expect(leaves(graph).find((l) => l.label === "a" && l.node !== undefined && !l.key.includes("@"))).toMatchObject({ status: "running", step: "r1:3" });
  });

  test("between two rounds every turn ended, and the room still talks", () => {
    const { graph } = runGraph({
      flow: text,
      steps: ran([
        ["a", "done"],
        ["a", "done", ["plan", 1]],
        ["b", "done", ["plan", 1]],
      ]),
      rooms: [record({ ended: undefined })],
      status: "running",
      now: NOW,
    });
    expect(roomIn(graph)).toMatchObject({ status: "running", sub: "round 1" });
    expect(leaves(graph).find((l) => l.node === after.id)?.status).toBe("queued");
  });

  test("a member whose turn asked needs the person, and so does its room", () => {
    const steps = ran([
      ["a", "done"],
      ["a", "done", ["plan", 1]],
      ["b", "done", ["plan", 1]],
    ]);
    const asked: Question = { id: "q1", runId: "r1", scope: "r1", workflow: "talk", prompt: "Which plan?", kind: "input", breakpoint: false, answeredBy: "people", askedAt: steps[2]!.startedAt!, step: "b" };
    const { graph } = runGraph({ flow: text, steps, rooms: [record({ ended: undefined })], questions: [asked], status: "running", now: NOW });
    const box = roomIn(graph);
    expect(lanes(box)[1]).toMatchObject({ label: "b", status: "needs" });
    expect(leaves(box!)[1]).toMatchObject({ needs: true, ask: "q1" });
    expect(box).toMatchObject({ status: "needs", needs: true });
  });

  test("a room that has not talked shows its members waiting, and skipped once the run ended", () => {
    const steps = ran([["a", "running"]]);
    const waiting = roomIn(runGraph({ flow: text, steps, status: "running", now: NOW }).graph);
    expect(waiting).toMatchObject({ title: "plan", status: "queued" });
    expect(waiting?.room).toBeUndefined();
    expect(lanes(waiting).map((l) => [l.label, l.status])).toEqual([
      ["a", "queued"],
      ["b", "queued"],
    ]);
    const ended = roomIn(runGraph({ flow: text, steps: ran([["a", "failed"]]), status: "failed", now: NOW }).graph);
    expect(ended?.status).toBe("skipped");
  });

  test("in a loop, the graph shows the room's latest call, and the loop its round", () => {
    const inLoop = step("room", "plan", { members: ["a", "b"] });
    const { graph, asRan } = runGraph({
      flow: flow({ t: "loop", ...at(), loop: "for", label: "goal of goals", body: [inLoop] }),
      steps: ran([
        ["a", "done", ["plan", 1]],
        ["b", "done", ["plan", 1]],
        ["a", "done", ["plan", 2]],
        ["b", "running", ["plan", 2]],
      ]),
      rooms: [record(), record({ call: 2, ended: undefined, goal: "Agree on a name." })],
      status: "running",
      now: NOW,
    });
    expect(asRan).toBe(false);
    expect(boxes(graph).find((b) => b.kind === "loop")?.sub).toBe("round 2");
    const box = roomIn(graph);
    expect(box).toMatchObject({ room: { call: 2 }, status: "running", tip: "Room plan: Agree on a name." });
    expect(lanes(box).map((l) => [l.label, l.step, l.status])).toEqual([
      ["a", "r1:3", "done"],
      ["b", "r1:4", "running"],
    ]);
  });

  test("a room the text leaves unnamed takes the room the engine named for it", () => {
    const { graph, asRan } = runGraph({
      flow: flow(step("room", "room", { members: ["a", "b"] })),
      steps: ran([
        ["a", "done", ["room", 1]],
        ["b", "done", ["room", 1]],
      ]),
      rooms: [record({ name: "room" })],
      status: "done",
      now: NOW,
    });
    expect(asRan).toBe(false);
    expect(roomIn(graph)).toMatchObject({ title: "room", status: "done" });
  });

  test("without the text, each room shows as a box in the order it ran, its members from the run's record", () => {
    const { graph, asRan } = runGraph({
      steps: ran([
        ["a", "done"],
        ["b", "done", ["plan", 1]],
        ["a", "done", ["plan", 1]],
      ]),
      rooms: [record()],
      status: "done",
      now: NOW,
    });
    expect(asRan).toBe(true);
    expect(graph.items.map((p) => (p.t === "leaf" ? p.label : p.t === "box" ? `box ${p.title}` : p.t))).toEqual(["start", "a", "box plan", "end"]);
    expect(lanes(roomIn(graph)).map((l) => [l.label, l.step])).toEqual([
      ["a", "r1:3"],
      ["b", "r1:2"],
    ]);
  });
});

describe("the drawing of a room", () => {
  test("its head names it with its round, and each member is a node a screen reader can name", () => {
    const text = flow(step("room", "plan", { members: ["a", "b"] }));
    const steps = ran([
      ["a", "done", ["plan", 1]],
      ["b", "running", ["plan", 1]],
    ]);
    render(<FlowGraph plan={planOf(text, undefined, { steps, status: "running", nested: [], questions: [], rooms: [record({ ended: undefined })] })} flow={text} run label="Graph of r1" />);
    const region = screen.getByRole("region", { name: "Graph of r1" });
    expect(within(region).getByText("plan")).toBeInTheDocument();
    expect(within(region).getByText("round 1")).toBeInTheDocument();
    const outline = screen.getByRole("list", { name: "The graph's steps, in order" });
    const items = within(outline).getAllByRole("listitem").map((li) => li.textContent);
    expect(items.some((t) => t?.startsWith("plan round 1"))).toBe(true);
    expect(items).toContain("a 30s, done");
    // A running turn counts up from the real clock in a render, so only its status is fixed.
    expect(items.some((t) => /^b .*, running$/.test(t ?? ""))).toBe(true);
  });
});

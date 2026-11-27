import { describe, expect, test } from "vitest";
import type { Flow, FlowNode, FlowStep, Question, Status, Step } from "../src/api/contract.ts";
import { savedGraph } from "../src/graph/model.ts";
import { runGraph } from "../src/graph/overlay.ts";
import type { Box, Leaf, Par, Part, Seq } from "../src/graph/tree.ts";
import { kidsOf } from "../src/graph/tree.ts";
import { GRAPH_STATES, planOfState } from "../src/kit/fixtures.ts";

let n = 0;
const at = () => ({ id: `n${++n}`, line: n });
const step = (kind: FlowStep["kind"], label: string, more: Partial<FlowStep> = {}): FlowStep => ({ t: "step", ...at(), kind, label, ...more });
const flow = (...nodes: FlowNode[]): Flow => ({ nodes, notes: [] });
const NOW = Date.parse("2026-11-25T10:00:00Z");

/** Steps as the engine records them, one minute apart, each 30s long unless it runs. */
function ran(scope: string, list: Array<[label: string, kind: Step["kind"], status: Status, more?: Partial<Step>]>, prefix = ""): Step[] {
  return list.map(([label, kind, status, more], i) => ({
    key: `${scope}:${i + 1}`,
    label,
    name: prefix ? `${prefix}: ${label}` : label,
    scope,
    call: 1,
    kind,
    status,
    startedAt: new Date(NOW - (list.length - i) * 60_000).toISOString(),
    ...(status === "running" ? {} : { durationMs: 30_000 }),
    ...more,
  }));
}

/** Every leaf, depth first, and every box. */
function leaves(p: Part): Leaf[] {
  return p.t === "leaf" ? [p] : kidsOf(p).flatMap(leaves);
}
function boxes(p: Part): Box[] {
  return [...(p.t === "box" ? [p] : []), ...kidsOf(p).flatMap(boxes)];
}
const byLabel = (g: Seq, label: string) => leaves(g).find((l) => l.label === label);

describe("a run over the graph of its text", () => {
  test("each node takes the step with its label, with its status, time and key", () => {
    const { graph, asRan } = runGraph({
      flow: flow(step("sh", "tests"), step("agent", "reviewer", { agent: "code-reviewer" }), step("sh", "commit")),
      steps: ran("r1", [["tests", "exec", "done"], ["reviewer", "agent", "running"]]),
      status: "running",
      now: NOW,
    });
    expect(asRan).toBe(false);
    expect(byLabel(graph, "tests")).toMatchObject({ status: "done", duration: "30s", step: "r1:1" });
    // The agent moves to the tooltip in a run.
    expect(byLabel(graph, "reviewer")).toMatchObject({ status: "running", duration: "1m 00s", tip: "reviewer, agent code-reviewer" });
    expect(byLabel(graph, "reviewer")?.sub).toBeUndefined();
    expect(byLabel(graph, "commit")).toMatchObject({ status: "queued" });
    expect(byLabel(graph, "commit")?.step).toBeUndefined();
  });

  test("a node that never ran is skipped once the run ended", () => {
    const { graph } = runGraph({ flow: flow(step("sh", "a"), step("sh", "b")), steps: ran("r1", [["a", "exec", "failed"]]), status: "failed" });
    expect(byLabel(graph, "b")?.status).toBe("skipped");
  });

  test("a step with no label finds its node by kind and the name the engine gives it", () => {
    const { graph, asRan } = runGraph({
      flow: flow(step("sh", "sh"), step("agent", "agent"), step("run", "run"), step("agent", "agent")),
      steps: ran("r1", [
        ["sh: pnpm test", "exec", "done"],
        ["build agent 1", "agent", "done"],
        ["run: scripts/x.sh", "exec", "done"],
        ["asking-agent-2", "agent", "running"],
      ]),
    });
    expect(asRan).toBe(false);
    expect(leaves(graph).map((l) => l.step)).toEqual(["r1:1", "r1:2", "r1:3", "r1:4"]);
  });

  test("an asking agent's answer turns belong to it, and the last one gives its status", () => {
    const { graph, asRan } = runGraph({
      flow: flow(step("agent", "triager")),
      steps: ran("r1", [["triager", "agent", "done"], ["triager (answer 1)", "agent", "running"]]),
    });
    expect(asRan).toBe(false);
    expect(byLabel(graph, "triager")?.status).toBe("running");
  });

  test("a step whose label changed takes the node of its kind in order, between the nodes around it", () => {
    const { graph, asRan } = runGraph({
      flow: flow(step("sh", "fetch"), step("agent", "plan"), step("sh", "tests")),
      steps: ran("r1", [["fetch", "exec", "done"], ["plan the work", "agent", "done"], ["tests", "exec", "running"]]),
    });
    expect(asRan).toBe(false);
    expect(byLabel(graph, "plan")).toMatchObject({ step: "r1:2", status: "done", tip: "plan, ran as plan the work" });
  });

  test("order places no step when no node took one by its name", () => {
    const { asRan } = runGraph({ flow: flow(step("sh", "fetch"), step("sh", "tests")), steps: ran("r1", [["fetch all", "exec", "done"]]) });
    expect(asRan).toBe(true);
  });

  test("an ask waits on the person when its question is open, and reads done once a later step ran", () => {
    const q: Question = { id: "q1", runId: "r1", scope: "r1", workflow: "w", prompt: "Plan the urgent ones now?", kind: "confirm", breakpoint: false, answeredBy: "people", askedAt: "" };
    const f = flow(step("agent", "triage"), step("ask", "Plan the urgent ones now?"), step("agent", "plan"));
    const waiting = runGraph({ flow: f, steps: ran("r1", [["triage", "agent", "done"]]), questions: [q], status: "needs" });
    expect(byLabel(waiting.graph, "Plan the urgent ones now?")).toMatchObject({ status: "needs", needs: true, ask: "q1" });
    const passed = runGraph({ flow: f, steps: ran("r1", [["triage", "agent", "done"], ["plan", "agent", "running"]]) });
    expect(byLabel(passed.graph, "Plan the urgent ones now?")?.status).toBe("done");
  });

  test("an ask answered on the page reads done at once, before the next step starts, and never queued between", () => {
    const q: Question = { id: "q1", runId: "r1", scope: "r1", workflow: "w", prompt: "Ship it?", kind: "confirm", breakpoint: false, answeredBy: "people", askedAt: "" };
    const f = flow(step("sh", "prepare"), step("ask", "Ship it?"), step("ask", "Tell the team?"), step("sh", "deploy"));
    const steps = ran("r1", [["prepare", "exec", "done"]]);
    // The server still lists the question for a moment, then drops it. Both read done.
    for (const questions of [[q], []]) {
      const { graph } = runGraph({ flow: f, steps, questions, answered: [q], status: "running" });
      expect(byLabel(graph, "Ship it?")).toMatchObject({ status: "done" });
      expect(byLabel(graph, "Ship it?")?.needs).toBeUndefined();
      // The next gate, not asked yet, still waits.
      expect(byLabel(graph, "Tell the team?")?.status).toBe("queued");
    }
    expect(byLabel(runGraph({ flow: f, steps, status: "running" }).graph, "Ship it?")?.status).toBe("queued");
  });

  test("a step named checkpoint, as the engine names a wait, takes the ask in order", () => {
    const { graph, asRan } = runGraph({
      flow: flow(step("ask", "Build these?"), step("sh", "build")),
      steps: ran("r1", [["checkpoint", "exec", "done"], ["build", "exec", "done"]]),
    });
    expect(asRan).toBe(false);
    expect(byLabel(graph, "Build these?")).toMatchObject({ step: "r1:1", status: "done" });
  });
});

describe("the rounds of a loop", () => {
  const ticket = () =>
    flow(
      step("agent", "implementer"),
      { t: "loop", ...at(), loop: "for", label: "round < args.rounds", limit: "args.rounds", body: [{ t: "if", ...at(), cond: "feedback", then: [step("agent", "address review")] }, step("agent", "reviewer")] },
      step("sh", "tests"),
    );

  test("the box names the round, and its steps show the latest one", () => {
    const { graph, asRan } = runGraph({
      flow: ticket(),
      args: { rounds: 3 },
      status: "running",
      steps: ran("r1", [
        ["implementer", "agent", "done"],
        ["reviewer", "agent", "done"],
        ["address review", "agent", "done"],
        ["reviewer", "agent", "running"],
      ]),
    });
    expect(asRan).toBe(false);
    const [loop] = boxes(graph);
    expect(loop).toMatchObject({ kind: "loop", sub: "round 2 of 3", again: "next ×3" });
    expect(leaves(loop).map((l) => [l.label, l.step])).toEqual([
      ["address review", "r1:3"],
      ["reviewer", "r1:4"],
    ]);
    expect(byLabel(graph, "tests")?.status).toBe("queued");
    // Each step keeps the calls of the earlier rounds, oldest first.
    expect(byLabel(graph, "reviewer")?.calls).toEqual(["r1:2", "r1:4"]);
    expect(byLabel(graph, "address review")?.calls).toBeUndefined();
  });

  test("the first round shows the detour that waits for feedback as not run", () => {
    const { graph } = runGraph({ flow: ticket(), args: { rounds: 3 }, status: "running", steps: ran("r1", [["implementer", "agent", "done"], ["reviewer", "agent", "running"]]) });
    expect(boxes(graph)[0].sub).toBe("round 1 of 3");
    expect(byLabel(graph, "address review")?.status).toBe("queued");
  });

  test("a loop takes no more rounds than its limit", () => {
    const { graph, asRan } = runGraph({
      flow: flow({ t: "loop", ...at(), loop: "for", label: "i < 2", limit: "2", body: [step("sh", "check")] }, step("sh", "check")),
      steps: ran("r1", [["check", "exec", "done"], ["check", "exec", "done"], ["check", "exec", "running"]]),
    });
    expect(asRan).toBe(false);
    expect(boxes(graph)[0].sub).toBe("round 2 of 2");
    expect(leaves(graph).map((l) => l.step)).toEqual(["r1:2", "r1:3"]);
  });

  test("a step that retried shows its tries", () => {
    const { graph } = runGraph({ flow: flow(step("sh", "verify", { retries: 2 })), steps: ran("r1", [["verify", "exec", "failed", { tries: 3 }]]) });
    expect(byLabel(graph, "verify")?.retries).toBe("↻ 2 of 2");
  });
});

describe("pipelines and nested runs", () => {
  test("a pipeline shows its count and opens to its items, each with its own steps", () => {
    const { graph, asRan } = runGraph({
      flow: flow({ t: "pipeline", ...at(), over: "packages", stages: [[step("agent", "upgrade {name}", { dynamic: true })], [step("sh", "test {name}", { dynamic: true })]] }),
      steps: ran("r1", [
        ["upgrade react", "agent", "done"],
        ["upgrade vite", "agent", "done"],
        ["test react", "exec", "done"],
        ["upgrade zod", "agent", "needs"],
        ["upgrade jest", "agent", "running"],
      ]),
    });
    expect(asRan).toBe(false);
    const [pipe] = boxes(graph);
    expect(pipe).toMatchObject({ kind: "pipeline", count: "×4", status: "needs", needs: true, folded: false });
    const lanes = (pipe.body?.items[0] as Par).lanes;
    expect(lanes.map((l) => leaves(l).map((x) => `${x.label} ${x.status}`))).toEqual([
      ["upgrade react done", "test react done"],
      ["upgrade vite done", "test vite queued"],
      ["upgrade zod needs", "test zod queued"],
      ["upgrade jest running", "test jest queued"],
    ]);
  });

  test("a finished pipeline folds to one node", () => {
    const { graph } = runGraph({
      flow: flow({ t: "pipeline", ...at(), over: "files", stages: [[step("agent", "read")]] }),
      status: "done",
      steps: ran("r1", [["read", "agent", "done"], ["read", "agent", "done"]]),
    });
    expect(boxes(graph)[0]).toMatchObject({ count: "×2", status: "done", folded: true });
  });

  test("a nested run is a box over its own workflow's graph, found by its steps' names", () => {
    const docs = flow(step("sh", "changes"), step("agent", "update docs"));
    const { graph, asRan } = runGraph({
      flow: flow(step("sh", "log"), step("workflow", "docs", { workflow: "docs-sync" })),
      flows: { "docs-sync": docs },
      nested: [{ id: "r1.1", parent: "r1", workflow: "docs-sync", label: "docs" }],
      steps: [...ran("r1", [["log", "exec", "done"]]), ...ran("r1.1", [["changes", "exec", "done"], ["update docs", "agent", "running"]], "docs")],
    });
    expect(asRan).toBe(false);
    const [box] = boxes(graph);
    expect(box).toMatchObject({ kind: "workflow", title: "docs", sub: "docs-sync", status: "running", auto: true });
    expect(leaves(box).map((l) => l.step)).toEqual(["r1.1:1", "r1.1:2"]);
  });
});

describe("the steps as they ran", () => {
  test("without the text, the graph shows the steps in order and each nested run in its box", () => {
    const { graph, asRan } = runGraph({
      steps: [...ran("r1", [["fetch", "exec", "done"]]), ...ran("r1.1", [["implementer", "agent", "done"]], "ticket A")],
    });
    expect(asRan).toBe(true);
    expect(graph.items.map((p) => p.t)).toEqual(["start", "leaf", "box", "end"]);
    expect(graph.items[2]).toMatchObject({ title: "ticket A", status: "done" });
  });

  test("a step no node takes draws the steps as they ran, never a half-placed graph", () => {
    const { graph, asRan } = runGraph({
      flow: flow(step("sh", "tests")),
      steps: ran("r1", [["tests", "exec", "done"], ["deploy", "exec", "done"]]),
    });
    expect(asRan).toBe(true);
    expect(leaves(graph).map((l) => l.label)).toEqual(["tests", "deploy"]);
  });

  test("a nested run that its workflow's graph can't place shows as it ran, inside a graph that still fits", () => {
    const { graph, asRan } = runGraph({
      flow: flow(step("workflow", "child", { workflow: "child" })),
      flows: { child: flow(step("sh", "one")) },
      // An agent step can't take the place of a code step, even in order.
      steps: ran("r1.1", [["two", "agent", "done"]], "child"),
      nested: [{ id: "r1.1", parent: "r1", workflow: "child", label: "child" }],
    });
    expect(asRan).toBe(false);
    expect(leaves(boxes(graph)[0]).map((l) => l.label)).toEqual(["two"]);
  });
});

describe("keys", () => {
  test("every part of each state the kit shows has a key of its own, a loop's or a condition's body too", () => {
    for (const s of GRAPH_STATES) {
      const g = planOfState(s.props)!.graph;
      const keys: string[] = [];
      const visit = (x: Part) => {
        keys.push(x.key);
        kidsOf(x).forEach(visit);
      };
      visit(g);
      expect(keys.filter((k, i) => keys.indexOf(k) !== i), s.title).toEqual([]);
    }
  });
});

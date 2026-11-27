import { describe, expect, test } from "vitest";
import type { Flow, FlowNode, FlowStep } from "../src/api/contract.ts";
import { savedGraph } from "../src/graph/model.ts";
import type { Box, Iff, Leaf, Par, Part, Ret } from "../src/graph/tree.ts";

let n = 0;
const at = () => ({ id: `n${++n}`, line: n });
const step = (kind: FlowStep["kind"], label: string, more: Partial<FlowStep> = {}): FlowStep => ({ t: "step", ...at(), kind, label, ...more });
const flow = (...nodes: FlowNode[]): Flow => ({ nodes, notes: [] });
/** The parts between the start and the end mark. */
const inner = (f: Flow, flows?: Record<string, Flow>) => savedGraph(f, flows).items.slice(1, -1);

describe("the graph of a saved workflow", () => {
  test("starts with a start mark and ends with an end mark", () => {
    const g = savedGraph(flow(step("sh", "tests")));
    expect(g.items.map((p) => p.t)).toEqual(["start", "leaf", "end"]);
  });

  test("each kind of step is a node with its kind, the agent when it differs, and its retries", () => {
    const kinds: FlowStep["kind"][] = ["agent", "sh", "js", "py", "run", "wait", "ask", "breakpoint", "workflow", "choose"];
    const parts = inner(flow(...kinds.map((k) => step(k, `a ${k}`)), step("agent", "plan", { agent: "planner", retries: 2 }), step("agent", "reviewer", { agent: "reviewer" })));
    expect(parts.map((p) => (p as Leaf).kind)).toEqual([...kinds, "agent", "agent"]);
    const plan = parts[kinds.length] as Leaf;
    expect(plan).toMatchObject({ label: "plan", sub: "planner", retries: "↻ 2" });
    expect((parts[kinds.length + 1] as Leaf).sub).toBeUndefined();
  });

  test("an agent with no label takes its agent's name", () => {
    expect(inner(flow(step("agent", "agent", { agent: "triager" })))[0]).toMatchObject({ label: "triager" });
  });

  test("a label made at run time shows the name of its value, with the template in the tooltip", () => {
    const [a, b, c] = inner(flow(step("agent", "ticket {t.id}", { dynamic: true }), step("ask", "Build {list.length} tickets?", { dynamic: true }), step("sh", "{name}", { dynamic: true }))) as Leaf[];
    expect(a).toMatchObject({ label: "ticket id", tip: "ticket {t.id}" });
    expect(b.label).toBe("Build N tickets?");
    expect(c.label).toBe("name");
  });

  test("a loop is a box with its back arrow, and a counted for loop's back arrow gives its limit", () => {
    const [counted, byInput, each, again] = inner(
      flow(
        { t: "loop", ...at(), loop: "for", label: "round < 3", limit: "3", body: [step("agent", "reviewer")] },
        { t: "loop", ...at(), loop: "for", label: "i < args.tries", limit: "args.tries", body: [step("sh", "check")] },
        { t: "loop", ...at(), loop: "for", label: "tickets", body: [step("agent", "build")] },
        { t: "loop", ...at(), loop: "while", label: "!review.ok", body: [step("agent", "reviewer")] },
      ),
    ) as Box[];
    expect(counted).toMatchObject({ t: "box", kind: "loop", title: "for round < 3", again: "next ×3" });
    expect(byInput).toMatchObject({ title: "for i < args.tries", again: "next, up to args.tries" });
    expect(each).toMatchObject({ title: "for tickets", again: "next" });
    expect(again).toMatchObject({ title: "while !review.ok", again: "again" });
  });

  test("a loop's work that starts with if (feedback), where a later step keeps feedback, is the detour its back arrow comes into", () => {
    const [loop] = inner(flow({ t: "loop", ...at(), loop: "while", label: "!review.ok", body: [{ t: "if", ...at(), cond: "feedback", then: [step("agent", "address review")] }, step("agent", "reviewer", { result: "feedback" })] })) as Box[];
    expect(loop.body?.items[0]).toMatchObject({ t: "iff", onBack: true, label: "if feedback" });
  });

  test("a loop's work that starts with an if on a name no later step keeps is no detour", () => {
    const [before, notKept, inLater] = inner(
      flow(
        // The step that keeps the name runs before the loop.
        step("agent", "plan", { result: "dry" }),
        { t: "loop", ...at(), loop: "for", label: "tickets", body: [{ t: "if", ...at(), cond: "dry", then: [step("sh", "report")] }, step("agent", "build")] },
        { t: "loop", ...at(), loop: "while", label: "more", body: [{ t: "if", ...at(), cond: "dry", then: [step("sh", "report")] }, step("agent", "build", { result: "other" })] },
      ),
    ) as Box[];
    expect(before).toMatchObject({ t: "leaf", label: "plan" });
    for (const loop of [notKept, inLater]) {
      expect(loop.body?.items[0]).toMatchObject({ t: "iff", label: "if dry" });
      expect((loop.body?.items[0] as Iff).onBack).toBeUndefined();
    }
  });

  test("a detour's name may be kept by a step nested later in the loop's work", () => {
    const [loop] = inner(
      flow({
        t: "loop",
        ...at(),
        loop: "for",
        label: "round < 3",
        limit: "3",
        body: [{ t: "if", ...at(), cond: "review", then: [step("agent", "fix")] }, { t: "if", ...at(), cond: "args.strict", then: [step("agent", "reviewer", { result: "review" })] }],
      }),
    ) as Box[];
    expect(loop.body?.items[0]).toMatchObject({ t: "iff", onBack: true, label: "if review" });
  });

  test("a condition: an early return, a detour, a detour that ends, and an if with an else", () => {
    const parts = inner(
      flow(
        { t: "if", ...at(), cond: "!review.ok", then: [{ t: "end", ...at() }] },
        { t: "if", ...at(), cond: "args.lint", then: [step("sh", "lint")] },
        { t: "if", ...at(), cond: "dry", then: [step("sh", "report"), { t: "end", ...at() }] },
        { t: "if", ...at(), cond: "big", then: [step("agent", "split")], else: [step("agent", "build")] },
        { t: "if", ...at(), cond: "cached", then: [], else: [step("sh", "fetch")] },
        { t: "if", ...at(), cond: "error", then: [step("sh", "clean up")] },
      ),
    );
    expect(parts[0]).toMatchObject({ t: "ret", edge: "!review.ok", outcome: "ends", ok: "review.ok" } satisfies Partial<Ret>);
    expect(parts[1]).toMatchObject({ t: "iff", label: "if args.lint" } satisfies Partial<Iff>);
    expect((parts[1] as Iff).ends).toBeUndefined();
    expect(parts[2]).toMatchObject({ t: "iff", ends: true });
    expect(parts[3]).toMatchObject({ t: "par", conds: ["if big", "else"] } satisfies Partial<Par>);
    expect(parts[4]).toMatchObject({ t: "iff", label: "unless cached" });
    expect(parts[5]).toMatchObject({ t: "iff", label: "on error" });
  });

  test("parallel branches fork from one point, and an empty branch is left out", () => {
    const [par] = inner(flow({ t: "parallel", ...at(), branches: [[step("agent", "reviewer")], [], [step("agent", "security")]] })) as Par[];
    expect(par.t).toBe("par");
    expect(par.lanes.map((l) => (l.items[0] as Leaf).label)).toEqual(["reviewer", "security"]);
  });

  test("a pipeline is one stacked node named for what it runs over, folded when it has more than one step", () => {
    const [one, two] = inner(
      flow(
        { t: "pipeline", ...at(), over: "the chosen tickets", stages: [[step("workflow", "ticket", { workflow: "ticket" })]] },
        { t: "pipeline", ...at(), over: "packages", stages: [[step("agent", "upgrade {name}", { dynamic: true })], [step("sh", "test")]] },
      ),
    ) as Box[];
    expect(one).toMatchObject({ kind: "pipeline", title: "chosen tickets", stack: true, body: null });
    expect(one.tip).toBe("Pipeline over the chosen tickets, each runs the workflow ticket");
    expect(two).toMatchObject({ kind: "pipeline", title: "packages", foldable: true, folded: true });
    expect(two.body?.items).toHaveLength(2);
  });

  test("a breakpoint's step comes before the breakpoint", () => {
    const parts = inner(flow(step("breakpoint", "Notes look right?", { body: [step("agent", "draft")] })));
    expect(parts.map((p) => (p as Leaf).label)).toEqual(["draft", "Notes look right?"]);
  });

  test("a workflow step whose graph is known folds open to it, and stops at a loop of workflows", () => {
    const flows: Record<string, Flow> = {};
    flows.docs = flow(step("sh", "changes"), step("workflow", "again", { workflow: "docs" }));
    const [box] = inner(flow(step("workflow", "docs", { workflow: "docs" })), flows) as Box[];
    expect(box).toMatchObject({ t: "box", kind: "workflow", folded: true, foldable: true });
    expect(box.body?.items[1]).toMatchObject({ t: "leaf", label: "again" } satisfies Partial<Part>);
  });

  test("a return ends the parts: what follows it never runs", () => {
    const g = savedGraph(flow(step("sh", "a"), { t: "end", ...at() }, step("sh", "b")));
    expect(g.items.map((p) => p.t)).toEqual(["start", "leaf", "end"]);
  });
});

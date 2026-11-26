import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { Flow, FlowNode, FlowStep, Status, Step } from "../src/api/contract.ts";
import { FlowGraph } from "../src/graph/flow-graph.tsx";
import { GRAPH_STATES, planOfState } from "../src/kit/fixtures.ts";
import { planOf } from "../src/plan/plan.ts";

let n = 0;
const at = () => ({ id: `n${++n}`, line: n });
const step = (kind: FlowStep["kind"], label: string, more: Partial<FlowStep> = {}): FlowStep => ({ t: "step", ...at(), kind, label, ...more });
const flow = (...nodes: FlowNode[]): Flow => ({ nodes, notes: [] });
const ran = (label: string, kind: Step["kind"], status: Step["status"], i: number): Step => ({
  key: `r1:${i}`,
  label,
  name: label,
  scope: "r1",
  call: 1,
  kind,
  status,
  startedAt: "2026-11-25T10:00:00Z",
  durationMs: 4000,
});

/** The graph of a saved workflow, as its page draws it. */
const Saved = ({ text, flows, ...rest }: { text: Flow; flows?: Record<string, Flow>; selected?: string; onSelect?: (key: string) => void; label?: string }) => (
  <FlowGraph plan={planOf(text, flows)} flow={text} {...rest} />
);
/** The graph of a run, as its page draws it. */
const Ran = ({ text, steps, status, ...rest }: { text?: Flow; steps: Step[]; status: Status; onSelect?: (key: string) => void }) => (
  <FlowGraph plan={planOf(text, undefined, { steps, status, nested: [], questions: [] })} flow={text} run {...rest} />
);

const migrate = flow(step("sh", "inventory"), step("agent", "migrate", { agent: "implementer" }), step("sh", "tests"));
const migrateRun = [ran("inventory", "exec", "done", 1), ran("migrate", "agent", "failed", 2)];

/** The node elements, in the order Tab reaches them. */
async function tabToAll(count: number) {
  const seen: HTMLElement[] = [];
  for (let i = 0; i < count + 8; i++) {
    await userEvent.tab();
    const el = document.activeElement as HTMLElement;
    if (el.dataset.gnode) seen.push(el);
  }
  return seen;
}

describe("the drawing of a graph", () => {
  test("a named region that scrolls sideways, with the steps in order for a screen reader", () => {
    render(<Saved text={migrate} label="Graph of migrate" />);
    const region = screen.getByRole("region", { name: "Graph of migrate" });
    expect(region).toHaveAttribute("data-scroll-x");
    expect(region).toHaveAttribute("tabindex", "0");
    const outline = screen.getByRole("list", { name: "The graph's steps, in order" });
    expect(within(outline).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["inventory, sh", "migrate implementer, agent", "tests, sh", "The workflow ends."]);
  });

  test("Tab reaches every node of a run, and Enter or a click selects it", async () => {
    const open = vi.fn();
    render(<Ran text={migrate} steps={migrateRun} status="failed" onSelect={open} />);
    const nodes = await tabToAll(3);
    expect(nodes.map((el) => el.getAttribute("aria-label"))).toEqual(["inventory 4s, done", "migrate 4s, failed", "tests, skipped"]);
    const inventory = screen.getByRole("button", { name: "inventory 4s, done" });
    inventory.focus();
    await userEvent.keyboard("{Enter}");
    expect(open).toHaveBeenLastCalledWith(`/${migrate.nodes[0].id}`);
    await userEvent.click(screen.getByRole("button", { name: "migrate 4s, failed" }));
    expect(open).toHaveBeenLastCalledWith(`/${migrate.nodes[1].id}`);
    expect(open).toHaveBeenCalledTimes(2);
  });

  test("a node that never ran selects too, so its panel says what it would do", async () => {
    const open = vi.fn();
    render(<Ran text={migrate} steps={migrateRun} status="failed" onSelect={open} />);
    await userEvent.click(screen.getByRole("button", { name: "tests, skipped" }));
    expect(open).toHaveBeenCalledWith(`/${migrate.nodes[2].id}`);
  });

  test("the selected node of a saved workflow is marked current", async () => {
    const f = flow(step("sh", "tests"), step("sh", "lint"));
    render(<Saved text={f} selected={`/${f.nodes[1].id}`} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "lint, sh" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "tests, sh" })).not.toHaveAttribute("aria-current");
  });

  test("a folded box opens to its steps and folds back, and focus follows", async () => {
    const docs = flow(step("sh", "changes"), step("agent", "update docs"));
    render(<Saved text={flow(step("sh", "log"), step("workflow", "docs", { workflow: "docs-sync" }))} flows={{ "docs-sync": docs }} />);
    expect(screen.queryByText("update docs", { selector: "[data-gnode] *" })).toBeNull();
    const box = screen.getByRole("button", { name: "docs docs-sync, workflow" });
    expect(box).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(box);
    const fold = screen.getByRole("button", { name: "Fold docs" });
    expect(fold).toHaveFocus();
    expect(screen.getByRole("group", { name: "update docs, agent" })).toBeInTheDocument();
    await userEvent.click(fold);
    expect(screen.getByRole("button", { name: "docs docs-sync, workflow" })).toHaveFocus();
  });

  test("Tab reaches an open box's fold button where the box starts, between the nodes", async () => {
    const docs = flow(step("sh", "changes"));
    render(<Saved text={flow(step("sh", "log"), step("workflow", "docs", { workflow: "docs-sync" }), step("sh", "post"))} flows={{ "docs-sync": docs }} />);
    await userEvent.click(screen.getByRole("button", { name: "docs docs-sync, workflow" }));
    screen.getByRole("region").focus();
    const order: Array<Element | null> = [];
    for (let i = 0; i < 4; i++) {
      await userEvent.tab();
      order.push(document.activeElement);
    }
    expect(order).toEqual([
      screen.getByRole("group", { name: "log, sh" }),
      screen.getByRole("button", { name: "Fold docs" }),
      screen.getByRole("group", { name: "changes, sh" }),
      screen.getByRole("group", { name: "post, sh" }),
    ]);
  });

  test("a run with no step yet, and a workflow with none, each say so", () => {
    const { rerender } = render(<FlowGraph plan={planOf(undefined, undefined, { steps: [] })} run />);
    expect(screen.getByText("No step has started yet.")).toBeInTheDocument();
    rerender(<FlowGraph plan={planOf(undefined, undefined)} />);
    expect(screen.getByText("This workflow has no steps.")).toBeInTheDocument();
  });

  test("a run whose steps match no node draws them as they ran, and says so", () => {
    render(<Ran text={migrate} steps={[ran("deploy", "exec", "done", 1)]} status="done" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "deploy 4s, done" })).toBeInTheDocument();
    expect(screen.getByText("Some steps of this run match no step of the text, so the graph shows the steps as they ran.")).toBeInTheDocument();
  });

  test("every state of the kit draws with no error from React, such as two parts with one key", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const s of GRAPH_STATES) render(<FlowGraph plan={planOfState(s.props)} flow={s.props.flow} run={!!s.props.steps} label={s.title} onSelect={() => {}} />);
    expect(error.mock.calls.map((c) => String(c[0]).slice(0, 120))).toEqual([]);
    error.mockRestore();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { WorkflowDiff } from "../src/api/contract.ts";
import { DiffView } from "../src/ui/diff-view.tsx";

const same = (n: number) => Array.from({ length: n }, (_, i) => ({ op: " " as const, text: `line ${i + 1}` }));

describe("diff view", () => {
  test("marks added and removed lines, and counts them", () => {
    const diff: WorkflowDiff = { isNew: false, lines: [...same(2), { op: "-", text: "default: 2" }, { op: "+", text: "default: 3" }, ...same(1)] };
    const { container } = render(<DiffView diff={diff} path="ticket.js" />);
    expect(screen.getByText("1 added, 1 removed")).toBeInTheDocument();
    expect(container.querySelector("[data-op='removed']")).toHaveTextContent("Removed: default: 2");
    expect(container.querySelector("[data-op='added']")).toHaveTextContent("Added: default: 3");
    expect(container.querySelectorAll("[data-op='same']")).toHaveLength(3);
  });

  test("folds a long run of unchanged lines into a row that opens", async () => {
    const diff: WorkflowDiff = { isNew: false, lines: [...same(10), { op: "+", text: "await sh(\"pnpm lint\")" }] };
    const { container } = render(<DiffView diff={diff} />);
    expect(container.querySelectorAll("[data-op='same']")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "7 lines without changes" }));
    expect(container.querySelectorAll("[data-op='same']")).toHaveLength(10);
  });

  test("a new file says so, and a cut diff says where it stops", () => {
    render(<DiffView diff={{ isNew: true, cut: true, lines: [{ op: "+", text: "return 1" }] }} />);
    expect(screen.getByText(/You never approved this file/)).toHaveTextContent("The diff stops at 200 lines.");
  });
});

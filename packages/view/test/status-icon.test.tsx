import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { STATUS_LABEL, StatusIcon, type Status } from "../src/ui/status-icon.tsx";

describe("status icons", () => {
  test("each status has a name a screen reader reads", () => {
    for (const status of Object.keys(STATUS_LABEL) as Status[]) render(<StatusIcon status={status} />);
    for (const label of Object.values(STATUS_LABEL)) expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
  });

  test("hides from screen readers when the text beside it says the same", () => {
    const { container } = render(<StatusIcon status="done" label={false} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  test("only running turns", () => {
    const { container } = render(
      <>
        <StatusIcon status="running" />
        <StatusIcon status="needs" />
      </>,
    );
    const [running, needs] = container.querySelectorAll("svg");
    expect(running?.getAttribute("class")).toMatch(/\bspin\b/);
    expect(needs?.getAttribute("class")).not.toMatch(/\bspin\b/);
  });

  test("draws its new shape only when its status changes while it shows, never on load", () => {
    const { container, rerender } = render(<StatusIcon status="running" />);
    expect(container.querySelector("svg")).not.toHaveClass("status-in");
    rerender(<StatusIcon status="done" />);
    expect(container.querySelector("svg")).toHaveClass("status-in");
    expect(container.querySelector("svg")).toHaveAttribute("data-status", "done");
  });
});

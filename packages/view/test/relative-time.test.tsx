import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { formatFull } from "../src/format.ts";
import { RelativeTime } from "../src/ui/relative-time.tsx";

const NOW = Date.UTC(2026, 10, 25, 15, 0, 0);

afterEach(() => vi.useRealTimers());

describe("relative time", () => {
  test("reads in words, with the exact time in the element and its tooltip", () => {
    const at = NOW - 3 * 60_000;
    const { container } = render(<RelativeTime at={new Date(at).toISOString()} now={NOW} />);
    const time = container.querySelector("time")!;
    expect(time).toHaveTextContent("3m ago");
    expect(time).toHaveAttribute("dateTime", new Date(at).toISOString());
    expect(screen.getByText(formatFull(at))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3m ago" })).toHaveAccessibleDescription(formatFull(at));
  });

  test("moves on as the clock does", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<RelativeTime at={NOW - 60_000} />);
    expect(screen.getByText("1m ago")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(screen.getByText("3m ago")).toBeInTheDocument();
  });

  test("a date it can't read shows nothing", () => {
    const { container } = render(<RelativeTime at="not a date" />);
    expect(container).toBeEmptyDOMElement();
  });
});

import { toast as sdkToast } from "@ui-sdk/react/toast";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SousError } from "../src/api/client.ts";
import { removeLater, useHiddenRuns } from "../src/lists/removals.ts";
import { Toasts } from "../src/ui/toast.tsx";

/** The ids the list hides now, as a line of text. */
function Hidden() {
  return <p data-testid="hidden">{[...useHiddenRuns()].join(",")}</p>;
}

const hidden = () => (screen.getByTestId("hidden").textContent ?? "").split(",");
const undo = () => act(() => screen.getByRole("button", { name: "Undo" }).click());

let n = 0;
/** A run id no earlier test used, since the store lives as long as the page. */
const fresh = () => `r-${++n}`;

beforeEach(() => {
  vi.useFakeTimers();
  render(
    <>
      <Hidden />
      <Toasts />
    </>,
  );
});

afterEach(() => {
  act(() => sdkToast.dismiss());
  vi.useRealTimers();
});

describe("removing a run", () => {
  test("hides the row at once and sends the delete only after 8 seconds", async () => {
    const id = fresh();
    const send = vi.fn(() => Promise.resolve({}));
    act(() => removeLater({ id, title: "fanout" }, send));
    expect(hidden()).toContain(id);
    expect(screen.getByText("Removed fanout")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(7_900));
    expect(send).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(200));
    expect(send).toHaveBeenCalledExactlyOnceWith(id);
    expect(hidden()).toContain(id);
  });

  test("Undo brings the row back and sends nothing, then or later", () => {
    const id = fresh();
    const send = vi.fn(() => Promise.resolve({}));
    act(() => removeLater({ id, title: "slow" }, send));
    act(() => vi.advanceTimersByTime(3_000));
    undo();
    expect(hidden()).not.toContain(id);
    act(() => vi.advanceTimersByTime(20_000));
    expect(send).not.toHaveBeenCalled();
  });

  test("a second press on the same run starts no second timer", async () => {
    const id = fresh();
    const send = vi.fn(() => Promise.resolve({}));
    act(() => {
      removeLater({ id, title: "fanout" }, send);
      removeLater({ id, title: "fanout" }, send);
    });
    await act(async () => vi.advanceTimersByTime(8_100));
    expect(send).toHaveBeenCalledOnce();
  });

  test("a delete that fails brings the row back and says why, with the call to make", async () => {
    const id = fresh();
    const send = vi.fn(() => Promise.reject(new SousError({ code: "still_running", message: "The run is still running.", change: "Stop it first.", call: `sous stop ${id}` }, 409)));
    act(() => removeLater({ id, title: "fanout" }, send));
    await act(async () => vi.advanceTimersByTime(8_100));
    expect(hidden()).not.toContain(id);
    expect(screen.getByText("Couldn't remove fanout. The run is still running.")).toBeInTheDocument();
    expect(screen.getByText(`sous stop ${id}`)).toBeInTheDocument();
  });
});

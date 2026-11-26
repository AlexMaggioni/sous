import { toast as sdkToast } from "@ui-sdk/react/toast";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { toast, Toasts } from "../src/ui/toast.tsx";

afterEach(() => {
  act(() => sdkToast.dismiss());
  vi.useRealTimers();
});

describe("toasts", () => {
  test("Undo runs the undo and closes the toast", async () => {
    const undo = vi.fn();
    render(<Toasts />);
    act(() => void toast("Removed r-2c8f1d", { undo }));
    expect(await screen.findByText("Removed r-2c8f1d")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(screen.queryByText("Removed r-2c8f1d")).toBeNull());
  });

  test("shows the sous command beside the message", async () => {
    render(<Toasts />);
    act(() => void toast("Stopped r-2c8f1d", { command: "sous stop r-2c8f1d" }));
    expect(await screen.findByText("sous stop r-2c8f1d")).toBeInTheDocument();
  });

  test("the timer ends a toast: 5 seconds, or 8 with an Undo", () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() => {
      toast("Answer sent");
      toast("Removed r-2c8f1d", { undo: () => {} });
    });
    expect(screen.getByText("Answer sent")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5_100));
    expect(screen.queryByText("Answer sent")).toBeNull();
    expect(screen.getByText("Removed r-2c8f1d")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.queryByText("Removed r-2c8f1d")).toBeNull();
  });

  test("two toasts with the same words and different ids both keep their Undo", async () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<Toasts />);
    act(() => {
      toast("Removed slow", { id: "removed:r-1", undo: first });
      toast("Removed slow", { id: "removed:r-2", undo: second });
    });
    await vi.waitFor(() => expect(screen.getAllByText("Removed slow")).toHaveLength(2));
    const undos = screen.getAllByRole("button", { name: "Undo" });
    expect(undos).toHaveLength(2);
    for (const undo of undos) await userEvent.click(undo);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});

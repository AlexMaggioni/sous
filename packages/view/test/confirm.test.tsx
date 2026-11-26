import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { confirm, ConfirmHost } from "../src/ui/confirm.tsx";

const PATH = "/Users/maya/code/billing/.sous/workflows/ticket.js";

describe("confirm", () => {
  test("names the thing and its path, and Cancel runs nothing", async () => {
    const run = vi.fn(async () => {});
    render(<ConfirmHost />);
    let answer: Promise<boolean> | undefined;
    act(() => void (answer = confirm({ title: "Remove ticket.js?", body: "sous deletes the workflow file.", path: PATH, confirmLabel: "Remove", danger: true, run })));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove ticket.js?" });
    expect(dialog).toHaveTextContent(PATH);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  test("the confirm button runs the work once and resolves true", async () => {
    const run = vi.fn(async () => {});
    render(<ConfirmHost />);
    let answer: Promise<boolean> | undefined;
    act(() => void (answer = confirm({ title: "Stop r-2c8f1d?", body: "The run stops.", confirmLabel: "Stop the run", run })));
    await userEvent.click(await screen.findByRole("button", { name: "Stop the run" }));
    await expect(answer).resolves.toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });
});

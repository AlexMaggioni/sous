import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SousError } from "../src/api/client.ts";
import { Refusal } from "../src/ui/refusal.tsx";

describe("refusal", () => {
  test("shows what happened, what to change, and the call to make with a copy button", () => {
    const error = new SousError({ code: "run_ended", message: "The run already ended.", change: "Rerun it to start again.", call: "sous rerun r-2c8f1d" }, 409);
    render(<Refusal error={error} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The run already ended.");
    expect(screen.getByText("Rerun it to start again.")).toBeInTheDocument();
    expect(screen.getByText("sous rerun r-2c8f1d").tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: "Copy the call" })).toBeInTheDocument();
  });

  test("takes an error body as the API sends it", () => {
    render(<Refusal error={{ code: "not_approved", message: "ticket.js changed since you approved it.", change: "Approve the changes to start.", call: "sous workflows approve ticket" }} />);
    expect(screen.getByText("Approve the changes to start.")).toBeInTheDocument();
    expect(screen.getByText("sous workflows approve ticket")).toBeInTheDocument();
  });

  test("a plain error keeps its message, says to reload, and offers no call", () => {
    render(<Refusal error={new Error("Failed to fetch")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to fetch");
    expect(screen.getByText("Reload the page to try again.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("a refusal that offers more than one call lists each with what it does, in order", () => {
    const next = [
      { call: "sous answer q1 postgres", does: "Answer with the first choice" },
      { call: "sous answer q1 sqlite", does: "Answer with the second choice" },
    ];
    const error = new SousError({ code: "not_a_choice", message: "mysql is not one of the choices.", change: "Answer with one of the choices.", call: next[0]!.call, next }, 400);
    render(<Refusal error={error} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("sous answer q1 postgres").tagName).toBe("CODE");
    expect(items[0]).toHaveTextContent("Answer with the first choice");
    expect(within(items[1]!).getByText("sous answer q1 sqlite").tagName).toBe("CODE");
    expect(items[1]).toHaveTextContent("Answer with the second choice");
    expect(screen.getAllByRole("button", { name: "Copy the call" })).toHaveLength(2);
  });
});

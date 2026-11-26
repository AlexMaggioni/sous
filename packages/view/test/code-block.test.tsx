import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { CodeBlock } from "../src/ui/code-block.tsx";

describe("code block", () => {
  test("shows plain text at once, then the highlighted text once shiki loads", async () => {
    const { container } = render(<CodeBlock code={"const total = 1 // once\n"} path="total.ts" />);
    const lines = () => container.querySelector("[data-slot='scroll-area-content'] > div")!;
    expect(lines()).not.toHaveAttribute("data-highlighted");
    expect(lines()).toHaveTextContent("const total = 1 // once");
    expect(screen.getByText("1 line")).toBeInTheDocument();

    await waitFor(() => expect(lines()).toHaveAttribute("data-highlighted"), { timeout: 10_000 });
    expect(lines()).toHaveTextContent("const total = 1 // once");
    const keyword = [...container.querySelectorAll("span[style]")].find((s) => s.textContent === "const");
    expect(keyword).toHaveClass("font-medium");
    const comment = [...container.querySelectorAll("span[style]")].find((s) => s.textContent?.includes("// once"));
    expect(comment).toHaveClass("italic");
  });

  test("a language shiki doesn't know stays plain", () => {
    const { container } = render(<CodeBlock code="all: build" path="Makefile" />);
    expect(container.querySelector("[data-highlighted]")).toBeNull();
    expect(screen.getByText("all: build")).toBeInTheDocument();
  });
});

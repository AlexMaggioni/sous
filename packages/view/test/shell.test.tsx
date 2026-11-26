import { toast as sdkToast } from "@ui-sdk/react/toast";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Overview, Question, RunRow, WorkflowRow } from "../src/api/contract.ts";
import { LOST_AFTER_MS } from "../src/api/live.ts";
import { SectionHome } from "../src/pages/section-home.tsx";
import { tabTitle } from "../src/shell/link-state.ts";
import { setListQuery } from "../src/shell/prefs.ts";
import { SECTIONS } from "../src/sections.ts";
import { Shell } from "../src/shell/shell.tsx";
import { Overlays } from "../src/ui/overlays.tsx";

const SHOP = { dir: "/work/shop", name: "shop" };
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const run = (id: string, minutes: number, more: Partial<RunRow> = {}): RunRow => ({
  id,
  workflow: id,
  title: id,
  project: SHOP,
  status: "done",
  statusText: "Done",
  startedAt: at(minutes),
  endedAt: at(minutes - 1),
  tokens: 0,
  waiting: 0,
  origin: "cli",
  ...more,
});

const RUNS = [run("review", 5, { status: "needs", statusText: "Needs you", waiting: 1, endedAt: undefined }), run("fanout", 9), run("slow", 12)];
const overview = (needsYou: number): Overview => ({ home: "/tmp/home/.sous", project: SHOP, projects: [SHOP], service: { running: true }, needsYou, version: "0.1.0" });
const question: Question = { id: "q1", runId: "review", scope: "review", workflow: "review", prompt: "Approve the release notes", kind: "confirm", breakpoint: true, answeredBy: "people", askedAt: at(4) };
const workflows: WorkflowRow[] = [{ name: "review", file: "/work/shop/.sous/workflows/review.js", from: "project", changed: false, problems: 0, startedBy: "anyone" }];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stand-in for `sous serve` over a mocked fetch. It keeps each DELETE it gets. */
function serve(needsYou = 1) {
  const deletes: string[] = [];
  const answers: Record<string, unknown> = { overview: overview(needsYou), runs: RUNS, questions: [question], workflows, agents: [], skills: [], mcp: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://view.test");
      if (init?.method === "DELETE") {
        deletes.push(url.pathname);
        return json({ removed: true });
      }
      const word = url.pathname.replace(/^\/api\//, "");
      return word in answers ? json(answers[word]) : json({ error: { code: "not_found", message: "No such page.", change: "", call: null } }, 404);
    }),
  );
  return { deletes };
}

/** The browser's EventSource, held by the test, which says when the link opens or fails. */
class FakeSource {
  static all: FakeSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
  static latest(): FakeSource {
    const open = FakeSource.all.filter((s) => !s.closed);
    return open[open.length - 1] as FakeSource;
  }
}

/** The shell under a router like the app's, starting at `path`. */
function open(path = "/runs") {
  const root = createRootRoute({ component: Shell });
  const home = (p: "/runs" | "/workflows" | "/agents" | "/skills" | "/mcp") => createRoute({ getParentRoute: () => root, path: p, component: SectionHome });
  const stub = (p: string, text: string) => createRoute({ getParentRoute: () => root, path: p, component: () => <h1>{text}</h1> });
  const tree = root.addChildren([
    home("/runs"),
    home("/workflows"),
    home("/agents"),
    home("/skills"),
    home("/mcp"),
    stub("/runs/$runId", "A run"),
    stub("/workflows/$name", "A workflow"),
    stub("/agents/$name", "An agent"),
    stub("/skills/$name", "A skill"),
    stub("/mcp/$name", "An MCP server"),
    stub("/settings", "Settings"),
  ]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <Overlays />
    </QueryClientProvider>,
  );
  return router;
}

const loaded = () => screen.findByRole("heading", { level: 2, name: /^Needs you/ });
const list = () => document.getElementById("list-body") as HTMLElement;

beforeEach(() => {
  // The search text lasts the visit, so a test starts each list unfiltered.
  for (const section of SECTIONS) setListQuery(section.id, "");
  FakeSource.all = [];
  vi.stubGlobal("EventSource", FakeSource);
});

afterEach(() => {
  act(() => sdkToast.dismiss());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the rail badge", () => {
  test("counts the runs that need the person, on Runs and in the tab title", async () => {
    serve(2);
    open();
    const runs = await screen.findByRole("link", { name: "Runs, 2 need you" });
    expect(within(runs).getByText("2")).toBeInTheDocument();
    expect(document.title).toBe("(2) sous");
  });

  test("says one run in the singular, and shows nothing when no run waits", () => {
    expect(tabTitle(1)).toBe("(1) sous");
    expect(tabTitle(0)).toBe("sous");
  });

  test("shows no badge when nothing waits", async () => {
    serve(0);
    open();
    await loaded();
    expect(screen.getByRole("link", { name: "Runs" })).toBeInTheDocument();
    expect(document.title).toBe("sous");
  });
});

describe("the link to sous serve", () => {
  test("says when it is lost, after a moment's grace, and when it is back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve();
    open();
    await loaded();
    act(() => FakeSource.latest().onopen?.());

    act(() => FakeSource.latest().onerror?.());
    act(() => vi.advanceTimersByTime(LOST_AFTER_MS - 100));
    expect(screen.queryByText(/lost its link to sous serve/)).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText(/The page lost its link to sous serve and is trying again/)).toBeInTheDocument();

    // While lost, a new link every 5 seconds. The one that opens ends the bar.
    const first = FakeSource.latest();
    act(() => vi.advanceTimersByTime(5_000));
    expect(first.closed).toBe(true);
    act(() => FakeSource.latest().onopen?.());
    expect(screen.queryByText(/lost its link/)).toBeNull();
    expect(screen.getByText(/Connected to sous serve again/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4_100));
    expect(screen.queryByText(/Connected to sous serve again/)).toBeNull();
  });

  test("says nothing when the browser links again within the server's 2 second retry, and reads everything again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve();
    open();
    await loaded();
    act(() => FakeSource.latest().onopen?.());
    // The grace outlasts the wait the server asks of the browser before it tries again.
    expect(LOST_AFTER_MS).toBeGreaterThan(2_000);

    act(() => FakeSource.latest().onerror?.());
    act(() => vi.advanceTimersByTime(2_000));
    const before = vi.mocked(fetch).mock.calls.length;
    act(() => FakeSource.latest().onopen?.());
    act(() => vi.advanceTimersByTime(LOST_AFTER_MS));
    expect(screen.queryByText(/lost its link/)).toBeNull();
    expect(screen.queryByText(/Connected to sous serve again/)).toBeNull();
    // The page may have missed changes while the link was down.
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(before));
  });

  test("stands in for the whole page with the command to run when sous serve doesn't answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    open();
    expect(await screen.findByRole("heading", { level: 1, name: "The page can't reach sous serve" })).toBeInTheDocument();
    expect(screen.getByText("sous serve")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
  });
});

describe("the keys", () => {
  test("g then w goes to workflows, and j, k and Enter open a row", async () => {
    serve();
    const router = open();
    await loaded();
    const user = userEvent.setup();

    await user.keyboard("jj");
    expect(document.activeElement?.textContent).toMatch(/^fanout/);
    await user.keyboard("k{Enter}");
    expect(router.state.location.pathname).toBe("/runs/review");

    (document.activeElement as HTMLElement).blur();
    await user.keyboard("gw");
    expect(router.state.location.pathname).toBe("/workflows");
  });

  test("letters and ? do nothing while the person types in the search", async () => {
    serve();
    const router = open();
    await loaded();
    const user = userEvent.setup();

    await user.keyboard("/");
    const search = screen.getByRole("searchbox", { name: "Search runs" });
    expect(search).toHaveFocus();
    await user.keyboard("gw?jk");
    expect(search).toHaveValue("gw?jk");
    expect(router.state.location.pathname).toBe("/runs");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  test("the search filters the list, and Escape clears it", async () => {
    serve();
    open();
    await loaded();
    const user = userEvent.setup();

    await user.keyboard("/fan");
    expect(within(list()).getAllByRole("link").map((a) => a.textContent)).toEqual([expect.stringMatching(/^fanout/)]);
    await user.keyboard("{Escape}");
    expect(within(list()).getAllByRole("link")).toHaveLength(3);
  });

  test("? shows the shortcuts and ⌘K opens the jump menu, from the search too", async () => {
    serve();
    open();
    await loaded();
    const user = userEvent.setup();

    await user.keyboard("?");
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("searchbox", { name: "Search runs" }));
    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByPlaceholderText(/Jump to a run/)).toBeInTheDocument();
  });
});

describe("removing a run from the list", () => {
  test("the row goes at once, and the delete goes out only after Undo had 8 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { deletes } = serve();
    open();
    await loaded();

    act(() => screen.getByRole("button", { name: "Remove fanout" }).click());
    expect(within(list()).queryByText("fanout")).toBeNull();
    expect(screen.getByText("Removed fanout")).toBeInTheDocument();
    expect(deletes).toEqual([]);

    await act(async () => vi.advanceTimersByTime(8_100));
    expect(deletes).toEqual(["/api/runs/fanout"]);
  });

  test("a run that has not ended has no x", async () => {
    serve();
    open();
    await loaded();
    expect(screen.queryByRole("button", { name: "Remove review" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove slow" })).toBeInTheDocument();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Activity, ApiError, Flow, Question, RunPage, Step, StepDetail } from "../src/api/contract.ts";
import { RunDetail } from "../src/pages/run/run-detail.tsx";
import { COLUMN_ID } from "../src/shell/list-nav.ts";
import { SidebarContext } from "../src/shell/use-sidebar.ts";
import { Overlays } from "../src/ui/overlays.tsx";

const T0 = Date.now() - 120_000;
const iso = (ms: number) => new Date(T0 + ms).toISOString();

const flow: Flow = {
  nodes: [
    { t: "step", id: "a", line: 1, kind: "sh", label: "build" },
    { t: "step", id: "b", line: 2, kind: "sh", label: "test" },
  ],
  notes: [],
};
const step = (i: number, label: string, more: Partial<Step> = {}): Step => ({
  key: `r1:${i}`,
  label,
  name: label,
  scope: "r1",
  call: 1,
  kind: "exec",
  status: "done",
  startedAt: iso(i * 1000),
  endedAt: iso(i * 1000 + 800),
  durationMs: 800,
  ...more,
});
const CAN = { stop: false, pause: false, resume: false, resumeChoice: false, rerun: true, remove: true };

/** The parser run, paused where its test step failed, unless `more` says otherwise. */
function runPage(more: Partial<RunPage> = {}): RunPage {
  return {
    id: "r1",
    workflow: "build",
    title: "Ship the parser",
    project: { dir: "/tmp/parser", name: "parser" },
    status: "paused",
    statusText: "Paused, a step failed",
    startedAt: iso(0),
    changedAt: iso(3000),
    tokens: 0,
    waiting: 0,
    origin: "cli",
    cwd: "/tmp/parser",
    place: "folder",
    args: {},
    pauseReason: "step_failed",
    questions: [],
    steps: [step(1, "build"), step(2, "test", { status: "failed", error: "2 tests failed" })],
    nested: [],
    flow,
    flows: {},
    can: { ...CAN, resume: true },
    ...more,
  };
}

const detail = (name: string, more: Partial<StepDetail> = {}): StepDetail => ({ name, scope: "r1", call: 1, calls: 1, kind: "exec", status: "done", command: `npm run ${name}`, output: "ok", activity: [], ...more });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, message: string): { error: ApiError } => ({ error: { code, message, change: "Run sous list to see the runs.", call: "sous list" } });

/**
 * A stand-in for `sous serve` over a mocked fetch. It answers the run and step reads from the
 * fixtures and keeps the words of each `/api/call`. `replies` gives a command's data by its verb.
 */
function serve(runs: RunPage[], steps: StepDetail[] = [], replies: Record<string, Record<string, unknown>> = {}) {
  const calls: string[][] = [];
  const reads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://view.test");
      if (url.pathname === "/api/call") {
        const { argv } = JSON.parse(String(init?.body)) as { argv: string[] };
        calls.push(argv);
        return json({ ok: true, data: replies[argv[0]!] ?? {}, notes: [], next: [] });
      }
      reads.push(url.pathname + url.search);
      const [, id, rest] = url.pathname.match(/^\/api\/runs\/([^/]+)(\/step)?$/) ?? [];
      const run = runs.find((r) => r.id === decodeURIComponent(id ?? ""));
      if (!run) return json(refusal("no_such_run", `No run ${id}.`), 404);
      if (!rest) return json(run);
      const found = steps.find((s) => s.name === url.searchParams.get("name"));
      return found ? json(found) : json(refusal("no_such_step", "No such step."), 404);
    }),
  );
  return { calls, reads };
}

const sidebar = { open: true, overlay: false, toggle() {}, show() {}, close() {} };

/** The run page under a router like the app's, at `path`, with the toasts and the confirm host. */
function open(path: string) {
  const root = createRootRoute({
    component: () => (
      <SidebarContext.Provider value={sidebar}>
        <Outlet />
      </SidebarContext.Provider>
    ),
  });
  const runs = createRoute({ getParentRoute: () => root, path: "/runs", component: () => <p>Every run</p> });
  const run = createRoute({
    getParentRoute: () => root,
    path: "/runs/$runId",
    validateSearch: (search: Record<string, unknown>) => ({
      view: search.view === "steps" ? ("steps" as const) : undefined,
      step: typeof search.step === "string" ? search.step : undefined,
    }),
    component: RunDetail,
  });
  const workflow = createRoute({ getParentRoute: () => root, path: "/workflows/$name", component: () => null });
  const router = createRouter({ routeTree: root.addChildren([runs, run, workflow]), history: createMemoryHistory({ initialEntries: [path] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <Overlays />
    </QueryClientProvider>,
  );
  return router;
}

const loaded = () => screen.findByRole("heading", { level: 1, name: "Ship the parser" });
const rowOf = (key: string) => document.getElementById(`plan-row-${key.replace(/[^\w-]/g, "_")}`) as HTMLElement;

// jsdom has no scrollIntoView. The Steps view scrolls a step opened from elsewhere into view.
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the header", () => {
  test("Resume is the primary while the run is paused, and it sends sous resume", async () => {
    const { calls } = serve([runPage()]);
    open("/runs/r1");
    await loaded();
    const resume = screen.getByRole("button", { name: "Resume" });
    expect(resume).toHaveAttribute("data-variant", "primary");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await userEvent.click(resume);
    await waitFor(() => expect(calls).toEqual([["resume", "r1"]]));
  });

  test("Stop is a quiet button while the run runs, and a stopping run says so in a toast", async () => {
    const running = runPage({ status: "running", statusText: "Running", pauseReason: undefined, steps: [step(1, "build", { status: "running", endedAt: undefined, durationMs: undefined })], can: { ...CAN, stop: true, pause: true, remove: false } });
    const { calls } = serve([running], [], { stop: { outcome: "stopping" } });
    open("/runs/r1");
    await loaded();
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toHaveAttribute("data-variant", "quiet");
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    await userEvent.click(stop);
    await waitFor(() => expect(calls).toEqual([["stop", "r1"]]));
    expect(await screen.findByText("Stopping r1")).toBeInTheDocument();
  });

  test("a changed workflow asks which text to resume with", async () => {
    const { calls } = serve([runPage({ can: { ...CAN, resume: true, resumeChoice: true } })]);
    open("/runs/r1");
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    await userEvent.click(await screen.findByRole("button", { name: "Resume with the latest" }));
    await waitFor(() => expect(calls).toEqual([["resume", "r1", "--latest"]]));
  });

  test("a run that is not there says so and links back to the runs", async () => {
    serve([]);
    open("/runs/nope");
    expect(await screen.findByRole("heading", { level: 1, name: "Run not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to runs" })).toHaveAttribute("href", "/runs");
  });
});

describe("links from a run", () => {
  test("its workflow opens as seen from the run's project, not the one the lists are seen from", async () => {
    serve([runPage()]);
    open("/runs/r1");
    await loaded();
    expect(screen.getByRole("link", { name: "build" })).toHaveAttribute("href", "/workflows/build?project=%2Ftmp%2Fparser");
  });
});

describe("what needs you", () => {
  const ask = (id: string, prompt: string, kind: Question["kind"], more: Partial<Question> = {}): Question => ({ id, runId: "r1", scope: "r1", workflow: "build", prompt, kind, breakpoint: false, answeredBy: "anyone", askedAt: iso(Number(id.slice(1)) * 1000), ...more });
  const BREAKPOINT = "Breakpoint: Approve the notes\n\nv1.2 starts faster.\n\nReply approve, stop, or send back with a note.";
  const asking = runPage({
    status: "needs",
    statusText: "Needs you",
    pauseReason: undefined,
    can: CAN,
    questions: [
      ask("q1", "Ship it?", "confirm"),
      ask("q2", "Which database?", "select", { choices: ["postgres", "sqlite"] }),
      ask("q3", "Who should we greet?", "input"),
      ask("q4", BREAKPOINT, "input", { breakpoint: true, title: "Approve the notes", show: "v1.2 starts faster." }),
    ],
  });
  const panel = (name: string) => screen.findByRole("region", { name });

  test("a confirm sends yes, and the answer stays where the question was", async () => {
    const { calls } = serve([asking]);
    open("/runs/r1");
    const yes = within(await panel("Ship it?")).getByRole("button", { name: "Yes" });
    expect(yes).toHaveAttribute("data-variant", "primary");
    await userEvent.click(yes);
    await waitFor(() => expect(calls).toEqual([["answer", "q1", "yes"]]));
    const note = (await screen.findByText("You answered yes. The run goes on.")).closest("[role=status]");
    expect(note).toHaveFocus();
  });

  test("a second press while the answer is on its way sends nothing more", async () => {
    const { calls } = serve([asking]);
    open("/runs/r1");
    const yes = within(await panel("Ship it?")).getByRole("button", { name: "Yes" });
    // Two presses before the page draws again, as a quick double click can make.
    act(() => {
      fireEvent.click(yes);
      fireEvent.click(yes);
    });
    await screen.findByText("You answered yes. The run goes on.");
    expect(calls).toEqual([["answer", "q1", "yes"]]);
  });

  test("a select sends the picked choice", async () => {
    const { calls } = serve([asking]);
    open("/runs/r1");
    const box = await panel("Which database?");
    await userEvent.click(within(box).getByRole("radio", { name: "sqlite" }));
    await userEvent.click(within(box).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(calls).toEqual([["answer", "q2", "sqlite"]]));
  });

  test("an input sends its text, and Answer waits for some", async () => {
    const { calls } = serve([asking]);
    open("/runs/r1");
    const box = await panel("Who should we greet?");
    const send = within(box).getByRole("button", { name: "Answer" });
    await userEvent.click(send);
    expect(calls).toEqual([]);
    await userEvent.type(within(box).getByRole("textbox", { name: "Your answer" }), "World");
    await userEvent.click(send);
    await waitFor(() => expect(calls).toEqual([["answer", "q3", "World"]]));
    expect(await screen.findByText('You answered "World". The run goes on.')).toBeInTheDocument();
  });

  test("a breakpoint shows its text without the reply hint, and sends back with a note", async () => {
    const { calls } = serve([asking]);
    open("/runs/r1");
    const box = await panel("Approve the notes");
    expect(box).toHaveTextContent("v1.2 starts faster.");
    expect(box).not.toHaveTextContent("Reply approve");
    await userEvent.click(within(box).getByRole("button", { name: "Send back", expanded: false }));
    const note = within(box).getByRole("textbox", { name: /What should change/ });
    expect(note).toHaveFocus();
    await userEvent.type(note, "Shorter");
    await userEvent.click(within(note.closest("form")!).getByRole("button", { name: "Send back" }));
    await waitFor(() => expect(calls).toEqual([["send-back", "q4", "Shorter"]]));
  });

  test("Approve at a breakpoint sends sous approve", async () => {
    const { calls } = serve([asking]);
    open("/runs/r1");
    await userEvent.click(within(await panel("Approve the notes")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls).toEqual([["approve", "q4"]]));
  });

  test("Stop the run at a breakpoint answers stop", async () => {
    const { calls } = serve([asking]);
    open("/runs/r1");
    await userEvent.click(within(await panel("Approve the notes")).getByRole("button", { name: "Stop the run" }));
    await waitFor(() => expect(calls).toEqual([["answer", "q4", "stop"]]));
  });

  test("an agent that asked in its turn shows the sous join line to copy, no answer box, and not its message", async () => {
    const joining = runPage({
      status: "needs",
      statusText: "Needs you",
      pauseReason: undefined,
      can: CAN,
      steps: [step(1, "build"), step(2, "impl", { kind: "agent", status: "running", endedAt: undefined, durationMs: undefined })],
      questions: [ask("q5", "Which database should I use?", "input", { answeredBy: "join", step: "impl" })],
    });
    const { calls } = serve([joining]);
    open("/runs/r1");
    const box = await panel("This agent needs you");
    expect(box).toHaveTextContent("Its question is in its session. Step into it in a terminal. The step goes on once you leave.");
    expect(within(box).getByText("sous join r1 impl")).toBeInTheDocument();
    expect(within(box).getByRole("button", { name: "Copy the join command" })).toBeInTheDocument();
    expect(box).not.toHaveTextContent("Which database should I use?");
    expect(within(box).queryByRole("textbox")).toBeNull();
    expect(within(box).queryByRole("button", { name: "Answer" })).toBeNull();
    expect(within(box).queryByText(/did before asking/)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("the views and the URL", () => {
  test("Graph shows first, Steps puts view=steps in the URL, and Graph takes it out", async () => {
    serve([runPage()]);
    const router = open("/runs/r1");
    await loaded();
    expect(screen.getByRole("region", { name: "Graph of r1" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Steps", { selector: "button, [role=radio], [role=button]" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "steps" }));
    expect(screen.getByRole("region", { name: "Steps" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Graph", { selector: "button, [role=radio], [role=button]" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  test("a node in the graph opens its panel beside the graph, and the view stays the graph", async () => {
    serve([runPage()], [detail("test", { status: "failed", failure: "2 tests failed" })]);
    const router = open("/runs/r1");
    await loaded();
    const node = screen.getAllByRole("button").find((b) => b.dataset.gnode !== undefined && b.textContent?.includes("test"));
    await userEvent.click(node!);
    await waitFor(() => expect(router.state.location.search).toEqual({ step: "/b" }));
    expect(await screen.findByRole("region", { name: "Details of test" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Graph of r1" })).toBeInTheDocument();
    expect(node).toHaveAttribute("aria-current", "true");
  });

  test("a link with ?step= opens that step's panel, and its Resume from here is the primary", async () => {
    const { calls } = serve([runPage()], [detail("test", { status: "failed", failure: "2 tests failed" })]);
    open("/runs/r1?step=r1%3A2");
    const drop = await screen.findByRole("region", { name: "Details of test" });
    expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute("data-variant", "secondary");
    const here = within(drop).getByRole("button", { name: "Resume from here" });
    expect(here).toHaveAttribute("data-variant", "primary");
    await userEvent.click(here);
    await waitFor(() => expect(calls).toEqual([["resume", "r1"]]));
  });
});

describe("a step's panel", () => {
  test("it reads the step only once it is selected, and closing the panel takes the step out of the URL", async () => {
    const { reads } = serve([runPage()], [detail("build")]);
    const router = open("/runs/r1?view=steps");
    await loaded();
    expect(reads.some((r) => r.includes("/step"))).toBe(false);
    await userEvent.click(rowOf("/a"));
    const drop = await screen.findByRole("region", { name: "Details of build" });
    expect(router.state.location.search).toEqual({ view: "steps", step: "/a" });
    expect(reads).toContain("/api/runs/r1/step?name=build&call=1");
    expect(await within(drop).findByText("npm run build")).toBeInTheDocument();
    expect(rowOf("/a")).toHaveAttribute("aria-current", "true");
    await userEvent.click(within(drop).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "steps" }));
    expect(screen.queryByRole("region", { name: "Details of build" })).toBeNull();
  });

  test("Escape closes the panel", async () => {
    serve([runPage()], [detail("build")]);
    const router = open("/runs/r1?step=%2Fa");
    await screen.findByRole("region", { name: "Details of build" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.queryByRole("region", { name: "Details of build" })).toBeNull();
  });

  test("an agent step shows its session: program, id, folder, and the sous join line to copy", async () => {
    const coder = step(1, "coder", { kind: "agent" });
    const done = runPage({ status: "done", statusText: "Done", pauseReason: undefined, steps: [coder], flow: undefined, can: CAN });
    const session = { id: "s-7f2c", program: "Claude Code", folder: "/tmp/parser/.sous/worktrees/coder", join: "sous join r1 coder", handle: "coder" };
    serve([done], [detail("coder", { kind: "agent", command: undefined, output: undefined, prompt: "Fix the parser.", session })]);
    open("/runs/r1?step=r1%3A1");
    const drop = await screen.findByRole("region", { name: "Details of coder" });
    // The panel shows first, then the step's detail once read.
    await within(drop).findByText("Session");
    for (const text of ["Claude Code", "s-7f2c", "/tmp/parser/.sous/worktrees/coder", "sous join r1 coder"]) expect(within(drop).getByText(text)).toBeInTheDocument();
    expect(within(drop).getByRole("button", { name: "Copy the join command" })).toBeInTheDocument();
  });

  test("a code step shows no session", async () => {
    serve([runPage()], [detail("build")]);
    open("/runs/r1?step=%2Fa");
    const drop = await screen.findByRole("region", { name: "Details of build" });
    await within(drop).findByText("npm run build");
    expect(within(drop).queryByText("Session")).toBeNull();
    expect(within(drop).queryByRole("button", { name: "Copy the join command" })).toBeNull();
  });

  test("Escape leaves the panel open while the person types in it, so the draft stays", async () => {
    const coder = step(1, "coder", { kind: "agent", status: "running", endedAt: undefined, durationMs: undefined });
    const running = runPage({ status: "running", statusText: "Running", pauseReason: undefined, steps: [coder], flow: undefined, can: { ...CAN, stop: true, remove: false } });
    serve([running], [detail("coder", { kind: "agent", status: "running", command: undefined, output: undefined, prompt: "Fix the parser.", activity: [] })]);
    const router = open("/runs/r1?step=r1%3A1");
    const drop = await screen.findByRole("region", { name: "Details of coder" });
    const box = within(drop).getByRole("textbox", { name: "Tell coder" });
    await userEvent.type(box, "Use zod{Escape}");
    expect(router.state.location.search).toEqual({ step: "r1:1" });
    expect(box).toHaveValue("Use zod");
  });

  test("Escape leaves the panel open while the focus is in the list column open over the page, whose own Escape closes it", async () => {
    serve([runPage()], [detail("build")]);
    const router = open("/runs/r1?step=%2Fa");
    await screen.findByRole("region", { name: "Details of build" });
    const column = document.body.appendChild(Object.assign(document.createElement("aside"), { id: COLUMN_ID }));
    column.setAttribute("data-overlay", "");
    const row = column.appendChild(document.createElement("button"));
    row.focus();
    await userEvent.keyboard("{Escape}");
    expect(router.state.location.search).toEqual({ step: "/a" });
    expect(screen.getByRole("region", { name: "Details of build" })).toBeInTheDocument();
    column.remove();
  });

  test("Escape closes the panel while the focus is in the list column beside the page", async () => {
    serve([runPage()], [detail("build")]);
    const router = open("/runs/r1?step=%2Fa");
    await screen.findByRole("region", { name: "Details of build" });
    const column = document.body.appendChild(Object.assign(document.createElement("aside"), { id: COLUMN_ID }));
    const row = column.appendChild(document.createElement("button"));
    row.focus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    column.remove();
  });

  test("a running agent step folds its tool calls and takes a message with Tell", async () => {
    const line = (seq: number, kind: Activity["kind"], tool?: string): Activity => ({ seq, at: iso(seq * 100), kind, text: tool ? `${tool} src/${seq}.ts` : `line ${seq}`, ...(tool ? { tool } : {}) });
    const activity = [line(1, "text"), ...[2, 4, 6, 8, 10, 12].flatMap((s) => [line(s, "tool", "Read"), line(s + 1, "tool-result")]), line(20, "text")];
    const coder = step(1, "coder", { kind: "agent", status: "running", endedAt: undefined, durationMs: undefined });
    const running = runPage({ status: "running", statusText: "Running", pauseReason: undefined, steps: [coder], flow: undefined, can: { ...CAN, stop: true, remove: false } });
    const { calls } = serve([running], [detail("coder", { kind: "agent", status: "running", command: undefined, output: undefined, prompt: "Fix the parser.", activity })], { tell: { delivery: "pending" } });
    open("/runs/r1?step=r1%3A1");
    const drop = await screen.findByRole("region", { name: "Details of coder" });
    expect(within(drop).queryByText("Read src/2.ts")).toBeNull();
    await userEvent.click(within(drop).getByText("6 tool calls: Read 6"));
    expect(within(drop).getByText("Read src/2.ts")).toBeInTheDocument();
    await userEvent.type(within(drop).getByRole("textbox", { name: "Tell coder" }), "Use zod");
    await userEvent.click(within(drop).getByRole("button", { name: "Tell" }));
    await waitFor(() => expect(calls).toEqual([["tell", "r1", "Use zod", "--step", "coder"]]));
    expect(await screen.findByText("Sent to coder, not read yet")).toBeInTheDocument();
  });
});

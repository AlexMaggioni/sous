import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ApiError, Input, Overview, WorkflowDiff, WorkflowPage } from "../src/api/contract.ts";
import { commandOf } from "../src/api/send.ts";
import { StartDialog } from "../src/start/start-dialog.tsx";
import { closeStart, openStart } from "../src/start/start-store.ts";
import { checkValues, initialValues, startArgv } from "../src/start/start-words.ts";
import { Overlays } from "../src/ui/overlays.tsx";

const INPUTS: Input[] = [
  { name: "branch", type: "string", required: true, description: "The branch to ship" },
  { name: "retries", type: "number", required: false, default: 2 },
  { name: "dry", type: "boolean", required: false, default: false, description: "Only print what it would do" },
  { name: "labels", type: "json", required: false },
  { name: "target", type: "string", required: false, default: "staging", choices: ["staging", "prod"] },
];

function workflow(more: Partial<WorkflowPage> = {}): WorkflowPage {
  return {
    name: "ship",
    file: "/tmp/shop/.sous/workflows/ship.js",
    from: "project",
    description: "Build, test and ship a branch",
    inputs: INPUTS,
    startedBy: "anyone",
    approved: { by: "person", at: "2026-11-20T10:00:00.000Z", changedSince: false },
    problems: [],
    notes: [],
    lastRuns: [],
    calls: [],
    usedBy: [],
    waitsOn: [],
    source: "export const meta = { name: 'ship' }\n",
    ...more,
  };
}

const overview: Overview = {
  home: "/tmp/home/.sous",
  project: { dir: "/tmp/shop", name: "shop" },
  projects: [{ dir: "/tmp/shop", name: "shop" }],
  service: { running: true },
  needsYou: 0,
  version: "0.1.0",
};

const diff: WorkflowDiff = {
  isNew: false,
  lines: [
    { op: " ", text: "await sh('npm test')" },
    { op: "-", text: "await sh('npm run ship')" },
    { op: "+", text: "await sh('npm run ship -- --force')" },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stand-in for `sous serve`: the workflow and its diff to read, and the words of each call. `refuse` answers every call with that refusal. */
function serve(page: WorkflowPage, refuse?: ApiError) {
  const calls: string[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://view.test");
      if (url.pathname === "/api/call") {
        calls.push((JSON.parse(String(init?.body)) as { argv: string[] }).argv);
        return refuse ? json({ ok: false, error: refuse }) : json({ ok: true, data: { runId: "r-9a1" }, notes: [], next: [] });
      }
      if (url.pathname === "/api/overview") return json(overview);
      if (url.pathname === `/api/workflows/${page.name}`) return json(page);
      if (url.pathname === `/api/workflows/${page.name}/diff`) return json(diff);
      return json({ error: { code: "no_such_thing", message: `Nothing at ${url.pathname}.`, change: "", call: null } }, 404);
    }),
  );
  return calls;
}

/** The app's root with the start dialog in it, as the shell draws it, at #/workflows. */
function open() {
  const root = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <StartDialog />
      </>
    ),
  });
  const list = createRoute({ getParentRoute: () => root, path: "/workflows", component: () => <p>Every workflow</p> });
  const run = createRoute({ getParentRoute: () => root, path: "/runs/$runId", component: () => <p>The run page</p> });
  const router = createRouter({ routeTree: root.addChildren([list, run]), history: createMemoryHistory({ initialEntries: ["/workflows"] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <Overlays />
    </QueryClientProvider>,
  );
  return router;
}

async function startShip() {
  await screen.findByText("Every workflow");
  act(() => openStart("ship"));
  const dialog = await screen.findByRole("dialog", { name: "Start ship" });
  await within(dialog).findByRole("textbox", { name: /^branch/ });
  return dialog;
}

afterEach(() => {
  act(() => closeStart());
  vi.unstubAllGlobals();
});

describe("the words of a start", () => {
  test("each field starts at its default, JSON indented", () => {
    const values = initialValues([...INPUTS, { name: "env", type: "json", required: false, default: { a: 1 } }]);
    expect(values).toEqual({ branch: "", retries: "2", dry: false, labels: "", target: "staging", env: '{\n  "a": 1\n}' });
  });

  test("the checks name what sous run would refuse", () => {
    const errors = checkValues(INPUTS, { branch: " ", retries: "two", dry: false, labels: "{oops", target: "dev" });
    expect(errors.branch).toBe("Fill in branch. sous run refuses to start without it.");
    expect(errors.retries).toBe("retries takes a number, such as 3.");
    expect(errors.labels).toMatch(/^labels takes JSON, such as \{"a": 1\} or \["x"\]\./);
    expect(errors.target).toBe("Pick one for target: staging, prod.");
    expect(checkValues(INPUTS, { branch: "main", retries: "3", dry: true, labels: "[]", target: "prod" })).toEqual({});
  });

  test("inputs go after -- as --name=value, defaults and empty fields left out", () => {
    const argv = startArgv("ship", "/tmp/shop", INPUTS, { branch: "fix/login", retries: "2", dry: true, labels: '[ "a",\n "b" ]', target: "staging" });
    expect(argv).toEqual(["run", "ship", "--project", "/tmp/shop", "--", "--branch=fix/login", "--dry=true", '--labels=["a","b"]']);
    expect(startArgv("ship", undefined, INPUTS, initialValues(INPUTS))).toEqual(["run", "ship"]);
    expect(commandOf(argv)).toBe(`sous run ship --project /tmp/shop -- --branch=fix/login --dry=true '--labels=["a","b"]'`);
  });
});

describe("the start dialog", () => {
  test("draws a field for each input type, with its default and its required mark", async () => {
    serve(workflow());
    open();
    const dialog = await startShip();
    const branch = within(dialog).getByRole("textbox", { name: /^branch/ });
    expect(branch).toHaveValue("");
    expect(branch).toHaveAccessibleName(/required/);
    expect(within(dialog).getByRole("textbox", { name: /^retries/ })).toHaveValue("2");
    expect(within(dialog).getByRole("checkbox", { name: "Only print what it would do" })).not.toBeChecked();
    expect(within(dialog).getByRole("textbox", { name: /^labels/ }).tagName).toBe("TEXTAREA");
    expect(within(dialog).getByRole("combobox", { name: /^target/ })).toHaveTextContent("staging");
    expect(within(dialog).getByText("sous run ship")).toBeInTheDocument();
  });

  test("a required field left empty stops the start and says why", async () => {
    const calls = serve(workflow());
    open();
    const dialog = await startShip();
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    expect(await within(dialog).findByText("Fill in branch. sous run refuses to start without it.")).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: /^branch/ })).toHaveAttribute("aria-invalid", "true");
    expect(calls).toEqual([]);
  });

  test("JSON that does not parse stops the start", async () => {
    const calls = serve(workflow());
    open();
    const dialog = await startShip();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^branch/ }), "main");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^labels/ }), "{{oops");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    expect(await within(dialog).findByText(/^labels takes JSON/)).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  test("Start sends the words of sous run, then opens the run", async () => {
    const calls = serve(workflow());
    const router = open();
    const dialog = await startShip();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^branch/ }), "fix/login");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Only print what it would do" }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^labels/ }), '[["a"]'); // "[[" types one "["
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/r-9a1"));
    expect(calls).toEqual([["run", "ship", "--", "--branch=fix/login", "--dry=true", '--labels=["a"]']]);
    expect(await screen.findByText("Started ship")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Start ship" })).not.toBeInTheDocument());
  });

  test("a changed file shows its diff first, and only Approve and start sends", async () => {
    const calls = serve(workflow({ inputs: [], approved: { by: "person", at: "2026-11-20T10:00:00.000Z", changedSince: true } }));
    const router = open();
    await screen.findByText("Every workflow");
    act(() => openStart("ship"));
    const dialog = await screen.findByRole("dialog", { name: "Start ship" });
    expect(await within(dialog).findByText("Changed since you approved it.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    expect(await within(dialog).findByText("await sh('npm run ship -- --force')")).toBeInTheDocument();
    expect(calls).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "Approve and start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/r-9a1"));
    expect(calls).toEqual([["run", "ship"]]);
  });

  test("a refusal shows in the dialog, which stays open", async () => {
    const refusal: ApiError = { code: "workflow_invalid", message: "ship.js has a problem: meta.name must match the file name.", change: "Fix the meta, then start it again.", call: "sous check ship" };
    serve(workflow({ inputs: [] }), refusal);
    const router = open();
    await screen.findByText("Every workflow");
    act(() => openStart("ship"));
    const dialog = await screen.findByRole("dialog", { name: "Start ship" });
    await userEvent.click(await within(dialog).findByRole("button", { name: "Start" }));
    expect(await within(dialog).findByText(refusal.message)).toBeInTheDocument();
    expect(within(dialog).getByText(refusal.change)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/workflows");
  });
});

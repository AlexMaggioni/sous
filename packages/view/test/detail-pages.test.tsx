import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { McpPage, Overview, WorkflowPage } from "../src/api/contract.ts";
import { SourceBlock } from "../src/pages/detail/source-block.tsx";
import { McpDetail } from "../src/pages/mcp/mcp-detail.tsx";
import { WorkflowDetail } from "../src/pages/workflow/workflow-detail.tsx";
import { SidebarContext } from "../src/shell/use-sidebar.ts";
import { Overlays } from "../src/ui/overlays.tsx";

const overview: Overview = {
  home: "/tmp/home/.sous",
  project: { dir: "/tmp/shop", name: "shop" },
  projects: [{ dir: "/tmp/shop", name: "shop" }],
  service: { running: true },
  needsYou: 0,
  version: "0.1.0",
};

const FILE = "/tmp/shop/.sous/workflows/nightly.js";
const nightly: WorkflowPage = {
  name: "nightly",
  file: FILE,
  from: "project",
  description: "Run the slow tests every night",
  inputs: [],
  startedBy: "anyone",
  approved: { by: "person", at: "2026-11-20T10:00:00.000Z", changedSince: false },
  problems: [],
  notes: [],
  lastRuns: [],
  calls: [],
  usedBy: [],
  waitsOn: [],
  source: "export const meta = { name: 'nightly' }\nawait sh('npm run test:slow')\n",
  flow: { nodes: [{ t: "step", id: "a", line: 2, kind: "sh", label: "test:slow" }], notes: [] },
};

const linear: McpPage = {
  name: "linear",
  type: "http",
  seenBy: ["claude", "codex"],
  source: ".rulesync/mcp.jsonc",
  url: "https://mcp.linear.app/mcp",
  env: [],
  headers: [
    { key: "Authorization", value: "Bearer ••••3f9a", secret: true, from: "secrets.env" },
    { key: "X-Team", value: "${LINEAR_TEAM}", secret: true, from: "the environment" },
    // sous masks every literal, also one that doesn't look like a secret.
    { key: "X-Client", value: "••••", secret: false },
  ],
  files: [{ file: "/tmp/shop/.rulesync/mcp.jsonc", scope: "project", harness: "rulesync" }],
  usedBy: [],
  raw: '{\n  "url": "https://mcp.linear.app/mcp",\n  "headers": { "Authorization": "Bearer ••••3f9a" }\n}',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stand-in for `sous serve` that answers the overview, one workflow and one MCP server, and keeps each write's path. */
function serve() {
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://view.test");
      if (init?.method === "POST") {
        writes.push(url.pathname);
        return json({ removed: [FILE] });
      }
      if (url.pathname === "/api/overview") return json(overview);
      if (url.pathname === "/api/workflows/nightly") return json(nightly);
      if (url.pathname === "/api/mcp/linear") return json(linear);
      return json({ error: { code: "no_such_thing", message: `Nothing at ${url.pathname}.`, change: "", call: null } }, 404);
    }),
  );
  return writes;
}

const sidebar = { open: true, overlay: false, toggle() {}, show() {}, close() {} };

/** The detail pages under a router like the app's, at `path`, with the toasts and the confirm host. */
function open(path: string) {
  const root = createRootRoute({
    component: () => (
      <SidebarContext.Provider value={sidebar}>
        <Outlet />
      </SidebarContext.Provider>
    ),
  });
  const list = createRoute({ getParentRoute: () => root, path: "/workflows", component: () => <p>Every workflow</p> });
  const workflow = createRoute({ getParentRoute: () => root, path: "/workflows/$name", component: WorkflowDetail });
  const mcp = createRoute({ getParentRoute: () => root, path: "/mcp/$name", component: McpDetail });
  const router = createRouter({ routeTree: root.addChildren([list, workflow, mcp]), history: createMemoryHistory({ initialEntries: [path] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <Overlays />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("moving a workflow to the trash", () => {
  test("the question names the file's path, and Cancel moves nothing", async () => {
    const writes = serve();
    open("/workflows/nightly");
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move to trash" }));
    const question = await screen.findByRole("alertdialog", { name: "Move nightly.js to the trash?" });
    expect(question).toHaveTextContent(FILE);
    await userEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(writes).toEqual([]);
  });

  test("Move to trash moves it, then goes back to the list", async () => {
    const writes = serve();
    const router = open("/workflows/nightly");
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move to trash" }));
    const question = await screen.findByRole("alertdialog", { name: "Move nightly.js to the trash?" });
    await userEvent.click(within(question).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
    expect(writes).toEqual(["/api/workflows/nightly/trash"]);
    expect(await screen.findByText("Moved nightly.js to the trash")).toBeInTheDocument();
  });
});

describe("a markdown file, rendered or raw", () => {
  const raw = "---\nname: review\ndescription: Read a diff\n---\n# Review\n\nRead the **diff** first.\n";

  test("shows the markdown rendered first, then the whole file raw", async () => {
    render(<SourceBlock file="/tmp/shop/.claude/skills/review/SKILL.md" rendered={"# Review\n\nRead the **diff** first.\n"} raw={raw} />);
    expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
    expect(screen.queryByText("name: review")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Raw" }));
    const text = screen.getByRole("region", { name: "Text of SKILL.md" });
    expect(text).toHaveTextContent("name: review");
    expect(text).toHaveTextContent("Read the **diff** first.");
    expect(screen.queryByRole("heading", { name: "Review" })).not.toBeInTheDocument();
  });

  test("says so when nothing sits under the front matter", () => {
    render(<SourceBlock file="/tmp/shop/.claude/agents/empty.md" rendered=" " raw={"---\nname: empty\n---\n"} />);
    expect(screen.getByText("The file has no text under its front matter.")).toBeInTheDocument();
  });
});

describe("an MCP server's values", () => {
  test("each header shows as the server sends it, masked, with where sous reads it", async () => {
    serve();
    open("/mcp/linear");
    const connection = await screen.findByRole("region", { name: "Connection" });
    const rows = within(connection);
    expect(rows.getByText("Bearer ••••3f9a")).toBeInTheDocument();
    expect(rows.getByText("Masked, read from secrets.env")).toBeInTheDocument();
    expect(rows.getByText("${LINEAR_TEAM}")).toBeInTheDocument();
    // A ${NAME} shows as written, so its note does not say masked.
    expect(rows.getByText("Read from the environment")).toBeInTheDocument();
    expect(rows.getByText("Written in the file, masked here")).toBeInTheDocument();
    expect(connection).not.toHaveTextContent(/[0-9a-f]{20}/);
    expect(screen.getByText("Masked on this page")).toBeInTheDocument();
    expect(rows.getByText("sous fills each ${NAME} when a step starts. Neither this page nor the agent sees the value.")).toBeInTheDocument();
  });
});

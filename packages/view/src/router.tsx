import { createHashHistory, createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { SectionHome } from "./pages/section-home.tsx";
import { Shell } from "./shell/shell.tsx";

// Hash routes, so sous serve only hands out static files and a reload never needs a server route.
// What a page shows, such as the run view or the open step, lives in the search params. The homes
// come with the first load. Each other page loads on its first visit, or when a link to it is
// hovered, so the first load stays small.

const root = createRootRoute({ component: Shell });

const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/runs" });
  },
});

export type RunSearch = { view?: "steps"; step?: string };

const list = (path: "/runs" | "/workflows" | "/agents" | "/skills" | "/mcp") =>
  createRoute({ getParentRoute: () => root, path, component: SectionHome });

const runs = list("/runs");
const run = createRoute({
  getParentRoute: () => root,
  path: "/runs/$runId",
  // Graph is the default view, so only Steps shows in the URL. The selected step stays in either.
  validateSearch: (search: Record<string, unknown>): RunSearch => ({
    view: search.view === "steps" ? "steps" : undefined,
    step: typeof search.step === "string" ? search.step : undefined,
  }),
  component: lazyRouteComponent(() => import("./pages/run/run-detail.tsx"), "RunDetail"),
});

/** The project a catalog page is seen from, when its link names one, such as a link from a run to its workflow. */
export type ProjectSearch = { project?: string };
const projectSearch = (search: Record<string, unknown>): ProjectSearch => ({ project: typeof search.project === "string" && search.project ? search.project : undefined });

export type WorkflowSearch = ProjectSearch & { view?: "graph" | "steps" | "source" | "changes"; step?: string; line?: number };
const WORKFLOW_VIEWS = new Set(["graph", "steps", "source", "changes"]);

const workflows = list("/workflows");
const workflow = createRoute({
  getParentRoute: () => root,
  path: "/workflows/$name",
  // The view, the selected step and the line Source marks. With no view, the page picks Graph, or
  // Source for a file whose steps sous can't read.
  validateSearch: (search: Record<string, unknown>): WorkflowSearch => ({
    ...projectSearch(search),
    view: typeof search.view === "string" && WORKFLOW_VIEWS.has(search.view) ? (search.view as WorkflowSearch["view"]) : undefined,
    step: typeof search.step === "string" ? search.step : undefined,
    line: typeof search.line === "number" && search.line > 0 ? Math.floor(search.line) : undefined,
  }),
  component: lazyRouteComponent(() => import("./pages/workflow/workflow-detail.tsx"), "WorkflowDetail"),
});
const agents = list("/agents");
const agent = createRoute({ getParentRoute: () => root, path: "/agents/$name", validateSearch: projectSearch, component: lazyRouteComponent(() => import("./pages/agent/agent-detail.tsx"), "AgentDetail") });
const skills = list("/skills");
const skill = createRoute({ getParentRoute: () => root, path: "/skills/$name", validateSearch: projectSearch, component: lazyRouteComponent(() => import("./pages/skill/skill-detail.tsx"), "SkillDetail") });
const mcps = list("/mcp");
const mcp = createRoute({ getParentRoute: () => root, path: "/mcp/$name", validateSearch: projectSearch, component: lazyRouteComponent(() => import("./pages/mcp/mcp-detail.tsx"), "McpDetail") });
const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: lazyRouteComponent(() => import("./pages/settings-page.tsx"), "SettingsPage") });
// Every component in every state, for building one. Only the dev server has it, so the built page
// leaves the kit and its sample data out. Not linked from the rail.
const kit = createRoute({ getParentRoute: () => root, path: "/kit", component: lazyRouteComponent(() => import("./kit/kit-page.tsx"), "KitPage") });

const routeTree = root.addChildren([index, runs, run, workflows, workflow, agents, agent, skills, skill, mcps, mcp, settings, ...(import.meta.env.DEV ? [kit] : [])]);

export const router = createRouter({ routeTree, history: createHashHistory(), defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

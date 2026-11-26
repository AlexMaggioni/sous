// The API under /api, one entry per route of packages/view/src/api/contract.ts. Each reads
// through the engine and answers the contract's shape: each route names its contract type, so
// the typecheck fails when an answer drifts from it. The two removals have routes of their own,
// and every other write goes through POST /api/call. /api/live is the server's, since it streams.

import { isAbsolute, resolve } from "node:path";
import { agentPage, listMcpServers, listSkills, mcpPage, removeRun, skillPage, trashWorkflow, type HomePaths, type Launcher } from "@sous-run/engine";
import type { AgentPage, AgentRow, McpPage, McpRow, Overview, Question, Removed, RunPage, RunRow, Settings, SkillPage, SkillRow, StepDetail, WorkflowDiff, WorkflowPage, WorkflowRow } from "@sous-run/view";
import type { CommandSpec } from "../commands/index.js";
import { runCall, VIEW } from "./call.js";
import { agentRows, overview, settings } from "./catalog.js";
import { ApiFailure, failureOf } from "./errors.js";
import { openQuestions, runPage, runRows, stepDetail } from "./runs.js";
import { workflowDiffOf, workflowPage, workflowRows } from "./workflows.js";

/** What the routes read with. */
export interface ApiContext {
  paths: HomePaths;
  /** The project sous serve started in, the default of ?project=. */
  project: string;
  version: string;
  env: NodeJS.ProcessEnv;
  launch: Launcher;
  commands: Record<string, CommandSpec>;
}

/** A request, its path cut into words after /api/. */
interface Request {
  method: string;
  words: string[];
  query: URLSearchParams;
  body: unknown;
}

type Handler = (request: Request, context: ApiContext) => unknown;

interface Route {
  method: "GET" | "POST" | "DELETE";
  /** The path's words. A word that starts with ":" takes any word. */
  path: string[];
  handle: Handler;
}

/** A catalog page the project does not have. */
function missing(what: string, name: string, list: string): never {
  const change = `Give the name of one the ${list} list shows, or another project with ?project=.`;
  throw new ApiFailure(404, { code: `no_such_${what.toLowerCase().replace(/ /g, "_")}`, message: `no ${what} "${name}" seen from this project.`, change, call: null });
}

/** The project of ?project=, an absolute folder, else the server's. */
function projectOf(request: Request, context: ApiContext): string {
  const dir = request.query.get("project");
  if (!dir) return context.project;
  if (!isAbsolute(dir)) throw new ApiFailure(400, { code: "bad_argument", message: `?project= takes an absolute folder, not "${dir}".`, change: "Give the project's whole path.", call: null });
  return resolve(dir);
}

/** The ?call= of a step: a whole number from 1, or none. */
function callOf(request: Request): number | undefined {
  const text = request.query.get("call");
  if (text === null || text === "") return undefined;
  const call = Number(text);
  if (!Number.isInteger(call) || call < 1) throw new ApiFailure(400, { code: "bad_argument", message: `?call= takes a whole number from 1, not "${text}".`, change: "Give the call's number, or leave ?call= out for the last call.", call: null });
  return call;
}

function stepName(request: Request): string {
  const name = request.query.get("name");
  if (!name) throw new ApiFailure(400, { code: "bad_argument", message: "a step's route needs ?name=, the step's name in the log.", change: "Add ?name= with the name the run page gives the step.", call: null });
  return name;
}

const at = (request: Request, i: number) => request.words[i]!;

/** A route whose answer has the contract's type T. */
const route = <T>(method: Route["method"], path: string[], handle: (request: Request, context: ApiContext) => T): Route => ({ method, path, handle });

const ROUTES: Route[] = [
  route<Overview>("GET", ["overview"], (_, c) => overview(c.paths, c.project, c.version)),
  route<RunRow[]>("GET", ["runs"], (_, c) => runRows(c.paths)),
  route<RunPage>("GET", ["runs", ":id"], (r, c) => runPage(c.paths, at(r, 1))),
  route<Removed>("DELETE", ["runs", ":id"], (r, c) => removeRun(c.paths, at(r, 1), VIEW)),
  route<StepDetail>("GET", ["runs", ":id", "step"], (r, c) => stepDetail(c.paths, at(r, 1), stepName(r), callOf(r))),
  route<Question[]>("GET", ["questions"], (_, c) => openQuestions(c.paths)),
  route<WorkflowRow[]>("GET", ["workflows"], (r, c) => workflowRows(c.paths, projectOf(r, c))),
  route<WorkflowPage>("GET", ["workflows", ":name"], (r, c) => workflowPage(c.paths, projectOf(r, c), at(r, 1))),
  route<WorkflowDiff>("GET", ["workflows", ":name", "diff"], (r, c) => workflowDiffOf(c.paths, projectOf(r, c), at(r, 1))),
  route<Removed>("POST", ["workflows", ":name", "trash"], (r, c) => trashWorkflow(c.paths, projectOf(r, c), at(r, 1), VIEW)),
  route<AgentRow[]>("GET", ["agents"], (r, c) => agentRows(c.paths, projectOf(r, c), c.env)),
  route<AgentPage>("GET", ["agents", ":name"], (r, c) => agentPage(c.paths, projectOf(r, c), at(r, 1), c.env) ?? missing("agent", at(r, 1), "agents")),
  route<SkillRow[]>("GET", ["skills"], (r, c) => listSkills(c.paths, projectOf(r, c), c.env)),
  route<SkillPage>("GET", ["skills", ":name"], (r, c) => skillPage(c.paths, projectOf(r, c), at(r, 1), c.env) ?? missing("skill", at(r, 1), "skills")),
  route<McpRow[]>("GET", ["mcp"], (r, c) => listMcpServers(c.paths, projectOf(r, c), c.env)),
  route<McpPage>("GET", ["mcp", ":name"], (r, c) => mcpPage(c.paths, projectOf(r, c), at(r, 1), c.env) ?? missing("MCP server", at(r, 1), "MCP servers")),
  route<Settings>("GET", ["settings"], (_, c) => settings(c.paths)),
];

function decoded(word: string): string {
  try {
    return decodeURIComponent(word);
  } catch {
    throw new ApiFailure(400, { code: "bad_argument", message: `"${word}" is not a word of a path.`, change: "Encode the name with encodeURIComponent.", call: null });
  }
}

const matches = (route: Route, words: string[]) => route.path.length === words.length && route.path.every((word, i) => word.startsWith(":") || word === words[i]);

/** The answer of one API request, other than /api/live: its status and its JSON body. */
export async function answerApi(context: ApiContext, method: string, path: string, query: URLSearchParams, body: unknown): Promise<{ status: number; body: unknown }> {
  try {
    const words = path.split("/").filter(Boolean).map(decoded);
    if (words.length === 1 && words[0] === "call") {
      if (method !== "POST") throw wrongMethod(method, path, ["POST"]);
      const { status, reply } = await runCall(body, context);
      return { status, body: reply };
    }
    const routes = ROUTES.filter((route) => matches(route, words));
    if (!routes.length) throw new ApiFailure(404, { code: "no_such_route", message: `sous serve has no route /api/${path}.`, change: "Call a route of the API, such as /api/runs.", call: null });
    const route = routes.find((candidate) => candidate.method === method);
    if (!route) throw wrongMethod(method, path, routes.map((candidate) => candidate.method));
    return { status: 200, body: route.handle({ method, words, query, body }, context) };
  } catch (error) {
    const { status, error: apiError } = failureOf(error);
    return { status, body: { error: apiError } };
  }
}

function wrongMethod(method: string, path: string, allowed: string[]): ApiFailure {
  return new ApiFailure(405, { code: "wrong_method", message: `/api/${path} takes ${allowed.join(" or ")}, not ${method}.`, change: `Send ${allowed.join(" or ")}.`, call: null });
}

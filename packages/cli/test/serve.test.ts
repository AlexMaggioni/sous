import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { listRuns, runQuestions, startRun, type HomePaths } from "@sous-run/engine";
import { PERSON, WorkflowError, WorkflowErrorCode, fakeRunner, inProcess, readActions, testHome, type InProcessWorkers } from "@sous-run/engine/testing";
import type { ApiError, CallReply, LiveEvent, RunPage, RunRow, StepDetail, WorkflowDiff, WorkflowPage, WorkflowRow } from "@sous-run/view";
import { COMMANDS } from "../src/commands/index.js";
import { LiveFeed } from "../src/serve/live.js";
import { startServer, type Served, type ServeOptions } from "../src/serve/server.js";
import { sous, waitFor } from "./sous.js";

// sous serve's server: who it lets in, what each route answers, the calls the page makes, and
// the live stream. Each test starts a server of its own on a free port of 127.0.0.1.

const ship = `export const meta = { name: 'ship', description: 'asks, then runs a step', place: 'none' }
const approved = await ask('Ship it?', { choices: ['yes', 'no'] })
await sh('echo shipping', { label: 'announce' })
return await agent('ship, approved ' + approved, { label: 'ship' })`;

const greet = `export const meta = { name: 'greet', description: 'greets someone', place: 'none', inputs: { who: { type: 'string', description: 'Who to greet', required: true } } }
return await agent('say hi to ' + args.who, { label: 'hi' })`;

const old = `export const meta = { name: 'old', description: 'not used any more', place: 'none' }
return 'old'`;

const flaky = `export const meta = { name: 'flaky', description: 'a step that fails once', place: 'none' }
return await agent('try it', { label: 'flaky', retries: 2 })`;

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: any;
}

interface Init {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Send the token as a Bearer header. Default true. */
  bearer?: boolean;
}

/** One request to the server, through node:http so the test sets Host and Origin itself. */
function call(served: Served, path: string, init: Init = {}): Promise<Answer> {
  const { method = "GET", headers = {}, body, bearer = true } = init;
  const text = body === undefined ? undefined : JSON.stringify(body);
  const sent = { ...(bearer ? { authorization: `Bearer ${served.token}` } : {}), ...(text ? { "content-type": "application/json" } : {}), ...headers };
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port: served.port, path, method, headers: sent }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {}
        done({ status: res.statusCode!, headers: res.headers, text: data, json });
      });
    });
    req.on("error", fail);
    req.end(text);
  });
}

/** The events of /api/live, as they come. */
function listen(served: Served): { events: LiveEvent[]; close(): void } {
  const events: LiveEvent[] = [];
  let buffer = "";
  const req = request({ host: "127.0.0.1", port: served.port, path: "/api/live", headers: { authorization: `Bearer ${served.token}` } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop()!;
      for (const line of blocks.flatMap((block) => block.split("\n"))) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as LiveEvent);
    });
  });
  req.on("error", () => {});
  req.end();
  return { events, close: () => req.destroy() };
}

/** A home with the three workflows, and a server on it. It closes when the test ends. */
async function served(t: TestContext, options: Partial<ServeOptions> = {}): Promise<{ paths: HomePaths; projectDir: string; workers: InProcessWorkers; server: Served }> {
  const { paths, projectDir } = testHome({ ship, greet, old });
  const { runner } = fakeRunner((step) => `ran ${step.prompt}`);
  const workers = inProcess({ inner: runner });
  const server = await startServer({ paths, project: projectDir, port: 0, host: "127.0.0.1", launch: workers.launch, commands: COMMANDS, ...options });
  // A worker in this process waits for its answer until it gets one, so each run gets one.
  t.after(async () => {
    await server.close();
    for (const question of runQuestions(paths)) await sous(paths, ["answer", question.id, "no"]);
    await Promise.allSettled(workers.launched.map(({ runId }) => workers.ended(runId)));
  });
  return { paths, projectDir, workers, server };
}

/** A run that waits on its question, and a run that ended. */
async function twoRuns(paths: HomePaths, projectDir: string, workers: InProcessWorkers): Promise<{ asking: string; ended: string }> {
  const asking = startRun(paths, workers.launch, { who: PERSON, workflow: "ship", projectDir, inputs: {} }).runId;
  const ended = startRun(paths, workers.launch, { who: PERSON, workflow: "greet", projectDir, inputs: { who: "Ada" } }).runId;
  await waitFor(() => runQuestions(paths, asking).length === 1, "the ship run to ask");
  assert.equal((await workers.ended(ended))?.status, "completed");
  return { asking, ended };
}

const isError = (value: unknown): value is ApiError => {
  const error = value as ApiError;
  return typeof error?.code === "string" && typeof error.message === "string" && typeof error.change === "string" && (error.call === null || typeof error.call === "string");
};

describe("who sous serve lets in", () => {
  it("answers 401 without the token, on the API and on the page", async (t) => {
    const { server } = await served(t);
    const api = await call(server, "/api/runs", { bearer: false });
    assert.equal(api.status, 401);
    assert.ok(isError(api.json.error));
    assert.equal(api.json.error.code, "no_token");
    const page = await call(server, "/", { bearer: false });
    assert.equal(page.status, 401);
    assert.match(page.headers["content-type"]!, /^text\/html/);
    assert.match(page.text, /Open the link sous serve printed/);
    const wrong = await call(server, "/api/runs", { bearer: false, headers: { authorization: "Bearer nope", cookie: `sous_${server.port}=nope` } });
    assert.equal(wrong.status, 401);
  });

  it("turns the link's token into a cookie, goes to the page and serves its files", async (t) => {
    const view = mkdtempSync(join(tmpdir(), "sous-view-"));
    mkdirSync(join(view, "assets"));
    writeFileSync(join(view, "index.html"), "<!doctype html><title>sous</title>");
    writeFileSync(join(view, "assets", "app-1a2b.js"), "console.log('sous')");
    const { server } = await served(t, { viewDir: view });
    assert.match(server.url, new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/\\?t=`));

    const link = await call(server, `/?t=${encodeURIComponent(server.token)}`, { bearer: false });
    assert.equal(link.status, 302);
    assert.equal(link.headers.location, "/");
    const [cookie] = link.headers["set-cookie"]!;
    assert.match(cookie!, new RegExp(`^sous_${server.port}=${server.token}; `));
    assert.match(cookie!, /HttpOnly/);
    assert.match(cookie!, /SameSite=Strict/);
    const kept = cookie!.split(";")[0]!;

    const index = await call(server, "/", { bearer: false, headers: { cookie: kept } });
    assert.equal(index.status, 200);
    assert.match(index.headers["content-type"]!, /^text\/html/);
    assert.equal(index.text, "<!doctype html><title>sous</title>");
    const asset = await call(server, "/assets/app-1a2b.js", { bearer: false, headers: { cookie: kept } });
    assert.match(asset.headers["content-type"]!, /^text\/javascript/);
    assert.match(asset.headers["cache-control"]!, /immutable/);
    assert.equal((await call(server, "/api/runs", { bearer: false, headers: { cookie: kept } })).status, 200);
    assert.equal((await call(server, "/%2e%2e/%2e%2e/etc/passwd", { bearer: false, headers: { cookie: kept } })).status, 404);
    assert.equal((await call(server, "/index.html%00", { bearer: false, headers: { cookie: kept } })).status, 404);
  });

  it("says how to build the page when it is not built", async (t) => {
    const { server } = await served(t, { viewDir: mkdtempSync(join(tmpdir(), "sous-view-")) });
    const page = await call(server, "/");
    assert.equal(page.status, 503);
    assert.match(page.text, /pnpm --filter @sous-run\/view build/);
  });

  it("refuses a Host that is not its own, and a write with the cookie from another origin", async (t) => {
    const { server } = await served(t);
    const host = await call(server, "/api/runs", { headers: { host: `sous.example:${server.port}` } });
    assert.equal(host.status, 403);
    assert.equal(host.json.error.code, "bad_host");
    assert.equal((await call(server, "/api/runs", { headers: { host: `localhost:${server.port}` } })).status, 200);

    const cookie = `sous_${server.port}=${server.token}`;
    const body = { argv: ["workflows"] };
    const away = await call(server, "/api/call", { method: "POST", bearer: false, body, headers: { cookie, origin: "http://sous.example" } });
    assert.equal(away.status, 403);
    assert.equal(away.json.error.code, "bad_origin");
    const none = await call(server, "/api/call", { method: "POST", bearer: false, body, headers: { cookie } });
    assert.equal(none.status, 403);
    const own = await call(server, "/api/call", { method: "POST", bearer: false, body, headers: { cookie, origin: server.origin } });
    assert.equal(own.status, 200);
    // A Bearer token is not sent by a page of another site, so it skips the check.
    assert.equal((await call(server, "/api/call", { method: "POST", body, headers: { origin: "http://sous.example" } })).status, 200);
  });
});


describe("the routes of sous serve", () => {
  it("answer the contract's shapes, on runs a fake runner made", async (t) => {
    const { paths, projectDir, workers, server } = await served(t);
    const { asking, ended } = await twoRuns(paths, projectDir, workers);
    const get = async (path: string) => {
      const answer = await call(server, path);
      assert.equal(answer.status, 200, `${path} answers 200, not ${answer.status}: ${answer.text}`);
      return answer.json;
    };

    const overview = await get("/api/overview");
    assert.equal(overview.home, paths.home);
    assert.deepEqual(overview.project, { dir: projectDir, name: "project" });
    assert.ok(overview.projects.some((project: { dir: string }) => project.dir === projectDir));
    assert.deepEqual(overview.service, { running: false });
    assert.equal(overview.needsYou, 1);
    assert.equal(typeof overview.version, "string");

    const rows: RunRow[] = await get("/api/runs");
    assert.deepEqual(rows.map((row) => row.id).sort(), [asking, ended].sort());
    const asks = rows.find((row) => row.id === asking)!;
    assert.deepEqual([asks.workflow, asks.title, asks.status, asks.statusText, asks.waiting, asks.origin], ["ship", "ship", "needs", "Needs you", 1, "cli"]);
    const greets = rows.find((row) => row.id === ended)!;
    assert.deepEqual([greets.title, greets.status, greets.waiting, typeof greets.endedAt, typeof greets.tokens], ["Ada", "done", 0, "string", "number"]);

    const page: RunPage = await get(`/api/runs/${asking}`);
    assert.equal(page.status, "needs");
    assert.equal(page.place, "none");
    assert.deepEqual(page.questions.map((q) => [q.runId, q.kind, q.prompt, q.answeredBy, q.breakpoint]), [[asking, "select", "Ship it?", "people", false]]);
    assert.ok(page.flow && page.flow.nodes.length > 0, "the run page has the workflow's flow");
    assert.deepEqual(page.flows, {});
    assert.deepEqual(page.can, { stop: true, pause: true, resume: false, resumeChoice: false, rerun: true, remove: false });
    const done: RunPage = await get(`/api/runs/${ended}`);
    assert.deepEqual(done.args, { who: "Ada" });
    assert.deepEqual(done.steps.map((step) => [step.name, step.kind, step.status, step.call]), [["hi", "agent", "done", 1]]);
    assert.equal(done.can.remove, true);

    const step: StepDetail = await get(`/api/runs/${ended}/step?name=hi`);
    assert.deepEqual([step.name, step.kind, step.status, step.call, step.calls], ["hi", "agent", "done", 1, 1]);
    assert.match(step.prompt!, /say hi to Ada/);
    assert.deepEqual([step.session?.join, typeof step.session?.id, typeof step.session?.folder], [`sous join ${ended} hi`, "string", "string"], "the step shows its session and the command that steps into it");
    assert.ok(Array.isArray(step.activity));

    const questions = await get("/api/questions");
    assert.deepEqual(questions.map((q: { runId: string; workflow: string }) => [q.runId, q.workflow]), [[asking, "ship"]]);

    const workflows: WorkflowRow[] = await get("/api/workflows");
    assert.deepEqual(workflows.map((row) => row.name).sort(), ["greet", "old", "ship"]);
    const shipRow = workflows.find((row) => row.name === "ship")!;
    assert.deepEqual([shipRow.from, shipRow.problems, shipRow.lastRun?.id, shipRow.lastRun?.status], ["project", 0, asking, "needs"]);
    const shipPage: WorkflowPage = await get("/api/workflows/ship");
    assert.equal(shipPage.source, ship);
    assert.deepEqual(shipPage.lastRuns.map((run) => run.id), [asking]);
    assert.ok(shipPage.flow && shipPage.flow.nodes.length > 0);
    const greetPage: WorkflowPage = await get(`/api/workflows/greet?project=${encodeURIComponent(projectDir)}`);
    assert.deepEqual(greetPage.inputs.map((input) => [input.name, input.type, input.required]), [["who", "string", true]]);
    const diff: WorkflowDiff = await get("/api/workflows/ship/diff");
    assert.equal(typeof diff.isNew, "boolean");
    assert.ok(diff.lines.every((line) => [" ", "-", "+"].includes(line.op) && typeof line.text === "string"));

    for (const list of ["agents", "skills", "mcp"]) assert.ok(Array.isArray(await get(`/api/${list}`)), `/api/${list} answers a list`);
    const settings = await get("/api/settings");
    assert.equal(settings.home, paths.home);
    assert.equal(typeof settings.config, "object");
    assert.ok(Array.isArray(settings.accounts));
  });

  it("answer an error with a status that fits it", async (t) => {
    const { server } = await served(t);
    const error = async (path: string, status: number, code: string, init: Init = {}) => {
      const answer = await call(server, path, init);
      assert.equal(answer.status, status, `${init.method ?? "GET"} ${path}: ${answer.text}`);
      assert.ok(isError(answer.json.error), `${path} answers an ApiError`);
      assert.equal(answer.json.error.code, code);
    };
    await error("/api/runs/r-nope", 404, "no_such_run");
    await error("/api/runs/r-nope/step", 400, "bad_argument");
    // The home's config.json is one folder up from the records, and no run.
    await error("/api/runs/..%2Fconfig", 404, "no_such_run");
    await error("/api/runs/..%2Fconfig", 404, "no_such_run", { method: "DELETE" });
    await error("/api/workflows/nope", 404, "no_such_workflow");
    await error("/api/workflows?project=relative/dir", 400, "bad_argument");
    await error("/api/agents/nope", 404, "no_such_agent");
    await error("/api/skills/nope", 404, "no_such_skill");
    await error("/api/mcp/nope", 404, "no_such_mcp_server");
    await error("/api/nope", 404, "no_such_route");
    await error("/api/runs", 405, "wrong_method", { method: "POST", body: {} });
    await error("/api/call", 400, "bad_argument", { method: "POST", body: { argv: ["serve"] } });
    await error("/api/call", 400, "bad_argument", { method: "POST", body: { argv: ["workflows", "--by", "person"] } });
    await error("/api/call", 400, "bad_argument", { method: "POST", body: { nope: true } });
  });

  it("POST /api/call answers a question as the person through the page, and the run moves on", async (t) => {
    const { paths, projectDir, workers, server } = await served(t);
    const { asking } = await twoRuns(paths, projectDir, workers);
    const [question] = runQuestions(paths, asking);
    const answer = await call(server, "/api/call", { method: "POST", body: { argv: ["answer", question!.id, "yes"] } });
    assert.equal(answer.status, 200, answer.text);
    const reply = answer.json as CallReply;
    assert.ok(reply.ok);
    assert.ok(Array.isArray(reply.notes) && Array.isArray(reply.next));
    assert.equal((await workers.ended(asking))?.status, "completed");
    const page: RunPage = (await call(server, `/api/runs/${asking}`)).json;
    assert.equal(page.status, "done");
    assert.deepEqual(page.steps.map((step) => [step.name, step.kind, step.status]), [["announce", "exec", "done"], ["ship", "agent", "done"]]);
    const [action] = readActions(paths, { runId: asking, act: "answer" });
    assert.deepEqual([action?.by, action?.through], ["person", { kind: "person", via: "view" }]);
  });

  it("a run started from the page reads as started there", async (t) => {
    const { paths, projectDir, workers, server } = await served(t);
    const answer = await call(server, "/api/call", { method: "POST", body: { argv: ["run", "greet", "--who", "Bo"] } });
    assert.equal(answer.status, 200, answer.text);
    const reply = answer.json as CallReply;
    assert.ok(reply.ok, answer.text);
    const runId = String(reply.data.runId);
    assert.equal((await workers.ended(runId))?.status, "completed");
    const rows: RunRow[] = (await call(server, "/api/runs")).json;
    assert.equal(rows.find((row) => row.id === runId)?.origin, "view");
    assert.equal(listRuns(paths).find((run) => run.record.runId === runId)?.record.origin, "cli", "the record keeps the terminal's origin, and through says the page");
  });

  it("a refused call answers the refusal's ApiError, as sous --json prints it", async (t) => {
    const { paths, projectDir, workers, server } = await served(t);
    const { asking } = await twoRuns(paths, projectDir, workers);
    const [question] = runQuestions(paths, asking);
    const refused = async (argv: string[], status: number, code: string) => {
      const answer = await call(server, "/api/call", { method: "POST", body: { argv } });
      const reply = answer.json as CallReply;
      assert.ok(!reply.ok, answer.text);
      assert.equal(reply.error.code, code);
      assert.equal(answer.status, status, answer.text);
      const printed = JSON.parse((await sous(paths, [...argv, "--project", projectDir, "--json"], { launch: workers.launch })).out) as { error: ApiError };
      assert.deepEqual(reply.error, printed.error);
    };
    await refused(["run", "nope"], 404, "no_such_workflow");
    await refused(["answer", question!.id, "maybe"], 400, "not_a_choice");
  });

  it("removes a run that ended, and moves a workflow to the trash", async (t) => {
    const { paths, projectDir, workers, server } = await served(t);
    const { asking, ended } = await twoRuns(paths, projectDir, workers);
    const refused = await call(server, `/api/runs/${asking}`, { method: "DELETE" });
    assert.equal(refused.status, 409, refused.text);
    const removed = await call(server, `/api/runs/${ended}`, { method: "DELETE" });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.json.removed, ended);
    assert.deepEqual(listRuns(paths).map((view) => view.record.runId), [asking]);

    const trashed = await call(server, "/api/workflows/old/trash", { method: "POST" });
    assert.equal(trashed.status, 200, trashed.text);
    assert.equal(typeof trashed.json.trash, "string");
    const names = ((await call(server, "/api/workflows")).json as WorkflowRow[]).map((row) => row.name).sort();
    assert.deepEqual(names, ["greet", "ship"]);
  });
});

describe("a step that took more than one try", () => {
  it("shows its tries on the run page", async (t) => {
    const { paths, projectDir } = testHome({ flaky });
    // The first try fails with an error a retry can fix, and the second gives the answer.
    const { runner } = fakeRunner((_step, calls) => {
      if (calls.length === 1) throw new WorkflowError("transient", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
      return "ok";
    });
    const workers = inProcess({ inner: runner });
    const server = await startServer({ paths, project: projectDir, port: 0, host: "127.0.0.1", launch: workers.launch, commands: COMMANDS });
    t.after(() => server.close());
    const runId = startRun(paths, workers.launch, { who: PERSON, workflow: "flaky", projectDir, inputs: {} }).runId;
    assert.equal((await workers.ended(runId))?.status, "completed");

    const page: RunPage = (await call(server, `/api/runs/${runId}`)).json;
    assert.deepEqual(page.steps.map((step) => [step.name, step.status, step.tries]), [["flaky", "done", 2]]);
  });
});

describe("the live stream of sous serve", () => {
  it("says hello, sends nothing while nothing changes, then names a run within a second of its change", async (t) => {
    const { paths, projectDir, workers, server } = await served(t);
    const live = listen(server);
    t.after(() => live.close());
    await waitFor(() => live.events.length > 0, "the hello");
    assert.equal(live.events[0]!.type, "hello");
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(live.events.length, 1, "nothing changed, so nothing came");

    const started = Date.now();
    const { runId } = startRun(paths, workers.launch, { who: PERSON, workflow: "greet", projectDir, inputs: { who: "Ada" } });
    const named = () => live.events.find((event) => event.type === "changed" && event.runs.includes(runId));
    await waitFor(() => named() !== undefined, "a changed event that names the run");
    assert.ok(Date.now() - started < 1500, `the event came ${Date.now() - started} ms after the start`);
    const changed = named() as Extract<LiveEvent, { type: "changed" }>;
    assert.equal(changed.workflows, true, "a new run changes its workflow's row");
    await workers.ended(runId);
  });
});

describe("the live feed", () => {
  it("drops a page whose first read fails, so the next page still gets changes", async (t) => {
    const { paths } = testHome({});
    let reads = 0;
    let workflows = "a";
    const read = () => {
      if (reads++ === 0) throw new Error("moved");
      return workflows;
    };
    const feed = new LiveFeed(paths, { workflows: read, catalog: () => "" }, { pollMs: 20 });
    t.after(() => feed.close());
    const quiet = { send: () => {}, ping: () => {} };
    assert.throws(() => feed.add(quiet), /moved/);

    const events: LiveEvent[] = [];
    feed.add({ send: (event) => events.push(event), ping: () => {} });
    workflows = "b";
    await waitFor(() => events.some((event) => event.type === "changed" && event.workflows), "a change after the failed page");
  });
});

// Piece 9, workflow approval. An agent may write a workflow, with the person's consent. sous
// refuses a start through an agent, a step of a run or a schedule until a yes is recorded for the
// workflow's exact text, by hash, with `sous workflows approve <name> --by person`. A person's own
// `sous run` approves the texts it runs. At first use, every workflow of every known project and
// of the home is approved as seeded (brief, decision 2). A scheduled run of an edited workflow is
// refused, the daemon logs it, and the person gets a notice (brief, decision 3).
//
// The refusal is not_approved with exit 66. Its call is `sous workflows show <name> --diff --json`,
// which piece 10 builds, and its change gives the approve call. These tests assert that text and
// never run the show command.
//
// A refusal adds no line to events.jsonl. A person's run adds its one run line and no
// approve-workflow line, so piece 7's count of one line per write holds. The files are read raw.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listRecords, loadRecord, readRun, rememberProject, type HomePaths, type Launcher } from "@sous-run/engine";
import { fakeRunner, inProcess, testHome, tick, type InnerRunner, type InProcessWorkers } from "@sous-run/engine/testing";
import { sous } from "./sous.js";

type Through =
  | { kind: "person" }
  | { kind: "agent"; program: "claude" | "codex"; session?: string }
  | { kind: "run"; runId: string }
  | { kind: "schedule"; schedule: string };
interface Action {
  at: string;
  act: string;
  by: string;
  through: Through;
  runId?: string;
  workflow?: string;
  hash?: string;
  [key: string]: unknown;
}

/** The keys the design gives a line of events.jsonl. */
const ACTION_KEYS = new Set(["at", "act", "by", "through", "runId", "workflow", "question", "step", "value", "text", "hash"]);

const PERSON: NodeJS.ProcessEnv = {};
const CLAUDE: NodeJS.ProcessEnv = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };
const CODEX: NodeJS.ProcessEnv = { CODEX_THREAD_ID: "t1" };
const RUN_STEP: NodeJS.ProcessEnv = { SOUS_RUN_ID: "r1", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };

const HELLO = readFileSync(join(import.meta.dirname, "fixtures", "workflows", "hello.js"), "utf8");
const FAILS = readFileSync(join(import.meta.dirname, "fixtures", "workflows", "fails.js"), "utf8");

/** A workflow with no input that runs one sh step and returns `result`. */
const plain = (name: string, result = `${name} ran`, step = "echo ok") =>
  `export const meta = { name: "${name}", description: "${name}", place: "none" }\n\nawait sh(${JSON.stringify(step)}, { label: "${name} step" })\nreturn ${JSON.stringify(result)}\n`;
/** A workflow that starts the saved workflow "other" by a name written in the file. */
const OUTER = `export const meta = { name: "outer", description: "Run other", place: "none" }\n\nconst inner = await workflow("other", {})\nreturn { inner }\n`;
/** A workflow that starts the saved workflow its input names, so the name is made at run time. */
const PICK = `export const meta = {
  name: "pick",
  description: "Run the workflow its input names",
  inputs: { which: { type: "string", description: "The workflow to run", required: true } },
  place: "none",
}

const inner = await workflow(args.which, {})
return { inner }
`;

/** These workflows run sh, js and nested steps, so no agent runs. */
const runner = { run: async () => "unused" } as unknown as InnerRunner;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const workflowFile = (projectDir: string, name: string) => join(projectDir, ".sous", "workflows", `${name}.js`);

function lines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
const actions = (paths: HomePaths) => lines<Action>(join(paths.home, "events.jsonl"));

/** The JSON sous printed. */
function json(printed: { code: number; out: string }): Record<string, any> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  return parsed as Record<string, any>;
}

/** The refusal sous printed, checked against the design's shape. */
function refusal(printed: { code: number; out: string }, code: string, what: string): { code: string; message: string; change: string; call: string | null } {
  assert.equal(printed.code, 66, `${what} exits 66:\n${printed.out}`);
  const { error } = json(printed);
  assert.equal(error?.code, code, `${what}:\n${printed.out}`);
  assert.equal(typeof error.message, "string", printed.out);
  assert.equal(typeof error.change, "string", printed.out);
  return error;
}

/** The not_approved refusal for `name`: its call shows the change, and its change gives the approve call.
 *  A command given --project keeps it in the call, as every call in an error does. */
function notApproved(printed: { code: number; out: string }, name: string, what: string, projectDir?: string): void {
  const error = refusal(printed, "not_approved", what);
  assert.match(error.message, new RegExp(`\\b${name}\\b`), `${what}: the message names ${name}`);
  const project = projectDir === undefined ? "" : ` --project ${projectDir}`;
  assert.equal(error.call, `sous workflows show ${name} --diff --json${project}`, `${what}: the call shows the change`);
  assert.ok(error.change.includes(`sous workflows approve ${name} --by person`), `${what}: the change gives the approve call: ${error.change}`);
}

/** The one line a write added since `before` lines, checked against the design's shape. */
function oneNew(paths: HomePaths, before: number, what: string): Action {
  const now = actions(paths);
  assert.equal(now.length, before + 1, `${what} adds exactly one line to events.jsonl:\n${now.slice(before).map((line) => JSON.stringify(line)).join("\n")}`);
  const line = now.at(-1)!;
  for (const key of Object.keys(line)) assert.ok(ACTION_KEYS.has(key), `${what}: a line has no key "${key}": ${JSON.stringify(line)}`);
  return line;
}

/** The project's first use of sous by an agent, which seeds the approvals of the project's
 *  workflows as they are now. The project is known, as a person's earlier run would make it. */
async function firstUse(paths: HomePaths, projectDir: string, workers: InProcessWorkers): Promise<void> {
  rememberProject(paths, projectDir);
  const run = await sous(paths, ["run", "hello", "--name", "Ada", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
  assert.equal(run.code, 0, `an agent runs the existing hello at first use, which the seed approved:\n${run.out}`);
  assert.equal((await workers.ended(json(run).runId as string))?.status, "completed");
}

/** Start a run and wait for its worker. Fails when sous refuses it. */
async function ran(paths: HomePaths, env: NodeJS.ProcessEnv, argv: string[], workers: InProcessWorkers): Promise<string> {
  const run = await sous(paths, [...argv, "--json"], { env, launch: workers.launch });
  assert.equal(run.code, 0, `${argv.join(" ")}:\n${run.out}`);
  const runId = json(run).runId as string;
  await workers.ended(runId).catch(() => undefined);
  return runId;
}

/** How a run's worker ended: its status, or "threw", and every word it left in the log and the run's view. */
async function outcome(paths: HomePaths, workers: InProcessWorkers, runId: string): Promise<{ status: string; text: string }> {
  const ended = await workers.ended(runId).then(
    (result) => ({ status: result?.status ?? "none", text: JSON.stringify(result ?? null) }),
    (error: unknown) => ({ status: "threw", text: error instanceof Error ? error.message : String(error) }),
  );
  const logPath = join(paths.logs, `${runId}.log`);
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  let view = "";
  try {
    view = JSON.stringify(readRun(paths, runId));
  } catch {
    // A run with no view says it in the log.
  }
  return { status: ended.status, text: `${ended.text}\n${log}\n${view}` };
}

/** Let every worker the test started end, so none outlives it. */
async function settle(workers: InProcessWorkers): Promise<void> {
  for (const { runId } of workers.launched) await workers.ended(runId).catch(() => undefined);
}

describe("piece 9: an agent runs a new workflow", () => {
  it("an agent's run of a new greet.js exits 66 not_approved with the show --diff call, and starts nothing", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(workflowFile(projectDir, "greet"), plain("greet"));
      const launched = workers.launched.length;
      const records = listRecords(paths).length;

      for (const [env, extra] of [
        [CLAUDE, []],
        [CODEX, []],
        // The agent's word that the person agreed is no recorded yes: only `workflows approve` records one.
        [CLAUDE, ["--by", "person"]],
        // A step of a run needs the yes the same way.
        [RUN_STEP, []],
      ] as const) {
        const refused = await sous(paths, ["run", "greet", ...extra, "--json", "--project", projectDir], { env, launch: workers.launch });
        notApproved(refused, "greet", `${JSON.stringify(env)} run greet ${extra.join(" ")}`, projectDir);
      }

      assert.equal(workers.launched.length, launched, "no worker starts");
      assert.equal(listRecords(paths).length, records, "no run record is written");
      assert.deepEqual(
        actions(paths).filter((line) => line.workflow === "greet"),
        [],
        "events.jsonl has no line for greet",
      );
    } finally {
      await settle(workers);
    }
  });

  it("an agent's run of an edited workflow is refused, though the seed approved its earlier text", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(workflowFile(projectDir, "hello"), HELLO.replace("Say hello", "Say hi"));
      const refused = await sous(paths, ["run", "hello", "--name", "Ada", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
      notApproved(refused, "hello", "run of the edited hello", projectDir);
    } finally {
      await settle(workers);
    }
  });

  // Decision 2 seeds the known projects only. A project with no run and no check has no seed, so a
  // workflow an agent writes there before anyone ran sous in it is refused like any new one.
  it("in a project sous never saw, an agent's first run is refused: the seed covers known projects only", async () => {
    const { paths, projectDir } = testHome({ greet: plain("greet") });
    const workers = inProcess({ inner: runner });
    try {
      const refused = await sous(paths, ["run", "greet", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
      notApproved(refused, "greet", "an agent's run in an unknown project", projectDir);
      assert.deepEqual(workers.launched, []);
    } finally {
      await settle(workers);
    }
  });

  it("an agent's run of a workflow file by path is refused the same way", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      const loose = join(mkdtempSync(join(tmpdir(), "sous-loose-")), "loose.js");
      writeFileSync(loose, plain("loose"));
      const refused = await sous(paths, ["run", loose, "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
      const error = refusal(refused, "not_approved", "run by path");
      assert.equal(error.call, `sous workflows show ${loose} --diff --json --project ${projectDir}`, refused.out);
    } finally {
      await settle(workers);
    }
  });

  it("the person's own run of a changed file starts, and approves that text for the agent", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(workflowFile(projectDir, "greet"), plain("greet"));
      notApproved(await sous(paths, ["run", "greet", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch }), "greet", "before the person's run", projectDir);

      const before = actions(paths).length;
      const runId = await ran(paths, PERSON, ["run", "greet", "--project", projectDir], workers);
      assert.equal(readRun(paths, runId).status, "completed");
      const line = oneNew(paths, before, "the person's run");
      assert.equal(line.act, "run", "the person's run adds its run line and no approve-workflow line");
      assert.equal(line.by, "person");

      const again = await sous(paths, ["run", "greet", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
      assert.equal(again.code, 0, `the agent's run of the text the person ran starts:\n${again.out}`);
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 9: sous workflows approve", () => {
  it("from an agent it exits 66 needs_person. With --by person it exits 0, adds one approve-workflow line, and the run starts", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      const text = plain("greet");
      writeFileSync(workflowFile(projectDir, "greet"), text);
      const before = actions(paths).length;

      const refused = await sous(paths, ["workflows", "approve", "greet", "--json", "--project", projectDir], { env: CLAUDE });
      const error = refusal(refused, "needs_person", "an agent's approve without --by person");
      assert.match(String(error.call), /^sous workflows approve greet .*--by person/, refused.out);
      assert.equal(actions(paths).length, before, "the refused approve adds no line");
      notApproved(await sous(paths, ["run", "greet", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch }), "greet", "the run after the refused approve", projectDir);

      const approved = await sous(paths, ["workflows", "approve", "greet", "--by", "person", "--json", "--project", projectDir], { env: CLAUDE });
      assert.equal(approved.code, 0, approved.out);
      json(approved);
      const line = oneNew(paths, before, "workflows approve greet --by person");
      assert.equal(line.act, "approve-workflow");
      assert.equal(line.workflow, "greet");
      assert.equal(line.hash, sha256(text));
      assert.equal(line.by, "person");
      assert.deepEqual(line.through, { kind: "agent", program: "claude", session: "s1" });

      const runId = await ran(paths, CLAUDE, ["run", "greet", "--project", projectDir], workers);
      assert.equal(readRun(paths, runId).status, "completed");
    } finally {
      await settle(workers);
    }
  });

  it("the person approves at their terminal with no --by. Approving the same text again exits 0 with a note and adds no line", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(workflowFile(projectDir, "greet"), plain("greet"));
      const before = actions(paths).length;

      const approved = await sous(paths, ["workflows", "approve", "greet", "--json", "--project", projectDir], { env: PERSON });
      assert.equal(approved.code, 0, approved.out);
      const line = oneNew(paths, before, "the person's workflows approve greet");
      assert.equal(line.act, "approve-workflow");
      assert.equal(line.by, "person");
      assert.deepEqual(line.through, { kind: "person" });

      const again = await sous(paths, ["workflows", "approve", "greet", "--json", "--project", projectDir], { env: PERSON });
      assert.equal(again.code, 0, again.out);
      assert.ok((json(again).notes as string[] | undefined)?.length, `a note says the text was approved already: ${again.out}`);
      assert.equal(actions(paths).length, before + 1, "approving an approved text adds no line");
    } finally {
      await settle(workers);
    }
  });

  it("--all --by person approves each changed workflow of the project and the home, one line each, and leaves the others", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(workflowFile(projectDir, "greet"), plain("greet"));
      mkdirSync(paths.workflows, { recursive: true });
      writeFileSync(join(paths.workflows, "tidy.js"), plain("tidy"));
      const before = actions(paths).length;

      const approved = await sous(paths, ["workflows", "approve", "--all", "--by", "person", "--json", "--project", projectDir], { env: CLAUDE });
      assert.equal(approved.code, 0, approved.out);
      const added = actions(paths).slice(before);
      assert.deepEqual(added.map((line) => line.act), ["approve-workflow", "approve-workflow"], JSON.stringify(added));
      assert.deepEqual(added.map((line) => line.workflow).sort(), ["greet", "tidy"], "hello did not change, so it gets no line");
      for (const line of added) assert.equal(line.by, "person");

      for (const name of ["greet", "tidy"]) await ran(paths, CLAUDE, ["run", name, "--project", projectDir], workers);
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 9: the dry run", () => {
  it("check greet --dry-run from the agent runs without approval, and approves nothing", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(workflowFile(projectDir, "greet"), plain("greet"));
      const before = actions(paths).length;

      const checked = await sous(paths, ["check", "greet", "--dry-run", "--json", "--project", projectDir], { env: CLAUDE });
      assert.equal(checked.code, 0, checked.out);
      assert.equal(json(checked).dryRun?.status, "completed", checked.out);
      assert.equal(actions(paths).length, before, "a dry run records no line");

      notApproved(await sous(paths, ["run", "greet", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch }), "greet", "the run after the dry run", projectDir);
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 9: nested workflows", () => {
  it("a workflow whose static workflow(\"other\") is unapproved is refused, and the refusal names other", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, outer: OUTER });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(workflowFile(projectDir, "other"), plain("other"));
      const launched = workers.launched.length;

      const refused = await sous(paths, ["run", "outer", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
      notApproved(refused, "other", "an agent's run of outer, which starts the new other", projectDir);
      assert.equal(workers.launched.length, launched, "no worker starts");
      assert.deepEqual(actions(paths).filter((line) => line.workflow === "outer"), []);
    } finally {
      await settle(workers);
    }
  });

  it("the person's run of outer approves outer and the other it names, so the agent's run then starts", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, outer: OUTER });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(workflowFile(projectDir, "outer"), OUTER.replace("Run other", "Run the other one"));
      writeFileSync(workflowFile(projectDir, "other"), plain("other"));
      notApproved(await sous(paths, ["run", "outer", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch }), "outer", "the agent's run before the person's", projectDir);
      const mine = await ran(paths, PERSON, ["run", "outer", "--project", projectDir], workers);
      assert.equal(readRun(paths, mine).status, "completed");

      const theirs = await ran(paths, CLAUDE, ["run", "outer", "--project", projectDir], workers);
      assert.equal(readRun(paths, theirs).status, "completed");
    } finally {
      await settle(workers);
    }
  });

  it("an agent's run of an approved workflow fails at workflow(name) when the name, made at run time, is unapproved", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, pick: PICK });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      const marker = join(mkdtempSync(join(tmpdir(), "sous-marker-")), "other-ran");
      writeFileSync(workflowFile(projectDir, "other"), plain("other", "other ran", `touch '${marker}'`));

      const run = await sous(paths, ["run", "pick", "--which", "other", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
      assert.equal(run.code, 0, `pick is approved and names no workflow in its text, so it starts:\n${run.out}`);
      const runId = json(run).runId as string;
      const ended = await outcome(paths, workers, runId);
      assert.notEqual(ended.status, "completed", `the run stops at workflow("other"):\n${ended.text}`);
      assert.equal(existsSync(marker), false, "other's step never ran");
      assert.match(ended.text, /\bother\b/, "the failure names other");
      assert.match(ended.text, /not_approved|approv/i, "the failure says other has no approval");

      // With other approved, the same run goes through, so the fixture itself works.
      assert.equal((await sous(paths, ["workflows", "approve", "other", "--json", "--project", projectDir], { env: PERSON })).code, 0);
      const next = await ran(paths, CLAUDE, ["run", "pick", "--which", "other", "--project", projectDir], workers);
      assert.equal(readRun(paths, next).status, "completed");
      assert.equal(existsSync(marker), true);
    } finally {
      await settle(workers);
    }
  });

  it("choose() in an agent's run offers approved workflows only, and in the person's run offers the new one too", async () => {
    const picker = `export const meta = { name: "picker", description: "Let an agent pick", place: "none" }\n\nreturn await choose("Pick one", { any: true })\n`;
    const { paths, projectDir } = testHome({ hello: HELLO, picker, open: plain("open") });
    const { runner: chooser, calls } = fakeRunner(() => ({ choice: "open", reason: "it is open" }));
    const workers = inProcess({ inner: chooser });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(workflowFile(projectDir, "fresh"), plain("fresh"));

      const theirs = await ran(paths, CLAUDE, ["run", "picker", "--project", projectDir], workers);
      assert.equal(readRun(paths, theirs).status, "completed");
      const offered = calls.at(-1)!.prompt;
      assert.match(offered, /- open\b/, offered);
      assert.doesNotMatch(offered, /\bfresh\b/, `the agent's run does not offer the unapproved fresh:\n${offered}`);

      await ran(paths, PERSON, ["run", "picker", "--project", projectDir], workers);
      assert.match(calls.at(-1)!.prompt, /\bfresh\b/, "the person's run offers every workflow");
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 9: the hash at worker start", () => {
  it("the record keeps the hash, and a file changed after create fails the run at worker start with a message naming the file", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, greet: plain("greet") });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      const file = workflowFile(projectDir, "greet");
      const text = readFileSync(file, "utf8");
      const marker = join(mkdtempSync(join(tmpdir(), "sous-marker-")), "edited-ran");
      // The edit lands between the check in createRun and the worker's start.
      const launch: Launcher = (home, runId, mode) => {
        writeFileSync(file, plain("greet", "edited", `touch '${marker}'`));
        workers.launch(home, runId, mode);
      };

      const run = await sous(paths, ["run", "greet", "--json", "--project", projectDir], { env: CLAUDE, launch });
      assert.equal(run.code, 0, run.out);
      const runId = json(run).runId as string;
      const record = loadRecord(paths, runId) as unknown as { workflowHash?: string };
      assert.equal(record.workflowHash, sha256(text), "the record keeps the hash of the text sous checked");

      const ended = await outcome(paths, workers, runId);
      assert.notEqual(ended.status, "completed", ended.text);
      assert.equal(existsSync(marker), false, "the edited text never ran");
      assert.ok(ended.text.includes(file), `the failure names ${file}:\n${ended.text}`);
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 9: rerun and resume --latest", () => {
  it("an agent's rerun of a run whose workflow changed since is refused", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, greet: plain("greet") });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      const first = await ran(paths, PERSON, ["run", "greet", "--project", projectDir], workers);
      writeFileSync(workflowFile(projectDir, "greet"), plain("greet", "changed"));
      const launched = workers.launched.length;

      notApproved(await sous(paths, ["rerun", first, "--json"], { env: CLAUDE, launch: workers.launch }), "greet", "an agent's rerun");
      assert.equal(workers.launched.length, launched);
    } finally {
      await settle(workers);
    }
  });

  it("an agent's resume --latest of a run whose workflow changed since is refused, and the run stays paused", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, fails: FAILS });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      const runId = await ran(paths, PERSON, ["run", "fails", "--project", projectDir], workers);
      assert.equal(readRun(paths, runId).status, "paused");
      writeFileSync(workflowFile(projectDir, "fails"), FAILS.replace("exit 3", "exit 0"));
      const launched = workers.launched.length;

      notApproved(await sous(paths, ["resume", runId, "--latest", "--json"], { env: CLAUDE, launch: workers.launch }), "fails", "an agent's resume --latest");
      assert.equal(workers.launched.length, launched);
      assert.equal(readRun(paths, runId).status, "paused");
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 9: schedules", () => {
  // The daemon starts a schedule as sous, through the schedule. An edited workflow has no yes for
  // its text, so the start is refused: the daemon logs it and tells the person, who approves it
  // once or runs it once by hand. A schedule's project counts as known for the seed.
  it("the daemon refuses an edited scheduled workflow, logs it and sends one notice, and starts the unchanged one", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, tidy: plain("tidy") });
    const schedules = (suffix: string) =>
      JSON.stringify([
        { name: `hello-${suffix}`, workflow: "hello", projectDir, cron: "* * * * *", inputs: { name: "Ada" }, enabled: true, createdAt: new Date().toISOString() },
        { name: `tidy-${suffix}`, workflow: "tidy", projectDir, cron: "* * * * *", inputs: {}, enabled: true, createdAt: new Date().toISOString() },
      ]);
    const spawned: string[] = [];
    const logged: string[] = [];
    const notices: Array<{ title: string; body: string }> = [];
    const deps = { log: (line: string) => logged.push(line), notify: (title: string, body: string) => notices.push({ title, body }) };
    const launch: Launcher = (_paths, runId) => spawned.push(runId);

    // The first tick is the first use: the seed approves both, and both start.
    writeFileSync(paths.schedules, schedules("first"));
    tick(paths, launch, deps);
    assert.equal(spawned.length, 2, logged.join("\n"));

    // The schedules get new names, so the runs above, which never ran, do not hold them back.
    writeFileSync(workflowFile(projectDir, "hello"), HELLO.replace("Say hello", "Say hi"));
    writeFileSync(paths.schedules, schedules("second"));
    const before = actions(paths).length;
    notices.length = 0;
    tick(paths, launch, deps);

    assert.equal(spawned.length, 3, `only tidy starts:\n${logged.join("\n")}`);
    const added = actions(paths).slice(before);
    assert.deepEqual(added.map((line) => [line.act, line.workflow]), [["run", "tidy"]], JSON.stringify(added));
    assert.ok(
      logged.some((line) => line.includes("hello-second") && /approv/i.test(line)),
      `the daemon logs the refusal:\n${logged.join("\n")}`,
    );
    assert.equal(notices.length, 1, JSON.stringify(notices));
    const [notice] = notices;
    assert.match(`${notice!.title} ${notice!.body}`, /\bhello\b/, JSON.stringify(notice));
    assert.ok(notice!.body.includes("sous workflows approve hello"), `the notice gives the person the approve command: ${JSON.stringify(notice)}`);
  });
});

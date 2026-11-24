// Piece 9, workflow approval, after its review. The worker runs only the text sous checked: it
// reads the file once, at a start and at `sous resume --latest`, and refuses a text whose hash
// differs. A dry run left behind never resumes as a real run. The seed runs once per home, at the
// first command or at the service's start, and a missing approvals.json after it approves nothing.
// A scheduled workflow with no yes gets one notice per edit.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readRun, rememberProject, type HomePaths, type Launcher } from "@sous/engine";
import { createRun, inProcess, plantState, testHome, tick, type InnerRunner, type InProcessWorkers } from "@sous/engine/testing";
import { sous } from "./sous.js";

const PERSON: NodeJS.ProcessEnv = {};
const CLAUDE: NodeJS.ProcessEnv = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };

const HELLO = readFileSync(join(import.meta.dirname, "fixtures", "workflows", "hello.js"), "utf8");
const FAILS = readFileSync(join(import.meta.dirname, "fixtures", "workflows", "fails.js"), "utf8");

/** A workflow with no input that runs one sh step and returns `result`. */
const plain = (name: string, result = `${name} ran`, step = "echo ok") =>
  `export const meta = { name: "${name}", description: "${name}", place: "none" }\n\nawait sh(${JSON.stringify(step)}, { label: "${name} step" })\nreturn ${JSON.stringify(result)}\n`;
/** A workflow that runs every minute. */
const NAG = `export const meta = { name: "nag", description: "nag", place: "none", schedule: "* * * * *" }\n\nreturn 1\n`;

/** These workflows run sh and nested steps, so no agent runs. */
const runner = { run: async () => "unused" } as unknown as InnerRunner;

const workflowFile = (projectDir: string, name: string) => join(projectDir, ".sous", "workflows", `${name}.js`);
/** A file the edited text creates, in a folder of its own, so the test sees whether it ran. */
const marker = () => join(mkdtempSync(join(tmpdir(), "sous-marker-")), "edited-ran");

function json(printed: { code: number; out: string }): Record<string, any> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  return parsed as Record<string, any>;
}

function refusal(printed: { code: number; out: string }, code: string, what: string): { code: string; message: string; change: string; call: string | null } {
  assert.equal(printed.code, 66, `${what} exits 66:\n${printed.out}`);
  const { error } = json(printed);
  assert.equal(error?.code, code, `${what}:\n${printed.out}`);
  return error;
}

/** sous's first use in the project: the person's own run of hello, which seeds the approvals. */
async function firstUse(paths: HomePaths, projectDir: string, workers: InProcessWorkers): Promise<void> {
  rememberProject(paths, projectDir);
  const run = await sous(paths, ["run", "hello", "--name", "Ada", "--json", "--project", projectDir], { env: PERSON, launch: workers.launch });
  assert.equal(run.code, 0, run.out);
  await workers.ended(json(run).runId);
}

async function settle(workers: InProcessWorkers): Promise<void> {
  for (const { runId } of workers.launched) await workers.ended(runId).catch(() => undefined);
}

/** The run as `sous show --json` gives it to the agent. */
async function shown(paths: HomePaths, runId: string): Promise<Record<string, any>> {
  const show = await sous(paths, ["show", runId, "--json"], { env: CLAUDE });
  assert.equal(show.code, 0, show.out);
  return json(show);
}

const calls = (show: Record<string, any>): string[] => (show.next ?? []).map((next: { call: string }) => next.call);

describe("piece 9 review: the worker runs the text sous checked", () => {
  it("an edit between an approved resume --latest and the worker never runs, and the run does not complete", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, fails: FAILS });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      const run = await sous(paths, ["run", "fails", "--json", "--project", projectDir], { env: PERSON, launch: workers.launch });
      const runId = json(run).runId as string;
      await workers.ended(runId).catch(() => undefined);
      assert.equal(readRun(paths, runId).status, "paused");
      // The person approves an edit that fixes the failing step.
      const file = workflowFile(projectDir, "fails");
      writeFileSync(file, FAILS.replace("exit 3", "exit 0"));
      const approved = await sous(paths, ["workflows", "approve", "fails", "--project", projectDir, "--json"], { env: PERSON });
      assert.equal(approved.code, 0, approved.out);
      const edited = marker();
      // The next edit lands after the check in resume and before the worker reads the file.
      const launch: Launcher = (home, id, mode) => {
        writeFileSync(file, FAILS.replace("exit 3", `touch '${edited}'`));
        workers.launch(home, id, mode);
      };

      const resumed = await sous(paths, ["resume", runId, "--latest", "--json"], { env: CLAUDE, launch });
      assert.equal(resumed.code, 0, resumed.out);
      await workers.ended(runId).catch(() => undefined);

      assert.equal(existsSync(edited), false, "the edited text never ran");
      assert.notEqual(readRun(paths, runId).status, "completed");
      const show = await shown(paths, runId);
      assert.ok(String(show.failure?.message).includes(file), `show's failure names ${file}: ${JSON.stringify(show.failure)}`);
    } finally {
      await settle(workers);
    }
  });

  it("an edit after the worker's check, as it logs the start, never runs: the worker runs the text it checked", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, greet: plain("greet") });
    const edited = marker();
    const workers = inProcess({
      inner: runner,
      log: (line) => {
        if (/ run +greet /.test(line)) writeFileSync(workflowFile(projectDir, "greet"), plain("greet", "edited", `touch '${edited}'`));
      },
    });
    try {
      await firstUse(paths, projectDir, workers);
      const run = await sous(paths, ["run", "greet", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
      assert.equal(run.code, 0, run.out);
      const result = await workers.ended(json(run).runId as string);

      assert.equal(existsSync(edited), false, "the edited text never ran");
      assert.equal(result?.status, "completed");
      assert.equal(result?.result, "greet ran");
    } finally {
      await settle(workers);
    }
  });

  it("a start the worker refused gives show a failure naming the file, and a rerun as the next call", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, greet: plain("greet") });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      const file = workflowFile(projectDir, "greet");
      const launch: Launcher = (home, id, mode) => {
        writeFileSync(file, plain("greet", "edited"));
        workers.launch(home, id, mode);
      };
      const run = await sous(paths, ["run", "greet", "--json", "--project", projectDir], { env: CLAUDE, launch });
      assert.equal(run.code, 0, run.out);
      const runId = json(run).runId as string;
      await workers.ended(runId).catch(() => undefined);

      const show = await shown(paths, runId);
      assert.ok(String(show.failure?.message).includes(file), `show's failure names ${file}: ${JSON.stringify(show)}`);
      assert.ok(calls(show).includes(`sous rerun ${runId} --json`), `show offers the rerun: ${JSON.stringify(show.next)}`);
      assert.ok(!calls(show).some((call) => call.startsWith("sous resume")), `show offers no resume: ${JSON.stringify(show.next)}`);
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 9 review: a dry run left behind", () => {
  /** A dry run of a new workflow whose process died mid run: its record and a running state. */
  function leftBehind(paths: HomePaths, projectDir: string): string {
    writeFileSync(workflowFile(projectDir, "sneaky"), plain("sneaky"));
    const record = createRun(paths, {
      workflow: "sneaky",
      projectDir,
      inputs: {},
      place: "none",
      origin: "check",
      who: { by: "agent", through: { kind: "agent", program: "claude", session: "s1" } },
    });
    const now = new Date().toISOString();
    plantState(paths, { runId: record.runId, status: "running", script: plain("sneaky"), startedAt: now, updatedAt: now, agents: [], logs: [], phases: [] });
    return record.runId;
  }

  it("does not resume as a real run: resume is refused with the dry run's call, and no worker starts", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      const runId = leftBehind(paths, projectDir);
      assert.equal(readRun(paths, runId).status, "interrupted");
      const launched = workers.launched.length;

      for (const env of [CLAUDE, PERSON]) {
        const error = refusal(await sous(paths, ["resume", runId, "--json"], { env, launch: workers.launch }), "cannot_resume", "the resume of a dry run");
        assert.equal(error.call, "sous check sneaky --dry-run --json");
      }
      assert.equal(workers.launched.length, launched, "no worker started");
    } finally {
      await settle(workers);
    }
  });

  it("show offers the dry run again and no resume, and the service sends no cut-off notice", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      const runId = leftBehind(paths, projectDir);

      const show = await shown(paths, runId);
      assert.ok(!calls(show).some((call) => call.startsWith("sous resume")), `show offers no resume: ${JSON.stringify(show.next)}`);
      assert.ok(calls(show).includes("sous check sneaky --dry-run --json"), `show offers the dry run: ${JSON.stringify(show.next)}`);

      const notices: string[] = [];
      const spawned: string[] = [];
      tick(paths, (_paths, id) => spawned.push(id), { log: () => {}, notify: (title) => notices.push(title) });
      assert.deepEqual(notices, []);
      assert.deepEqual(spawned, []);
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 9 review: the approvals file", () => {
  it("moved away after the seed, it approves nothing: the agent's run of a new workflow is still refused", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(workflowFile(projectDir, "greet"), plain("greet"));
      renameSync(paths.approvals, join(mkdtempSync(join(tmpdir(), "sous-moved-")), "approvals.json"));
      const launched = workers.launched.length;

      refusal(await sous(paths, ["run", "greet", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch }), "not_approved", "the run after the move");
      refusal(await sous(paths, ["run", "hello", "--name", "Ada", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch }), "not_approved", "the seeded workflow after the move");
      assert.equal(workers.launched.length, launched, "no worker started");
    } finally {
      await settle(workers);
    }
  });

  it("broken, it gives broken_record with exit 66, which names the file, and starts nothing", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(paths.approvals, "{ broken");
      const launched = workers.launched.length;

      const error = refusal(await sous(paths, ["run", "hello", "--name", "Ada", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch }), "broken_record", "the run with a broken file");
      assert.ok(error.message.includes(paths.approvals), error.message);
      assert.equal(workers.launched.length, launched, "no worker started");
    } finally {
      await settle(workers);
    }
  });

  it("the seed approves files by path, whatever their names, so an agent's run of each by path starts", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, _draft: plain("draft"), "a+b": plain("ab") });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      for (const name of ["_draft", "a+b"]) {
        const run = await sous(paths, ["run", workflowFile(projectDir, name), "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
        assert.equal(run.code, 0, `${name}: ${run.out}`);
      }
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 9 review: the refusal", () => {
  it("names every workflow with no yes, the root and the one it calls, and its change keeps --project", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await firstUse(paths, projectDir, workers);
      writeFileSync(workflowFile(projectDir, "other"), plain("other"));
      writeFileSync(
        workflowFile(projectDir, "outer"),
        `export const meta = { name: "outer", description: "Run other", place: "none" }\n\nconst inner = await workflow("other", {})\nreturn { inner }\n`,
      );

      const error = refusal(await sous(paths, ["run", "outer", "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch }), "not_approved", "the run of outer");
      assert.match(error.message, /\bouter\b/);
      assert.match(error.message, /\bother\b/);
      for (const name of ["outer", "other"]) {
        assert.ok(error.change.includes(`sous workflows approve ${name} --by person --json --project ${projectDir}`), `the change approves ${name} in the project: ${error.change}`);
      }
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 9 review: the seed and the schedules", () => {
  const minute = (m: number) => new Date(`2026-11-24T10:${String(m).padStart(2, "0")}:05Z`);

  it("the person's first command seeds, so a scheduled workflow an agent adds after it does not start", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    rememberProject(paths, projectDir);
    const status = await sous(paths, ["status", "--json"], { env: PERSON });
    assert.equal(status.code, 0, status.out);
    writeFileSync(workflowFile(projectDir, "nag"), NAG);
    const spawned: string[] = [];
    const notices: string[] = [];

    tick(paths, (_paths, id) => spawned.push(id), { now: minute(1), log: () => {}, notify: (title) => notices.push(title) });

    assert.deepEqual(spawned, [], "nag does not start");
    assert.equal(notices.length, 1, JSON.stringify(notices));
  });

  it("the person hears once of each edit, however often the schedule comes due", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    rememberProject(paths, projectDir);
    assert.equal((await sous(paths, ["status", "--json"], { env: PERSON })).code, 0);
    writeFileSync(workflowFile(projectDir, "nag"), NAG);
    const spawned: string[] = [];
    const notices: Array<{ title: string; body: string }> = [];
    const at = (m: number) => tick(paths, (_paths, id) => spawned.push(id), { now: minute(m), log: () => {}, notify: (title, body) => notices.push({ title, body }) });

    for (let m = 1; m <= 5; m++) at(m);
    assert.equal(notices.length, 1, JSON.stringify(notices));
    assert.ok(notices[0]!.body.includes(`sous workflows approve nag --project ${projectDir}`), JSON.stringify(notices[0]));

    writeFileSync(workflowFile(projectDir, "nag"), NAG.replace("return 1", "return 2"));
    for (let m = 6; m <= 8; m++) at(m);
    assert.equal(notices.length, 2, `a new edit gets one more notice: ${JSON.stringify(notices)}`);
    assert.deepEqual(spawned, []);
  });

  it("quotes a project path with a space in the notice", async () => {
    const { paths, projectDir: base } = testHome({ hello: HELLO });
    const projectDir = join(base, "my project");
    mkdirSync(join(projectDir, ".sous", "workflows"), { recursive: true });
    rememberProject(paths, projectDir);
    assert.equal((await sous(paths, ["status", "--json"], { env: PERSON })).code, 0);
    writeFileSync(workflowFile(projectDir, "nag"), NAG);
    const notices: string[] = [];

    tick(paths, () => {}, { now: minute(1), log: () => {}, notify: (_title, body) => notices.push(body) });

    assert.equal(notices.length, 1, JSON.stringify(notices));
    assert.ok(notices[0]!.includes(`--project '${projectDir}'`), notices[0]);
  });
});


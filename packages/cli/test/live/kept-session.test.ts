// Live test of phase 2 of the workflow shape: one kept session on each program. A session handle's
// second send goes on in the session its first send opened, so the implementer recalls the word it
// was given. An agent() step between them starts a session of its own and recalls nothing.
//
// It is off by default. It needs Claude Code and Codex and your own logins, so run it from
// packages/cli without test/with-temp-home.mjs, after pnpm build:
//
//   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID SOUS_LIVE_KEPT=1 ../../node_modules/.bin/tsx --test test/live/kept-session.test.ts
//
// Claude Code runs on haiku at low effort, and Codex on gpt-6-luna at low effort. The sous home and
// the git project are new temporary folders, so the test never writes under ~/.sous. Each program
// keeps its sessions under ~/.claude and ~/.codex, as a session opened by hand does. The test logs
// each step's answer, session id and recorded cost, and the run's cost, so a reader can see whether
// a kept turn's cost counts the session's earlier turns again.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, type TestContext } from "node:test";
import { homePaths, listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { git } from "../helpers/git.js";

const ON = process.env.SOUS_LIVE_KEPT === "1";
const WORD = "PELICAN-4417";
const EFFORT = "low";
const REMEMBER = `Remember the code word ${WORD}. Reply with only OK.`;
const REVIEW = "If this conversation gave you a code word, reply with only that word. Otherwise reply with only NONE.";
const RECALL = "Reply with only the code word this conversation gave you, or NONE.";
/** Variables of the caller's shell that would put the run in another home or inside another run. */
const DROPPED = ["SOUS_HOME", "SOUS_RUN_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"];

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The built sous command, the cli package's bin. */
const SOUS = join(PACKAGE, (JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as { bin: { sous: string } }).bin.sous);

const PROGRAMS = [
  { program: "claude", model: "claude/haiku" },
  { program: "codex", model: "codex/gpt-6-luna" },
] as const;

/** The workflow: an implementer handle with two sends, and a reviewer agent() step between them. */
const script = (model: string) => `export const meta = { name: 'kept', description: 'One kept session and one fresh', place: 'none' }
const impl = session({ label: 'implementer', model: '${model}', effort: '${EFFORT}' })
await impl.send(${JSON.stringify(REMEMBER)})
const reviewer = await agent(${JSON.stringify(REVIEW)}, { label: 'reviewer', model: '${model}', effort: '${EFFORT}' })
const recall = await impl.send(${JSON.stringify(RECALL)}, { label: 'recall' })
return { reviewer, recall }`;

/** A new sous home and a git project with one commit and the workflow "kept". */
function world(program: string, model: string): { home: string; project: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `sous-live-kept-${program}-`)));
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({ notify: false }));
  const project = join(dir, "project");
  mkdirSync(join(project, ".sous", "workflows"), { recursive: true });
  git(project, "init", "--quiet", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.com");
  writeFileSync(join(project, "README.md"), "A test project.\n");
  git(project, "add", "README.md");
  git(project, "commit", "--quiet", "-m", "First commit");
  writeFileSync(join(project, ".git", "info", "exclude"), ".sous/\n");
  writeFileSync(join(project, ".sous", "workflows", "kept.js"), script(model));
  return { home, project };
}

/** Runs `sous run kept --wait --json` in the project, on the given home, and gives its exit code
 *  and output. */
function runKept(home: string, project: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of DROPPED) delete env[name];
  env.SOUS_HOME = home;
  const child = spawn(process.execPath, [SOUS, "run", "kept", "--wait", "--json"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((done, fail) => {
    child.on("error", fail);
    child.on("close", (code, signal) => done({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

/** Logs each step's answer, session id and recorded cost, and the run's cost and time. */
function report(t: TestContext, state: NonNullable<ReturnType<typeof readState>>, ms: number): void {
  for (const step of state.agents) {
    const answer = state.journal?.find((entry) => entry.index === step.callIndex)?.result ?? step.resultPreview;
    t.diagnostic(`${step.label}: ${JSON.stringify(answer)}, session ${step.session?.sessionId ?? "?"}, $${step.usage?.cost ?? "?"}, ${step.usage?.total ?? "?"} tokens`);
  }
  t.diagnostic(`run ${state.status}: $${state.tokenUsage?.cost ?? "?"}, ${state.tokenUsage?.total ?? "?"} tokens, ${ms} ms`);
}

describe("one kept session on each program", { skip: ON ? false : "set SOUS_LIVE_KEPT=1 to run it, on your own logins" }, () => {
  for (const { program, model } of PROGRAMS) {
    test(`on ${program}, the implementer recalls the word in one session, and the reviewer starts its own`, { timeout: 600_000 }, async (t) => {
      const { home, project } = world(program, model);
      t.diagnostic(`home ${home}, project ${project}`);
      const start = Date.now();

      const run = await runKept(home, project);

      const ms = Date.now() - start;
      const paths = homePaths(home);
      const records = listRecords(paths);
      assert.equal(records.length, 1, `${run.stdout}\n${run.stderr}`);
      const state = readState(paths, records[0]!.runId);
      assert.ok(state, `no state for run ${records[0]!.runId}`);
      report(t, state, ms);
      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
      assert.equal(state.status, "completed");

      const { reviewer, recall } = (JSON.parse(run.stdout) as { result: { reviewer: string; recall: string } }).result;
      assert.ok(recall.includes(WORD), `the implementer's recall answer is ${JSON.stringify(recall)}`);
      assert.ok(!reviewer.includes(WORD), `the reviewer's answer is ${JSON.stringify(reviewer)}`);

      const session = (label: string) => {
        const steps = state.agents.filter((step) => step.label === label);
        assert.equal(steps.length, 1, `steps labelled ${label}: ${steps.length}`);
        const id = steps[0]!.session?.sessionId;
        assert.ok(id, `the ${label} step recorded no session`);
        return id;
      };
      const [first, review, again] = [session("implementer"), session("reviewer"), session("recall")];
      assert.equal(again, first);
      assert.notEqual(review, first);
    });
  }
});

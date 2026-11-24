// Piece 8, questions, review fixes. An agent that passes on the person's --let-agent-answer, on a
// start, a rerun or a resume, sends the person a notice, as an agent's answer does. The notices go
// to a fake teller, so no macOS notice shows.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Who } from "../../src/runs/actions.js";
import { rememberProject } from "../../src/runs/home.js";
import { readQuestion, type Question } from "../../src/runs/inbox.js";
import { createRun } from "../../src/runs/launch.js";
import { answerQuestion, rerunRun, resumeRun } from "../../src/runs/run.js";
import { PERSON, plantState, testHome } from "../../src/testing.js";

const PASSED_ON: Who = { by: "person", through: { kind: "agent", program: "claude", session: "s1" } };
const AGENT: Who = { by: "agent", through: { kind: "agent", program: "claude", session: "s1" } };
const job = `export const meta = { name: 'job', description: 'j' }\nreturn 1`;

/** A teller that keeps each notice as "title: message". */
function fakeTell(): { told: string[]; tell: (title: string, message: string) => void } {
  const told: string[] = [];
  return { told, tell: (title, message) => told.push(`${title}: ${message}`) };
}

const passedOn = (runId: string) => `sous: your decision was passed on: Claude Code passed on your decision: it let agents answer the questions in run ${runId}.`;

describe("piece 8 review: the --let-agent-answer notice", () => {
  it("a start an agent passes on tells the person, and the person's own start tells nothing", () => {
    const { paths, projectDir } = testHome({ job });
    // sous has run in this project before, so piece 9's seed approved job as it is.
    rememberProject(paths, projectDir);
    const { told, tell } = fakeTell();
    const passed = createRun(paths, { who: PASSED_ON, workflow: "job", projectDir, inputs: {}, letAgentAnswer: true, tell });
    assert.deepEqual(told, [passedOn(passed.runId)]);
    createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {}, letAgentAnswer: true, tell });
    assert.equal(told.length, 1, "the person's own start sends no notice");
  });

  it("a rerun and a resume an agent passes on tell the person", () => {
    const { paths, projectDir } = testHome({ job });
    const { told, tell } = fakeTell();
    const first = createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {} });
    const rerun = rerunRun(paths, () => {}, first.runId, { place: "folder", who: PASSED_ON, letAgentAnswer: true, tell });
    assert.deepEqual(told, [passedOn(rerun.runId)]);

    const at = new Date().toISOString();
    plantState(paths, { runId: first.runId, status: "paused", pauseReason: "interrupted", startedAt: at, updatedAt: at, agents: [], logs: [], phases: [], script: readFileSync(first.file, "utf8") });
    const resumed = resumeRun(paths, () => {}, first.runId, PASSED_ON, { letAgentAnswer: { command: `sous resume ${first.runId} --let-agent-answer` }, tell });
    assert.ok("resumed" in resumed, JSON.stringify(resumed));
    assert.deepEqual(told, [passedOn(rerun.runId), passedOn(first.runId)]);
  });

  it("an agent's own answer tells the person through the same teller", () => {
    const { paths, projectDir } = testHome({ job });
    const { told, tell } = fakeTell();
    const run = createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {} });
    const id = `${run.runId}--0`;
    const planted: Question = { id, runId: run.runId, scope: run.runId, callIndex: 0, hash: "h0", workflow: "job", prompt: "Which color?", kind: "select", choices: ["red", "blue"], breakpoint: false, answeredBy: "anyone", askedAt: new Date().toISOString() };
    writeFileSync(join(paths.inbox, `${id}.json`), JSON.stringify(planted));
    answerQuestion(paths, readQuestion(paths, id)!, { via: "answer", text: "blue" }, AGENT, tell);
    assert.deepEqual(told, [`sous: an agent decided: Claude Code answered blue to Which color? in run ${run.runId}.`]);
  });
});

// The app-server methods the Codex goal, skills, review and compact use, sent through the typed
// AppServer to the fake codex in test/fakes. Each answer has the shape the generated types give.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { AppServer } from "../src/codex/rpc.js";
import { openServer } from "../src/codex/run.js";
import { caseRoot, fakeCase } from "./helpers/fake-case.js";

const ROOT = caseRoot("codex-goal-types");
const servers: AppServer[] = [];
after(() => Promise.all(servers.map((server) => server.close())));

/** A server on the fake and a thread in the case's project. */
async function newThread() {
  const c = fakeCase(ROOT, "codex", [{ answer: "Noted." }]);
  const cwd = c.step({ prompt: "" }).cwd;
  const server = await openServer(c.options.path, { ...process.env }, cwd);
  servers.push(server);
  const opened = await server.request("thread/start", { cwd });
  return { server, threadId: opened.thread.id, cwd };
}

describe("the goal methods on the fake codex", () => {
  test("thread/goal/set answers the goal, get reads it, and clear clears it", async () => {
    const { server, threadId } = await newThread();
    assert.deepEqual(await server.request("thread/goal/get", { threadId }), { goal: null });

    const set = await server.request("thread/goal/set", { threadId, objective: "every test passes" });
    assert.equal(set.goal.threadId, threadId);
    assert.equal(set.goal.objective, "every test passes");
    assert.equal(set.goal.status, "active");

    const read = await server.request("thread/goal/get", { threadId });
    assert.equal(read.goal?.objective, "every test passes");

    const paused = await server.request("thread/goal/set", { threadId, status: "paused" });
    assert.equal(paused.goal.status, "paused");
    assert.equal(paused.goal.objective, "every test passes", "a status alone keeps the objective");

    assert.deepEqual(await server.request("thread/goal/clear", { threadId }), { cleared: true });
    assert.deepEqual(await server.request("thread/goal/clear", { threadId }), { cleared: false });
    assert.deepEqual(await server.request("thread/goal/get", { threadId }), { goal: null });
  });

  test("thread/settings/update takes the model, effort and policies of later turns", async () => {
    const { server, threadId } = await newThread();
    assert.deepEqual(await server.request("thread/settings/update", { threadId, effort: "low", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }), {});
  });

  test("skills/list names the repo skills under each cwd", async () => {
    const { server, cwd } = await newThread();
    mkdirSync(join(cwd, ".agents", "skills", "canary"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "skills", "canary", "SKILL.md"), "---\nname: canary\ndescription: Says the canary word.\n---\nSay CANARY.\n");
    const listed = await server.request("skills/list", { cwds: [cwd] });
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0]!.cwd, cwd);
    assert.deepEqual(
      listed.data[0]!.skills.map((skill) => [skill.name, skill.description, skill.path, skill.scope, skill.enabled]),
      [["canary", "Says the canary word.", join(cwd, ".agents", "skills", "canary", "SKILL.md"), "repo", true]],
    );
  });

  test("review/start answers with its turn and the thread, and thread/compact/start with nothing", async () => {
    const { server, threadId } = await newThread();
    const review = await server.request("review/start", { threadId, target: { type: "uncommittedChanges" }, delivery: "inline" });
    assert.equal(review.reviewThreadId, threadId);
    assert.equal(review.turn.status, "inProgress");
    assert.equal(typeof review.turn.id, "string");
    assert.deepEqual(await server.request("thread/compact/start", { threadId }), {});
  });
});

// An answer that is not one of the question's choices exits 64 with not_a_choice. Its calls run as
// they are: one next call per choice, in the question's order, and its call is the first. An
// agent that passed on the person's answer with --by person keeps it in each call.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type HomePaths, type RunQuestion } from "@sous/engine";
import { testHome } from "@sous/engine/testing";
import { sous } from "./sous.js";

const PERSON_ENV: NodeJS.ProcessEnv = {};
const CLAUDE_ENV: NodeJS.ProcessEnv = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };

interface ErrorBody {
  code: string;
  message: string;
  change: string;
  call: string | null;
  next?: Array<{ call: string; does: string }>;
}

/** A question waiting in the inbox of a fresh home. */
function asked(fields: Partial<RunQuestion>): { paths: HomePaths; id: string } {
  const { paths } = testHome();
  const id = "r1--0";
  const question: RunQuestion = { id, runId: "r1", scope: "r1", callIndex: 0, hash: "h0", workflow: "w", prompt: "?", kind: "input", breakpoint: false, askedAt: "2026-11-24T10:00:00.000Z", ...fields };
  writeFileSync(join(paths.inbox, `${id}.json`), JSON.stringify(question, null, 2));
  return { paths, id };
}

async function refused(paths: HomePaths, argv: string[], env: NodeJS.ProcessEnv): Promise<ErrorBody> {
  const called = await sous(paths, argv, { env });
  assert.equal(called.code, 64, called.out);
  const error = (JSON.parse(called.out) as { error: ErrorBody }).error;
  assert.equal(error.code, "not_a_choice");
  return error;
}

/** A call as an argv, for calls whose words hold no quotes. */
const argv = (call: string): string[] => call.replace(/^sous /, "").split(" ");

/** The value the answer file holds, or undefined when none was written. */
function answered(paths: HomePaths, id: string): unknown {
  const file = join(paths.inbox, `${id}.answer.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { value: unknown }).value : undefined;
}

describe("not_a_choice", () => {
  it("a select question gives one call per choice, and each runs as it is", async () => {
    const select = { kind: "select" as const, choices: ["red", "blue"] };
    const { paths, id } = asked(select);
    const error = await refused(paths, ["answer", id, "green", "--json"], PERSON_ENV);
    assert.deepEqual(error.next?.map((next) => next.call), [`sous answer ${id} red --json`, `sous answer ${id} blue --json`]);
    assert.equal(error.call, error.next?.[0]?.call);
    for (const [n, next] of (error.next ?? []).entries()) {
      // Each call on a question of its own, since the first answer takes the question away.
      const fresh = asked(select);
      const ran = await sous(fresh.paths, argv(next.call), { env: PERSON_ENV });
      assert.equal(ran.code, 0, `${next.call}: ${ran.out}`);
      assert.equal(answered(fresh.paths, fresh.id), select.choices[n]);
    }
  });

  it("a confirm question gives yes, then no", async () => {
    const { paths, id } = asked({ kind: "confirm" });
    const error = await refused(paths, ["answer", id, "maybe", "--json"], PERSON_ENV);
    assert.deepEqual(error.next?.map((next) => next.call), [`sous answer ${id} yes --json`, `sous answer ${id} no --json`]);
  });

  it("keeps --by person for an agent that passed on the person's answer", async () => {
    const { paths, id } = asked({ kind: "select", choices: ["red", "blue"] });
    const error = await refused(paths, ["answer", id, "green", "--by", "person", "--json"], CLAUDE_ENV);
    assert.deepEqual(error.next?.map((next) => next.call), [`sous answer ${id} red --by person --json`, `sous answer ${id} blue --by person --json`]);
    const ran = await sous(paths, argv(error.next![1]!.call), { env: CLAUDE_ENV });
    assert.equal(ran.code, 0, ran.out);
    assert.equal(answered(paths, id), "blue");
  });

  it("quotes a choice that is more than one word", async () => {
    const { paths, id } = asked({ kind: "select", choices: ["dark red", "blue"] });
    const error = await refused(paths, ["answer", id, "green", "--json"], PERSON_ENV);
    assert.deepEqual(error.next?.map((next) => next.call), [`sous answer ${id} 'dark red' --json`, `sous answer ${id} blue --json`]);
  });
});

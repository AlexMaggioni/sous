// `sous check` notes each agent() call whose prompt starts with a value made at run time. sous
// sends a prompt as written, so a value that starts with "/" would run a slash command. The note
// asks for fixed words first. It is a note, not a problem, so the check still passes.
//
// A send() on a session handle gets the same note. test/workflows/session-reader.test.ts covers it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkWorkflow } from "../../src/workflows/check.js";
import { setup } from "../runs/fixture.js";

const NOTE_END = "starts its prompt with a value made at run time. A value that starts with \"/\" would run a command. Start the prompt with fixed words.";
const NO_INPUTS = "declares no inputs, so it takes any";

/** The problems and the prompt notes of a workflow whose body is the given lines. The meta is line 1. */
function check(...lines: string[]): { problems: string[]; notes: string[] } {
  const { paths, projectDir } = setup({ prompts: [`export const meta = { name: 'prompts', description: 'd' }`, ...lines].join("\n") });
  const result = checkWorkflow(paths, projectDir, "prompts");
  return { problems: result.problems, notes: result.notes.filter((note) => note !== NO_INPUTS) };
}

describe("check notes a prompt that starts with a value made at run time", () => {
  for (const prompt of ["args.ticket", "x", "task.prompt", "`${x} now`", "x + ' now'", "args.ticket + x"]) {
    it(`notes agent(${prompt})`, () => {
      const result = check("const x = args.ticket", "const task = { prompt: x }", `await agent(${prompt}, { label: 'triage' })`);
      assert.deepEqual(result, { problems: [], notes: [`agent "triage" (line 4) ${NOTE_END}`] });
    });
  }

  for (const prompt of ["'Fix it'", "`Fix ${x}`", "'Fix ' + x", "'Fix ' + x + ' now'", "'/canary'"]) {
    it(`gives no note for agent(${prompt})`, () => {
      const result = check("const x = args.ticket", `await agent(${prompt}, { label: 'triage' })`);
      assert.deepEqual(result, { problems: [], notes: [] });
    });
  }

  it("names a step with no label by its line alone", () => {
    const line = 3;
    const result = check("const x = args.ticket", "await agent(x)");
    assert.deepEqual(result.notes, [`agent (line ${line}) ${NOTE_END}`]);
  });

  it("notes each call in the order written", () => {
    const result = check("await agent('Plan it', { label: 'plan' })", "await agent(args.a, { label: 'one' })", "", "await agent(args.b, { label: 'two' })");
    assert.deepEqual(result.notes, [`agent "one" (line 3) ${NOTE_END}`, `agent "two" (line 5) ${NOTE_END}`]);
  });

  it("still passes a script whose only finding is the note", () => {
    const { paths, projectDir } = setup({
      only: [`export const meta = { name: 'only', description: 'd', inputs: { ticket: 'The ticket' } }`, "await agent(args.ticket, { label: 'triage' })"].join("\n"),
    });
    const result = checkWorkflow(paths, projectDir, "only", { ticket: "/canary" });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.notes, [`agent "triage" (line 2) ${NOTE_END}`]);
  });
});

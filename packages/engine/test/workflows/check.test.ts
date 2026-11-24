import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkWorkflow } from "../../src/workflows/check.js";
import { setup } from "../runs/fixture.js";
import { write } from "../helpers/files.js";

// `sous check` without sous: the problems and notes it prints for a workflow.

describe("check", () => {
  it("finds missing workflows, agents and MCP servers, and agents sent to a harness they can't run on", () => {
    const { paths, projectDir } = setup({
      outer: `export const meta = { name: 'outer', description: 'nests', inputs: { ticket: 'The ticket', harness: { type: 'string', description: 'The harness', default: 'claude' } } }
await workflow('inner', {})
await workflow('ghost', {})
await agent('x', { agentType: 'implementer', mcp: ['linear'] })
await agent('y', { agentType: 'reviewer', model: 'codex' })
await agent('w', { agentType: 'fixer', model: 'claude/haiku' })
await agent('v', { agentType: 'fixer', model: args.harness })`,
      inner: `export const meta = { name: 'inner', description: 'inner' }
await agent('z', { agentType: 'nobody' })`,
    });
    write(join(projectDir, ".rulesync", "subagents", "implementer.md"), "---\nname: implementer\ndescription: builds\n---\nBuild it.\n");
    write(join(projectDir, ".rulesync", "subagents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\ncodexcli:\n  model: gpt-test\n---\nReview it.\n");
    write(join(projectDir, ".codex", "agents", "fixer.toml"), 'name = "fixer"\ndescription = "fixes"\ndeveloper_instructions = "Fix it."\n');
    const result = checkWorkflow(paths, projectDir, "outer", { tickt: "x" });
    const expected = [
      /^no MCP server "linear" for Claude Code\. sous looks in .*Add it to \.rulesync\/mcp\.jsonc\.$/,
      /^agent "fixer" comes from .*\/\.codex\/agents\/fixer\.toml, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code\. Move it to rulesync, as \.rulesync\/subagents\/fixer\.md/,
      /^in inner: no agent "nobody"\. sous looks in \.rulesync\/subagents\/, then the global rulesync folder/,
      /^no saved workflow "ghost"$/,
      /^missing input --ticket \(The ticket\)$/,
      /^unknown input --tickt\. This workflow takes: --ticket, --harness$/,
    ];
    assert.equal(result.problems.length, expected.length, result.problems.join("\n"));
    for (const pattern of expected) assert.ok(result.problems.some((p) => pattern.test(p)), `${pattern} in:\n${result.problems.join("\n")}`);
    assert.ok(result.notes.some((n) => /a step with agent "fixer" picks its harness while running\. The agent comes from .*fixer\.toml, so the step stops on any harness but Codex\./.test(n)));
    write(join(projectDir, ".rulesync", "mcp.jsonc"), `{ "mcpServers": { "linear": { "command": "npx", "args": ["linear-mcp"] } } }`);
    assert.equal(checkWorkflow(paths, projectDir, "outer").problems.some((p) => p.includes("linear")), false);
  });

  it("refuses a step model or a default that names Pi or OpenCode, which sous no longer runs", () => {
    const { paths, projectDir } = setup({
      gone: `export const meta = { name: 'gone', description: 'old harnesses' }
await agent('a', { model: 'pi/gpt-test' })
await agent('b', { model: "opencode/big" })
await agent('c', { model: 'claude/haiku' })`,
    }, { defaultHarness: "opencode", defaultModel: "pi/gpt-test" });
    const problems = checkWorkflow(paths, projectDir, "gone").problems;
    const expected = [
      /^model "pi\/gpt-test" names the harness "pi", which sous no longer runs\. Use one of claude, codex\.$/,
      /^model "opencode\/big" names the harness "opencode", which sous no longer runs\. Use one of claude, codex\.$/,
      /^the configured default harness "opencode" is not one sous runs\. Use one of claude, codex\.$/,
      /^the configured default model "pi\/gpt-test" names the harness "pi"/,
    ];
    assert.equal(problems.length, expected.length, problems.join("\n"));
    for (const pattern of expected) assert.ok(problems.some((p) => pattern.test(p)), `${pattern} in:\n${problems.join("\n")}`);
  });

  // Until step 4, check found names with regular expressions over the script text. It reads them
  // from the parsed script now. Each test below is a script where the two differ, and says how.
  describe("reads names from the parsed script", () => {
    const check = (body: string, withFixer = false) => {
      const { paths, projectDir } = setup({ diff: `export const meta = { name: 'diff', description: 'd' }\n${body}\nreturn 1` });
      if (withFixer) write(join(projectDir, ".codex", "agents", "fixer.toml"), 'name = "fixer"\ndescription = "fixes"\ndeveloper_instructions = "Fix it."\n');
      const result = checkWorkflow(paths, projectDir, "diff");
      return { problems: result.problems, notes: result.notes.filter((note) => note !== "declares no inputs, so it takes any") };
    };
    const fromCodex = /^agent "fixer" comes from .*\/\.codex\/agents\/fixer\.toml, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code\./;

    it("skips names in comments and in the text of strings, which the text scan read", () => {
      const result = check(`// await workflow('ghost', {})
/* await agent('a', { model: 'pi/gpt-test' }) */
const text = "run('missing.sh')"`);
      assert.deepEqual(result, { problems: [], notes: [] });
    });

    it("skips workflow() and run() called on an object, which the text scan read as the global ones", () => {
      const result = check(`const tools = { workflow: async () => 1, run: async () => 2 }
await tools.workflow('ghost', {})
await tools.run('missing.sh')`);
      assert.deepEqual(result, { problems: [], notes: [] });
    });

    it("reads a quoted key, which the text scan missed", () => {
      const result = check(`await agent('a', { "model": "pi/gpt-test" })`);
      assert.deepEqual(result, { problems: ['model "pi/gpt-test" names the harness "pi", which sous no longer runs. Use one of claude, codex.'], notes: [] });
    });

    it("reads a template string with nothing in it to fill, which the text scan missed", () => {
      // The text scan found no workflow here, and read the model as one picked while running.
      const result = check("await workflow(`ghost`, {})\nawait agent('a', { agentType: 'fixer', model: `claude/haiku` })", true);
      assert.equal(result.problems.length, 2, result.problems.join("\n"));
      assert.equal(result.problems[0], 'no saved workflow "ghost"');
      assert.match(result.problems[1]!, fromCodex);
      assert.deepEqual(result.notes, []);
    });

    it("reads a shorthand model as a model picked while running, which the text scan missed", () => {
      const result = check(`const model = args.harness
await agent('a', { agentType: 'fixer', model })`, true);
      assert.deepEqual(result.problems, []);
      assert.equal(result.notes.length, 1, result.notes.join("\n"));
      assert.match(result.notes[0]!, /^a step with agent "fixer" picks its harness while running\. The agent comes from .*fixer\.toml, so the step stops on any harness but Codex\.$/);
    });

    it("reads a step's own keys only, where the text scan also read the objects inside it", () => {
      // The text scan took the inner model as the step's, so it sent fixer to Claude Code.
      const result = check(`await agent('a', { agentType: 'fixer', extra: { model: 'claude/haiku' } })`, true);
      assert.deepEqual(result, { problems: [], notes: [] });
      assert.match(check(`await agent('a', { agentType: 'fixer', model: 'claude/haiku' })`, true).problems.join("\n"), fromCodex);
    });

    it("finds any: true after a parenthesis in choose(), which the text scan missed", () => {
      const result = check(`await choose('pick one (or none)', { any: true })`);
      assert.deepEqual(result, { problems: [], notes: ["an agent may pick any saved workflow"] });
    });
  });
});

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, StepRequest } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { JournalEntry } from "../src/workflow-result.js";
import { runWorkflow } from "../src/workflow.js";

// The run's base cwd (WorkflowRunOptions.cwd) must reach EVERY subagent session, not just
// worktree-isolated ones: the runner falls back to the HOST's process.cwd(), which is only
// correct when the host process happens to live at the project root. Per-agent
// agent({ cwd }) overrides the run cwd (relative resolves against it). Like mcpServers,
// cwd is ADDITIVE: threaded to the runner, but NEVER part of the resume identity hash.

function capturingRunner(capture: (cwd: string | undefined) => void): AgentRunner {
  return {
    async run<S extends TSchema | undefined = undefined>(
      _prompt: string,
      options?: StepRequest<S>,
    ): Promise<AgentResult<S>> {
      capture(options?.cwd);
      return "ok" as AgentResult<S>;
    },
  };
}

const ONE_AGENT = `export const meta = { name: 'c', description: 'cwd' }
return await agent('p', { label: 'a' })`;

describe("agent session cwd threading", () => {
  it("threads the run-level cwd into every agent's runner opts", async () => {
    const runCwd = tmpdir();
    let captured: string | undefined;
    await runWorkflow(ONE_AGENT, {
      agent: capturingRunner((cwd) => (captured = cwd)),
      persistLogs: false,
      cwd: runCwd,
    });
    assert.equal(captured, resolve(runCwd));
  });

  it("defaults to the host process.cwd() when no run cwd is set (previous behavior preserved)", async () => {
    let captured: string | undefined;
    await runWorkflow(ONE_AGENT, {
      agent: capturingRunner((cwd) => (captured = cwd)),
      persistLogs: false,
    });
    assert.equal(captured, process.cwd());
  });

  it("lets agent({ cwd }) override the run cwd with an absolute path", async () => {
    const agentCwd = resolve(tmpdir(), "elsewhere");
    let captured: string | undefined;
    const script = `export const meta = { name: 'c', description: 'cwd' }
return await agent('p', { label: 'a', cwd: ${JSON.stringify(agentCwd)} })`;
    await runWorkflow(script, {
      agent: capturingRunner((cwd) => (captured = cwd)),
      persistLogs: false,
      cwd: tmpdir(),
    });
    assert.equal(captured, agentCwd);
  });

  it("resolves a relative agent({ cwd }) against the run cwd", async () => {
    const runCwd = tmpdir();
    let captured: string | undefined;
    const script = `export const meta = { name: 'c', description: 'cwd' }
return await agent('p', { label: 'a', cwd: 'packages/sub' })`;
    await runWorkflow(script, {
      agent: capturingRunner((cwd) => (captured = cwd)),
      persistLogs: false,
      cwd: runCwd,
    });
    assert.equal(captured, resolve(runCwd, "packages/sub"));
  });

  it("rejects a non-string agent({ cwd }) with a script-validation fault", async () => {
    const script = `export const meta = { name: 'c', description: 'cwd' }
return await agent('p', { label: 'a', cwd: 42 })`;
    await assert.rejects(
      runWorkflow(script, { agent: capturingRunner(() => {}), persistLogs: false }),
      /options\.cwd must be a string/,
    );
  });
});

// cwd, images, mcpServers and meta shape the agent, not the logical call. Each is threaded to the
// runner or kept in the call's inputs, and none enters the resume identity hash. One row per
// option, with the option as the script writes it.
const ADDITIVE_OPTIONS: Array<[name: string, option: string]> = [
  ["cwd", `cwd: ${JSON.stringify(tmpdir())}`],
  ["images", "images: [{ data: 'ZmFrZQ==', mimeType: 'image/png', uri: 'file:///tmp/a.png' }]"],
  ["mcpServers", "mcpServers: [{ name: 'fs', command: 'mcp-fs', args: [], env: [] }]"],
];

describe("the resume identity hash", () => {
  const echo: AgentRunner = {
    async run<S extends TSchema | undefined = undefined>(prompt: string): Promise<AgentResult<S>> {
      return `ran:${prompt}` as AgentResult<S>;
    },
  };
  const journalOf = async (option: string | undefined): Promise<JournalEntry[]> => {
    const journal: JournalEntry[] = [];
    const script = `export const meta = { name: 'c2', description: 'additive options' }
return await agent('same', { label: 'a'${option === undefined ? "" : `, ${option}`} })`;
    await runWorkflow(script, {
      agent: echo,
      persistLogs: false,
      onAgentJournal: (e) => journal.push(e),
    });
    return journal;
  };
  const identity = (rows: JournalEntry[]) => rows.map(({ index, hash, result, kind, usage }) => ({ index, hash, result, kind, usage }));

  for (const [name, option] of ADDITIVE_OPTIONS) {
    it(`does NOT fold ${name} into the resume identity hash`, async () => {
      assert.deepEqual(
        identity(await journalOf(option)),
        identity(await journalOf(undefined)),
        `setting ${name} must keep the journal identity and result byte-identical`,
      );
    });
  }
});

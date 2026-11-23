import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, StepRequest } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { JournalEntry } from "../src/workflow-result.js";
import type { McpServerConfig } from "../src/steps/mcp-config.js";
import { runWorkflow } from "../src/workflow.js";
import { toMcpServer } from "../src/steps/answer.js";

// (#5) agent({ mcpServers }) is an ADDITIVE run input: the engine must thread it through to
// the runner opts (so the harness gets them for the step), but it must NOT enter
// the resume identity hash (hashAgentCall) — wiring tools changes which tools an agent can
// reach, not the logical call, and folding it into the hash would needlessly bust every
// cached result whenever tool wiring changes.

const STDIO_SERVER = { name: "fs", command: "mcp-fs", args: [], env: [] };

describe("agent({ mcpServers }) plumbing", () => {
  it("threads mcpServers from agent() into the runner opts", async () => {
    let captured: McpServerConfig[] | undefined;
    let invoked = false;
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: StepRequest<S>,
      ): Promise<AgentResult<S>> {
        invoked = true;
        captured = options?.mcpServers;
        return "ok" as AgentResult<S>;
      },
    };
    const script = `export const meta = { name: 'm', description: 'mcp' }
const a = await agent('p', { label: 'a', mcpServers: [{ name: 'fs', command: 'mcp-fs', args: [], env: [] }] })
return a`;

    await runWorkflow(script, { agent: capturing, persistLogs: false });

    assert.ok(invoked, "the runner was invoked");
    // The script builds the array inside the vm realm; normalize through JSON so deepStrictEqual
    // compares structure (cross-realm objects have a different Object.prototype) — the value the
    // runner would forward to session/new is exactly this.
    assert.deepEqual(JSON.parse(JSON.stringify(captured)), [STDIO_SERVER]);
  });

  it("passes undefined mcpServers through when none is provided", async () => {
    let captured: McpServerConfig[] | undefined;
    let sawOptions = false;
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: StepRequest<S>,
      ): Promise<AgentResult<S>> {
        sawOptions = true;
        captured = options?.mcpServers;
        return "ok" as AgentResult<S>;
      },
    };
    const script = `export const meta = { name: 'm', description: 'mcp' }
const a = await agent('p', { label: 'a' })
return a`;

    await runWorkflow(script, { agent: capturing, persistLogs: false });

    assert.ok(sawOptions);
    assert.equal(captured, undefined);
  });

  it("does NOT fold mcpServers into the resume identity hash", async () => {
    const echo: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(prompt: string): Promise<AgentResult<S>> {
        return `ran:${prompt}` as AgentResult<S>;
      },
    };
    const journalOf = async (withServers: boolean): Promise<JournalEntry[]> => {
      const journal: JournalEntry[] = [];
      const opts = withServers
        ? `{ label: 'a', mcpServers: [{ name: 'fs', command: 'mcp-fs', args: [], env: [] }] }`
        : `{ label: 'a' }`;
      const script = `export const meta = { name: 'm2', description: 'mcp' }
const a = await agent('same', ${opts})
return a`;
      await runWorkflow(script, {
        agent: echo,
        persistLogs: false,
        onAgentJournal: (e) => journal.push(e),
      });
      return journal;
    };

    const [withServers] = await journalOf(true);
    const [withoutServers] = await journalOf(false);
    assert.equal(
      withServers.hash,
      withoutServers.hash,
      "adding mcpServers must keep the resume key byte-identical (it is not part of the identity)",
    );
  });
});

describe("toMcpServer", () => {
  it("turns a command into a stdio server and a url into an http one", () => {
    assert.deepEqual(toMcpServer({ ...STDIO_SERVER, env: [{ name: "A", value: "1" }] }), {
      name: "fs",
      type: "stdio",
      command: "mcp-fs",
      args: [],
      env: { A: "1" },
    });
    assert.deepEqual(toMcpServer({ type: "sse", name: "web", url: "https://example.test/mcp", headers: [] }), {
      name: "web",
      type: "http",
      url: "https://example.test/mcp",
      headers: {},
    });
  });

  it("names the server and its type when a step cannot start it", () => {
    const server = { type: "acp", name: "inbox", id: "x" } as unknown as McpServerConfig;
    assert.deepEqual(toMcpServer(server), {
      problem: 'MCP server "inbox" is of type acp, which a step cannot start. Give it a command or a url.',
    });
  });
});

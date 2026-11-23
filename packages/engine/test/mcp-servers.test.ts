import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, StepRequest } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { McpServerConfig } from "../src/steps/mcp-config.js";
import { runWorkflow } from "../src/workflow.js";
import { toMcpServer } from "../src/steps/answer.js";

// agent({ mcpServers }) is an additive run input. The engine threads it through to the runner
// opts, so the harness gets the servers for the step. It stays out of the resume identity hash,
// which cwd.test.ts checks for all the additive options. Wiring tools changes which tools an agent
// can reach and not the logical call, so folding it in would bust every cached result whenever
// the wiring changes.

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

// joinArgs: the arguments that open a step's session by hand in each program's own view.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHarness } from "../src/index.js";
import type { Harness } from "../src/index.js";

const claude = createHarness("claude", { env: {} });
const codex = createHarness("codex", { env: {} });
const BASE: Parameters<Harness["joinArgs"]>[0] = { sessionId: "s-1", cwd: "/work/project" };

/** A write that keeps each text and gives a made-up path. */
function writer() {
  const written: Record<string, string> = {};
  return { written, write: (name: string, text: string) => ((written[name] = text), `/private/${name}`) };
}

describe("claude joinArgs", () => {
  test("a bare step resumes the session and passes nothing else", () => {
    const { written, write } = writer();
    assert.deepEqual(claude.joinArgs(BASE, write), { args: ["--resume", "s-1"], notes: [] });
    assert.deepEqual(written, {});
  });

  test("passes the model, effort, mode and instructions", () => {
    const { write } = writer();
    const { args, notes } = claude.joinArgs({ ...BASE, model: "haiku", effort: "low", mode: "acceptEdits", instructions: "Be brief.\nSay \"done\"." }, write);
    assert.deepEqual(args, ["--resume", "s-1", "--model", "haiku", "--effort", "low", "--permission-mode", "acceptEdits", "--append-system-prompt", "Be brief.\nSay \"done\"."]);
    assert.deepEqual(notes, []);
  });

  test("the SDK's default mode is manual on the command line", () => {
    const { args } = claude.joinArgs({ ...BASE, mode: "default" }, writer().write);
    assert.deepEqual(args, ["--resume", "s-1", "--permission-mode", "manual"]);
  });

  test("bypassPermissions also allows skipping permissions", () => {
    const { args } = claude.joinArgs({ ...BASE, mode: "bypassPermissions" }, writer().write);
    assert.deepEqual(args, ["--resume", "s-1", "--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions"]);
  });

  test("an unknown mode or effort becomes a note and no flag", () => {
    const { args, notes } = claude.joinArgs({ ...BASE, mode: "agent", effort: "ultra" }, writer().write);
    assert.deepEqual(args, ["--resume", "s-1"]);
    assert.deepEqual(notes, ["Claude Code has no effort ultra, so the model's default stays.", "Claude Code has no permission mode agent, so the user's default stays."]);
  });

  test("MCP servers go in a private file that --mcp-config names", () => {
    const { written, write } = writer();
    const { args } = claude.joinArgs(
      {
        ...BASE,
        mcpServers: [
          { name: "docs", type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer secret" } },
          { name: "local", type: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "t" } },
        ],
      },
      write,
    );
    assert.deepEqual(args, ["--resume", "s-1", "--mcp-config", "/private/mcp.json"]);
    assert.ok(!args.join(" ").includes("secret"));
    assert.deepEqual(JSON.parse(written["mcp.json"]!), {
      mcpServers: {
        docs: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer secret" } },
        local: { type: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "t" } },
      },
    });
  });
});

describe("codex joinArgs", () => {
  test("a bare step resumes the thread in its folder and passes nothing else", () => {
    assert.deepEqual(codex.joinArgs(BASE, writer().write), { args: ["resume", "s-1", "-C", "/work/project"], notes: [] });
  });

  test("passes the model and effort", () => {
    const { args } = codex.joinArgs({ ...BASE, model: "gpt-6-luna", effort: "low" }, writer().write);
    assert.deepEqual(args, ["resume", "s-1", "-C", "/work/project", "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"']);
  });

  test("each mode gets the sandbox and approval flags runCodex sets on the thread", () => {
    const flags = (mode: string) => codex.joinArgs({ ...BASE, mode }, writer().write).args.slice(4);
    assert.deepEqual(flags("read-only"), ["-s", "read-only", "-a", "on-request"]);
    assert.deepEqual(flags("workspace-write"), ["-s", "workspace-write", "-a", "on-request"]);
    assert.deepEqual(flags("agent"), ["--approve-for-me"]);
    assert.deepEqual(flags("agent-full-access"), ["-s", "danger-full-access", "-a", "never"]);
  });

  test("an unknown mode becomes a note and no flag", () => {
    const { args, notes } = codex.joinArgs({ ...BASE, mode: "acceptEdits" }, writer().write);
    assert.deepEqual(args, ["resume", "s-1", "-C", "/work/project"]);
    assert.deepEqual(notes, ["Codex has no mode acceptEdits, so the user's default stays."]);
  });

  test("instructions go in developer_instructions as a TOML string", () => {
    const { args } = codex.joinArgs({ ...BASE, instructions: 'Be brief.\nSay "done" \\ go.\u007f' }, writer().write);
    assert.deepEqual(args.slice(4), ["-c", 'developer_instructions="Be brief.\\nSay \\"done\\" \\\\ go.\\u007f"']);
  });

  test("MCP servers go in one TOML table, with quoted keys where a bare key cannot hold the name", () => {
    const { args, notes } = codex.joinArgs(
      {
        ...BASE,
        mcpServers: [
          { name: "my docs", type: "http", url: "https://example.invalid/mcp", headers: { "X-Key": "k" } },
          { name: "a.b", type: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "t" } },
        ],
      },
      writer().write,
    );
    assert.deepEqual(args.slice(4), [
      "-c",
      'mcp_servers={ my_docs = { url = "https://example.invalid/mcp", http_headers = { X-Key = "k" } }, "a.b" = { command = "node", args = ["server.js"], env = { TOKEN = "t" } } }',
    ]);
    assert.deepEqual(notes, [
      "Codex merges each MCP server my_docs, a.b into a configured server of the same name, which keeps the keys the step's server does not set.",
      "Codex takes these MCP servers only on its command line, so their env and headers show in the process list.",
    ]);
  });

  test("MCP servers with no env or headers get only the merge note", () => {
    const { notes } = codex.joinArgs({ ...BASE, mcpServers: [{ name: "plain", type: "stdio", command: "srv" }] }, writer().write);
    assert.deepEqual(notes, ["Codex merges each MCP server plain into a configured server of the same name, which keeps the keys the step's server does not set."]);
  });
});

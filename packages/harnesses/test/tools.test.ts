// A step's tool lists, read the same way by both adapters.
import test from "node:test";
import assert from "node:assert/strict";
import { matches, mcpTool, refusal, toolName } from "../src/tools.js";

test("lets every tool run when the step has no lists, or empty ones", () => {
  assert.equal(refusal(undefined, "Bash"), undefined);
  assert.equal(refusal({}, "Bash"), undefined);
  assert.equal(refusal({ allow: [], deny: [] }, "Bash"), undefined);
});

test("refuses a tool on the deny list and lets another run", () => {
  assert.equal(refusal({ deny: ["bash"] }, "Bash"), "Bash is on the step's deny list (bash).");
  assert.equal(refusal({ deny: ["bash"] }, "Read"), undefined);
});

test("refuses a tool a non-empty allow list does not name", () => {
  const tools = { allow: ["read", "grep"] };
  assert.equal(refusal(tools, "Read"), undefined);
  assert.equal(refusal(tools, "Write"), "Write is not on the step's allow list.");
});

test("refuses a tool on both lists, since the deny list wins", () => {
  const tools = { allow: ["bash", "read"], deny: ["bash"] };
  assert.match(refusal(tools, "bash") ?? "", /deny list/);
  assert.equal(refusal(tools, "read"), undefined);
});

test("matches names without case, and when one name holds the other", () => {
  assert.ok(matches("rm -rf", "rm"));
  assert.ok(matches("read", "ReadFileTool"));
  assert.ok(matches("BASH", "bash"));
  assert.ok(!matches("read", "Write"));
  assert.ok(!matches("", "Bash"));
  assert.ok(!matches("Bash", ""));
});

test("reads a tool name without its rule", () => {
  assert.equal(toolName("Bash(git *)"), "Bash");
  assert.equal(toolName(" Read "), "Read");
  assert.ok(matches("Bash(git *)", "Bash"));
  assert.equal(refusal({ deny: ["Bash(rm *)"] }, "Bash"), "Bash is on the step's deny list (Bash(rm *)).");
});

test("splits an MCP tool entry into its server and tool", () => {
  assert.deepEqual(mcpTool("mcp__files__read_file"), { server: "files", tool: "read_file" });
  assert.deepEqual(mcpTool("mcp__my_server__a__b"), { server: "my_server", tool: "a__b" });
  assert.deepEqual(mcpTool("mcp__files__write(x)"), { server: "files", tool: "write" });
  assert.equal(mcpTool("Bash"), undefined);
  assert.equal(mcpTool("mcp__files"), undefined);
});

export const meta = {
  name: "rulesync-mcp",
  description: "A rulesync agent with MCP servers on each harness, and a step that names its own",
  place: "none",
}

const onClaude = await agent("MCP-CLAUDE Look it up.", { label: "researcher", agentType: "fake-researcher" })
const onCodex = await agent("MCP-CODEX Look it up.", { label: "researcher on codex", agentType: "fake-researcher", model: "codex" })
const ownServer = await agent("MCP-STEP Use the docs.", { label: "docs step", mcp: ["docs", "notes"] })
const codexServer = await agent("MCP-STEP-CODEX Use the docs.", { label: "docs step on codex", model: "codex", mcp: ["docs"] })
return { onClaude, onCodex, ownServer, codexServer }

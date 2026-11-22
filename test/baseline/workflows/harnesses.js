export const meta = {
  name: "harnesses",
  description: "A Claude Code step and a Codex step",
  place: "none",
}

const schema = { type: "object", properties: { answer: { type: "string" }, sure: { type: "boolean" } }, required: ["answer", "sure"] }
const claude = await agent("HARNESS-CLAUDE Answer on Claude Code.", { label: "on claude", model: "claude/opus", effort: "low", schema })
const codex = await agent("HARNESS-CODEX Answer on Codex.", { label: "on codex", model: "codex", effort: "high", schema })
const codexAgent = await agent("HARNESS-CODEX-AGENT Answer as the Codex agent.", { label: "codex agent", agentType: "fake-codex" })
return { claude, codex, codexAgent }

export const meta = {
  name: "tools",
  description: "An agent with an allow list and a deny list",
  place: "none",
}

const limited = await agent("TOOLS-LIMITED Read the code.", { label: "limited", agentType: "fake-limited" })
const free = await agent("TOOLS-FREE Do anything.", { label: "free" })
return { limited, free }

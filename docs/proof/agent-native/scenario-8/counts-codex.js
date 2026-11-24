export const meta = {
  name: "counts-codex",
  description: "Count slowly, one number every few seconds",
  place: "none",
}

const result = await agent(
  "Count from 1 to 30. For each number, run the shell command `sleep 4 && echo N` with N the number, one command per number, one at a time. Do not batch numbers. When you stop, reply with only the numbers you counted, separated by spaces.",
  { label: "count", model: "codex" },
)
return { counted: result }

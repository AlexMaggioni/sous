export const meta = {
  name: "questions",
  description: "A question, an agent that asks, and a breakpoint sent back once",
  place: "none",
}

const color = await ask("Pick a color for the draft", { choices: ["red", "blue"] })
const asked = await agent("ASKER Which file should change?", { label: "asker", ask: true })
const draft = await breakpoint("Check the draft", (note) => agent(note ? `DRAFT again in ${color}: ${note}` : `DRAFT first in ${color}`, { label: "drafter" }), {
  show: (text) => `Draft: ${text}`,
})
return { color, asked, draft }

export const meta = {
  name: "questions",
  description: "A question and a breakpoint sent back once",
  place: "none",
}

const color = await ask("Pick a color for the draft", { choices: ["red", "blue"] })
const draft = await breakpoint("Check the draft", (note) => agent(note ? `DRAFT again in ${color}: ${note}` : `DRAFT first in ${color}`, { label: "drafter" }), {
  show: (text) => `Draft: ${text}`,
})
return { color, draft }

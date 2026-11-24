export const meta = {
  name: "asks",
  description: "Ask a person to pick a color",
  place: "none",
}

const color = await ask("Which color?", { choices: ["red", "blue"] })
return { color }

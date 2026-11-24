export const meta = {
  name: "asks-anyone",
  description: "Ask anyone, an agent too, to pick a color",
  place: "none",
}

const color = await ask("Which color?", { choices: ["red", "blue"], answeredBy: "anyone" })
return { color }

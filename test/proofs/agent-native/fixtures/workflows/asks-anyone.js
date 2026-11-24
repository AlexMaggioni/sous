export const meta = {
  name: "asks-anyone",
  description: "Ask for a color that anyone may pick",
  place: "none",
}

const color = await ask("Which color?", { choices: ["red", "blue"], answeredBy: "anyone" })
return { color }

export const meta = {
  name: "hello",
  description: "Say hello to someone",
  inputs: { name: { type: "string", description: "Who to greet", required: true } },
  place: "none",
}

const greeting = await js("return `hello ${input.name}`", { name: args.name }, { label: "greet" })
return greeting.result

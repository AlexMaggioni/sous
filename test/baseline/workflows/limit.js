export const meta = {
  name: "limit",
  description: "A step that hits the usage limit, which pauses the run",
  inputs: { model: { type: "string", description: "Model of the step", default: "claude" } },
  place: "none",
}

const before = await sh("echo before", { label: "before" })
const answer = await agent("LIMIT Do the work.", { label: "worker", model: args.model })
return { before: before.stdout.trim(), answer }

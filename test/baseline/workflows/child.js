export const meta = {
  name: "child",
  description: "A small workflow that fanout runs inside itself",
  inputs: { topic: { type: "string", description: "What the child works on", default: "alone" } },
  place: "folder",
}

const out = await agent(`CHILD Work on ${args.topic}.`, {
  label: "child agent",
  schema: { type: "object", properties: { summary: { type: "string" }, count: { type: "integer" } }, required: ["summary", "count"] },
})
const echo = await sh(`echo child-${args.topic}`, { label: "child echo" })
return { out, echo: echo.stdout.trim() }

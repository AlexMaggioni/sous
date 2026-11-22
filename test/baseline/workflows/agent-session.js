export const meta = {
  name: "agent-session",
  description: "An agent step with a schema, then a second turn in the same session",
  inputs: { topic: { type: "string", description: "What to plan", default: "a small change" } },
  place: "none",
}

const plan = await agent(`SESSION-1 Plan ${args.topic}.`, {
  label: "planner",
  keepSession: true,
  schema: {
    type: "object",
    properties: {
      steps: { type: "array", items: { type: "string" } },
      size: { type: "string", enum: ["small", "large"] },
      done: { type: "boolean" },
    },
    required: ["steps", "size", "done"],
  },
})
const more = await agent(`SESSION-2 Add one more step to: ${plan.steps.join(", ")}`, { label: "planner again", continue: "planner" })
return { plan, more }

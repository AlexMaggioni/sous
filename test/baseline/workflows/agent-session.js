export const meta = {
  name: "agent-session",
  description: "An agent step with a schema, then a second turn in the same session",
  inputs: { topic: { type: "string", description: "What to plan", default: "a small change" } },
  place: "none",
}

const planner = session({ label: "planner" })
const plan = await planner.send(`SESSION-1 Plan ${args.topic}.`, {
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
const more = await planner.send(`SESSION-2 Add one more step to: ${plan.steps.join(", ")}`, { label: "planner again" })
return { plan, more }

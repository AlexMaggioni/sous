export const meta = {
  name: "join",
  description: "An agent that needs the person, who steps into its session",
  place: "none",
}

return await agent("JOIN-ASK Pick the API, then build it.", { label: "builder" })

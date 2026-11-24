export const meta = {
  name: "deploy",
  description: "Deploy the app",
  inputs: { env: { type: "string", description: "Where to deploy", default: "staging" } },
  place: "none",
  startedBy: "people",
}

const out = await sh(`echo deployed to ${args.env}`, { label: "deploy" })
return out.stdout.trim()

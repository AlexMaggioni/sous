export const meta = {
  name: "factory",
  description: "Take open bug tickets from Linear, or from tickets/ without a key, and run the ticket workflow on each clear one",
  inputs: {
    team: { type: "string", description: "Linear team key, such as ENG. Empty takes every team.", default: "" },
    label: { type: "string", description: "Linear label of the tickets to take", default: "Bug" },
    limit: { type: "number", description: "Most tickets in one run", default: 5 },
    rounds: { type: "number", description: "Most review rounds per ticket", default: 2 },
  },
  outputs: { tickets: "Each ticket: built or skipped, and why" },
  // The factory itself changes nothing. Each ticket runs in a worktree of its own.
  place: "folder",
  concurrency: 2,
}

// A code step: Linear's API when LINEAR_API_KEY is set (environment or secrets.env), else the
// project's tickets/ folder.
const fetched = await js(
  `
  const key = process.env.LINEAR_API_KEY
  if (key) {
    const filter = { state: { type: { nin: ["completed", "canceled"] } }, labels: { name: { eq: input.label } } }
    if (input.team) filter.team = { key: { eq: input.team } }
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({
        query: "query($filter: IssueFilter, $first: Int) { issues(filter: $filter, first: $first) { nodes { identifier title description url } } }",
        variables: { filter, first: input.limit },
      }),
    })
    const body = await response.json()
    if (body.errors) throw new Error("Linear: " + JSON.stringify(body.errors))
    return body.data.issues.nodes.map((n) => ({ id: n.identifier, title: n.title, body: n.description || "", url: n.url }))
  }
  const fs = require("node:fs")
  if (!fs.existsSync("tickets")) return []
  return fs.readdirSync("tickets").filter((f) => f.endsWith(".md")).sort().slice(0, input.limit).map((file) => {
    const text = fs.readFileSync("tickets/" + file, "utf8")
    const [first, ...rest] = text.split("\\n")
    return { id: file.replace(/\\.md$/, ""), title: first.replace(/^#+\\s*/, ""), body: rest.join("\\n").trim() }
  })
  `,
  { team: args.team, label: args.label, limit: args.limit },
  { label: "fetch tickets" },
)
const tickets = fetched.result ?? []
log(`${tickets.length} tickets`)

const outcomes = await parallel(
  tickets.map((t) => async () => {
    const text = `# ${t.title}\n\n${t.body}`
    // An agent judges the ticket and picks the next step: build it, or leave it for a person.
    const picked = await choose(`Here is a bug ticket.\n\n${text}`, {
      agentType: "triager",
      label: `triage ${t.id}`,
      steps: {
        build: {
          description: "The ticket is clear enough to build without asking anyone",
          run: () => workflow("ticket", { ticket: text, rounds: args.rounds }, { place: "worktree", label: t.id }),
        },
        skip: {
          description: "The ticket is too vague to build; a person must add detail first",
          run: () => ({ skipped: true }),
        },
      },
    })
    return { id: t.id, title: t.title, choice: picked.choice, reason: picked.reason, result: picked.result }
  }),
)

return { tickets: outcomes }

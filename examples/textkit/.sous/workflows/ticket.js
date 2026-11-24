export const meta = {
  name: "ticket",
  description: "Implement a ticket, loop with a reviewer until it approves, verify it, and commit",
  inputs: {
    ticket: { type: "string", description: "What to build or fix", required: true },
    rounds: { type: "number", description: "Most review rounds", default: 3 },
    test: { type: "string", description: "The command that runs the tests", default: "npm test" },
    reviewer: { type: "string", description: "The agent that reviews", default: "reviewer" },
  },
  outputs: {
    approved: "Whether the reviewer approved",
    verified: "Whether the verifier passed it and the tests pass",
    rounds: "Review rounds used",
    commit: "The commit on the run's branch, when it passed and changed a file",
  },
  place: "worktree",
}

const ticket = String(args.ticket).trim()
const title = ticket.split("\n")[0].replace(/^#+\s*/, "").slice(0, 72)
const last = (text, n = 4000) => (text.length > n ? text.slice(text.length - n) : text)

phase("implement")
let implementer = "implementer"
await agent(`Implement this ticket in the current folder.\n\nTicket:\n${ticket}`, {
  agentType: "implementer",
  label: implementer,
  keepSession: true,
})

phase("review")
const verdictSchema = {
  type: "object",
  properties: { approved: { type: "boolean" }, review: { type: "string" } },
  required: ["approved", "review"],
}
let approved = false
let round = 0
while (round < args.rounds) {
  round++
  const diff = await sh("git add -A && git diff --cached", { label: `diff ${round}` })
  const verdict = await agent(
    `Review this change for the ticket below.\n\nTicket:\n${ticket}\n\nChange (git diff):\n${last(diff.stdout, 20000)}`,
    { agentType: args.reviewer, label: `reviewer ${round}`, schema: verdictSchema },
  )
  log(`review ${round}: ${verdict.approved ? "approved" : "changes asked"}`)
  if (verdict.approved) {
    approved = true
    break
  }
  if (round === args.rounds) break
  // The review goes to the implementer as plain text, in the implementer's own session.
  const next = `implementer ${round + 1}`
  await agent(`The reviewer asks for these changes:\n\n${verdict.review}\n\nMake them, then run the tests.`, {
    agentType: "implementer",
    label: next,
    continue: implementer,
    keepSession: true,
  })
  implementer = next
}

phase("verify")
const tests = await sh(args.test, { label: "tests", allowFail: true })
const check = await agent(
  `Check that this ticket is done in the current folder.\n\nTicket:\n${ticket}\n\n` +
    `The tests exited with ${tests.code}. Their output ends with:\n${last(tests.stdout + tests.stderr)}`,
  {
    agentType: "verifier",
    label: "verifier",
    schema: {
      type: "object",
      properties: { passed: { type: "boolean" }, evidence: { type: "string" } },
      required: ["passed", "evidence"],
    },
  },
)
const verified = check.passed && tests.code === 0

let commit
if (approved && verified) {
  // A ticket that needed no change leaves nothing to commit.
  const made = await sh(
    'git add -A && if git diff --cached --quiet; then echo; else git commit -q -m "$TITLE" && git rev-parse --short HEAD; fi',
    { label: "commit", env: { TITLE: title } },
  )
  commit = made.stdout.trim() || undefined
}

return { approved, verified, rounds: round, commit, evidence: check.evidence }

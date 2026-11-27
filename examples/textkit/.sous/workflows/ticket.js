export const meta = {
  name: "ticket",
  description: "Implement a ticket until its tests pass and a reviewer approves, verify it, and commit",
  inputs: {
    ticket: { type: "string", description: "What to build or fix", required: true },
    rounds: { type: "number", description: "Most review rounds", default: 3 },
    turns: { type: "number", description: "Most turns of the implementer, check turns included", default: 20 },
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

const verdictSchema = {
  type: "object",
  properties: { approved: { type: "boolean" }, review: { type: "string" } },
  required: ["approved", "review"],
}
let approved = false
let rounds = 0

// A fresh reviewer each round. What it asks for goes back into the implementer's own session. After
// the last round the implementer stops, and the workflow verifies without the reviewer's yes.
async function review() {
  rounds++
  const diff = await sh("git add -A && git diff --cached", { label: `diff ${rounds}`, phase: "review" })
  const verdict = await agent(
    `Review this change for the ticket below.\n\nTicket:\n${ticket}\n\nChange (git diff):\n${last(diff.stdout, 20000)}`,
    { agentType: args.reviewer, label: `reviewer ${rounds}`, until: "turn", schema: verdictSchema, phase: "review" },
  )
  log(`review ${rounds}: ${verdict.approved ? "approved" : "changes asked"}`)
  approved = verdict.approved
  if (approved || rounds >= args.rounds) return true
  return { ok: false, feedback: `The reviewer asks for these changes:\n\n${verdict.review}\n\nMake them, then run the tests.` }
}

// The implementer works until it says done. Then the tests run, and a failure goes back to it. Once
// they pass, the reviewer reads the change.
phase("implement")
const implementer = session({ agentType: "implementer", label: "implementer" })
try {
  await implementer.send(`Implement this ticket in the current folder.\n\nTicket:\n${ticket}`, {
    check: [args.test, review],
    maxTurns: args.turns,
  })
} catch (error) {
  if (error.code !== "STEP_LIMIT") throw error
  log(`the implementer used its ${args.turns} turns`)
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

return { approved, verified, rounds, commit, evidence: check.evidence }

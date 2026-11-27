export const meta = {
  name: "build",
  description: "Build one stage from its design. A planner cuts tickets, an implementer and a reviewer build each in its own worktree, and verifiers prove the gates",
  inputs: {
    design: { type: "string", description: "The stage's design, as text or as the file that holds it", required: true },
    from: { type: "string", description: "The commit the stage's skeleton started from, for the planner's change list", default: "" },
    test: { type: "string", description: "The command that runs the stage's tests. When empty, the planner's", default: "" },
    rounds: { type: "number", description: "Times the reviewer's blockers go back to the implementer before a fresh one takes the ticket", default: 3 },
    turns: { type: "number", description: "Most turns of one implementer, check turns included. 0 sets no limit", default: 0 },
    proofs: { type: "string", description: "The folder where the verifiers keep each gate's script and evidence", default: "proofs" },
    planner: { type: "string", description: "The agent that cuts the stage into tickets", default: "build-planner" },
    implementer: { type: "string", description: "The agent that builds a ticket", default: "implementer" },
    reviewer: { type: "string", description: "The agent that reviews a ticket's change", default: "reviewer" },
    verifier: { type: "string", description: "The agent that proves a gate", default: "verifier" },
  },
  outputs: {
    tickets: "Each ticket, landed with its commit, parked with why and its branch, or skipped with why",
    gates: "Each gate, passed, failed, human or blocked, with its evidence and the command that reruns its proof",
    gaps: "What the planner had to guess",
  },
  place: "worktree",
  concurrency: 3,
}

// A build runner as one workflow. A planner cuts the stage into tickets. Each ticket starts once
// the tickets it needs have landed, in a worktree of its own. Its implementer writes the tests
// first and works until it says done. Then the stage's tests run, and a reviewer of its own reads
// the change. The reviewer's blockers go back to the implementer word for word. After `rounds`
// rounds with blockers, or when the implementer is stuck, one fresh implementer takes the ticket
// in the same folder. A second failure parks it, and the tickets that need it are skipped. So does
// a ticket stuck because of the design. A ticket lands as one commit, rebased on the run's branch.
// Then a verifier proves each gate. A failed proof gets one fix ticket, then its script runs again.

const design = String(args.design).trim()
const last = (text, n = 4000) => (text.length > n ? text.slice(text.length - n) : text)
const turns = args.turns ? { maxTurns: args.turns } : {}

// The agents this was written for keep a record through `handoff`, `plan` and `design` calls. This
// workflow keeps none, so each prompt carries what they would read, and each answer what they
// would record.
const NO_RECORD =
  "This build keeps no record files, so skip each `handoff`, `plan` and `design` call your instructions name. " +
  "This prompt holds what they would show you, and your answer holds what you would record."
const DESIGN = `The stage's design, or the file that holds it:\n\n${design}`

const PLAN = {
  type: "object",
  properties: {
    tickets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          body: { type: "string", description: "What it builds, its bodies, its files, and its tests with what each expects" },
          needs: { type: "array", items: { type: "string" }, default: [], description: "The ids of the tickets it needs first" },
          gates: { type: "array", items: { type: "string" }, default: [], description: "The ids of the gates it serves" },
          tested: { type: "boolean", default: true, description: "False when the ticket has no tests of its own" },
        },
        required: ["id", "title", "body", "needs", "gates", "tested"],
      },
    },
    gates: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, words: { type: "string", description: "The gate in the design's own words" } },
        required: ["id", "words"],
      },
    },
    test: { type: "string", default: "", description: "The command that runs the stage's tests" },
    gaps: { type: "array", items: { type: "string" }, default: [] },
  },
  required: ["tickets", "gates", "test", "gaps"],
}

const BUILT = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["built", "stuck"] },
    reply: {
      type: "string",
      description: "The files you wrote, the last line of the test output, and each interface change or guess. When stuck, why and what you tried",
    },
    red: {
      type: "string",
      description: "The output of the ticket's tests when you first saw them fail, before the code. Empty when the ticket has no tests",
    },
    byDesign: {
      type: "boolean",
      default: false,
      description: "When stuck: true when the design itself stops the ticket, so a fresh implementer could not finish it either",
    },
  },
  required: ["outcome", "reply", "red", "byDesign"],
}

const REVIEW = {
  type: "object",
  properties: {
    blockers: {
      type: "array",
      default: [],
      items: {
        type: "object",
        properties: { what: { type: "string" }, where: { type: "string" }, evidence: { type: "string" } },
        required: ["what", "where", "evidence"],
      },
    },
    warnings: { type: "array", items: { type: "string" }, default: [] },
  },
  required: ["blockers", "warnings"],
}

const PROOF = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["passed", "failed", "human", "blocked"] },
    evidence: { type: "string" },
    rerun: { type: "string", description: "The command that reruns the gate's script, from the repository root" },
    steps: { type: "array", items: { type: "string" }, default: [], description: "When a person must judge it: one action per step, each with what they should see" },
    byDesign: { type: "boolean", default: false, description: "True when no change the design allows can make it pass" },
  },
  required: ["verdict", "evidence", "rerun", "steps", "byDesign"],
}

// The reviewer's answer, as the implementer reads it.
const said = (review) =>
  [
    ...review.blockers.map((b) => `Blocker at ${b.where}: ${b.what} Evidence: ${b.evidence}`),
    ...review.warnings.map((w) => `Warning: ${w}`),
  ].join("\n") || "No blockers."

phase("plan")
const plan = await agent(
  `Plan the build of this stage. ${NO_RECORD}\n\n${DESIGN}\n\n` +
    (args.from ? `The change list is \`git diff --name-status ${args.from}\`.\n\n` : "") +
    "Your answer holds the tickets, the stage's gates in the design's own words, the command that runs the " +
    "stage's tests, and the gaps. A ticket's needs name the tickets it needs first, its gates the ids of the gates " +
    "it serves, and tested is false when it has no tests of its own.",
  { agentType: args.planner, label: "planner", schema: PLAN },
)
const test = String(args.test || plan.test).trim()
log(`the plan: ${plan.tickets.length} tickets, ${plan.gates.length} gates, ${plan.gaps.length} gaps`)

const byId = new Map(plan.tickets.map((ticket) => [ticket.id, ticket]))
if (byId.size !== plan.tickets.length) throw new Error("The plan names a ticket id twice.")

// The tickets with each one after those it needs, so each ticket starts in its own branch of
// parallel() below. A circle of needs could never start.
const ordered = []
const seen = new Map()
function visit(ticket, path) {
  if (seen.get(ticket.id) === "done") return
  if (seen.get(ticket.id) === "open") throw new Error(`The plan's tickets need each other in a circle: ${[...path, ticket.id].join(", ")}`)
  seen.set(ticket.id, "open")
  for (const id of ticket.needs) if (byId.has(id)) visit(byId.get(id), [...path, ticket.id])
  seen.set(ticket.id, "done")
  ordered.push(ticket)
}
for (const ticket of plan.tickets) visit(ticket, [])

// One ticket lands at a time, since each lands on the run's branch.
let landing = Promise.resolve()
const oneAtATime = (fn) => {
  const next = landing.then(fn)
  landing = next.catch(() => {})
  return next
}

const COMMIT = 'git add -A && if ! git diff --cached --quiet; then git commit -q --no-verify -m "$MSG"; fi'
// Run in the run's folder: rebase the ticket's branch on the run's branch, then move the run's
// branch to it. A conflict leaves the ticket as it was and prints the commit it could not take.
const LAND =
  'main=$(git rev-parse HEAD); if ! git -C "$TREE" rebase -q "$main" >/dev/null 2>&1; then git -C "$TREE" rebase --abort; echo "$main"; exit 1; fi; ' +
  'git merge -q --ff-only "$BRANCH" && git rev-parse --short HEAD'
// The ticket's change as a tree, through an index of its own, so the implementer's index stays.
const SNAPSHOT = 'export GIT_INDEX_FILE="$(mktemp -u)"; git read-tree HEAD && git add -A && git write-tree; rm -f "$GIT_INDEX_FILE"'
const REBASED =
  'test ! -d "$(git rev-parse --git-path rebase-merge)" && test ! -d "$(git rev-parse --git-path rebase-apply)" && git merge-base --is-ancestor "$MAIN" HEAD'

async function build(ticket) {
  const { id, title } = ticket
  log(`${id} started: ${title}`)
  const impl = session({ agentType: args.implementer, label: `${id} implementer`, place: "worktree" })
  const where = impl.cwd
  const reviewer = session({ agentType: args.reviewer, label: `${id} reviewer`, cwd: where })
  const state = { base: (await sh("git rev-parse HEAD", { cwd: where, label: `${id} base` })).stdout.trim() }
  state.before = state.base
  let runs = 0
  let reviews = 0
  let rounds = 0

  const gates = plan.gates.filter((gate) => ticket.gates.includes(gate.id))
  const brief =
    `Build this ticket of the stage. ${NO_RECORD}\n\nThe ticket:\n${ticket.body}\n\n` +
    (gates.length ? `It serves these gates:\n${gates.map((gate) => `- ${gate.id}: ${gate.words}`).join("\n")}\n\n` : "") +
    `${DESIGN}\n\nYou work in ${where}, a worktree of your own. Other implementers may build other tickets at the same ` +
    `time, each in its own folder. ${test ? `The stage's tests run with \`${test}\`. ` : ""}` +
    "Write the ticket's tests first, and see each fail for the reason the ticket expects. Your answer's red holds " +
    "that output. Then write the code until they pass. Never skip a test, mark it as expected to fail, or make it " +
    "check less. Don't commit. The workflow commits your work once the reviewer has no blocker left. When you are " +
    "stuck, answer with the outcome stuck, and say why and what you tried. Set byDesign when the design itself " +
    "stops the ticket."

  // When the implementer says done: the stage's tests, then the reviewer. A failure goes back to
  // the implementer in its own session.
  async function checked(result) {
    if (result.outcome === "stuck") {
      state.end = {
        why: result.reply,
        final: result.byDesign,
        notes: `An earlier implementer stopped on this ticket. Start from its work in this folder, or set it aside, as the evidence says. Its why: ${result.reply}`,
      }
      return true
    }
    if (state.rebased) {
      const rebased = await sh(REBASED, { cwd: where, label: `${id} rebased`, env: { MAIN: state.main }, allowFail: true })
      if (rebased.code !== 0) {
        state.end = { why: "its rebase did not finish", final: true }
        return true
      }
    }
    if (result.red.trim()) state.red ??= result.red.trim()
    if (ticket.tested && state.red === undefined) {
      if (state.askedRed) {
        state.end = { why: "its tests were never seen failing", final: true }
        return true
      }
      state.askedRed = true
      return {
        ok: false,
        feedback:
          "Your answer gives no output of the ticket's tests failing. Write them first and see them fail for the reason " +
          "the ticket expects, then answer with that output in red. Or answer stuck with why.",
      }
    }
    if (test) {
      runs++
      const ran = await sh(test, { cwd: where, label: `${id} tests ${runs}`, allowFail: true })
      if (ran.code !== 0) {
        return {
          ok: false,
          feedback:
            `The stage's tests failed with exit code ${ran.code}. Their output ends with:\n\n${last(ran.stdout + ran.stderr)}\n\n` +
            "Fix it, then finish. When the failure is outside your ticket, or the tests still fail after two real attempts " +
            "at the cause, stop and answer that you are stuck.",
        }
      }
    }
    reviews++
    const now = (await sh(SNAPSHOT, { cwd: where, label: `${id} change ${reviews}` })).stdout.trim()
    const review = await reviewer.send(
      state.rebased
        ? `Other tickets landed, and the implementer rebased this ticket on them and resolved the conflicts. Its reply, ` +
          `word for word:\n\n${result.reply}\n\nThe ticket's change is now \`git diff ${state.main} ${now}\`. Check only ` +
          "that the resolution keeps both tickets' work and that the ticket's tests pass, then answer with the review again."
        : reviews === 1
          ? `Review ticket ${id} of this stage: ${title}. ${NO_RECORD}\n\nThe ticket:\n${ticket.body}\n\n${DESIGN}\n\n` +
            `The work is in ${where}. The ticket's change is \`git diff ${state.base} ${now}\`. ` +
            (test ? `The stage's tests run with \`${test}\`. ` : "") +
            `Change no file. Your answer's blockers and warnings are your review.\n\n` +
            (state.red ? `The ticket's tests when they first failed, as the implementer gives them:\n\n${state.red}\n\n` : "") +
            `What the implementer says it did, to check, not to trust:\n\n${result.reply}`
          : `The implementer answered, word for word:\n\n${result.reply}\n\nThe fix is \`git diff ${state.before} ${now}\`, ` +
            `and the whole change \`git diff ${state.base} ${now}\`. Check only the open blockers and the fix, then answer ` +
            "with the review again.",
      { label: `${id} review ${reviews}`, schema: REVIEW },
    )
    state.before = now
    state.rebased = false
    if (review.blockers.length === 0) return true
    rounds++
    log(`${id}: ${review.blockers.length} blocker${review.blockers.length === 1 ? "" : "s"}`)
    if (rounds > args.rounds) {
      state.end = {
        why: `its reviewer left blockers open after ${args.rounds} round${args.rounds === 1 ? "" : "s"}: ${review.blockers.map((b) => b.what).join("; ")}`,
        notes: `An earlier implementer built this ticket, and its reviewer left these blockers open, word for word:\n\n${said(review)}`,
      }
      return true
    }
    return { ok: false, feedback: `The reviewer's answer, word for word:\n\n${said(review)}` }
  }

  // One send of an implementer, its checks included. Nothing when the ticket passed them, else why
  // not, the notes for a fresh implementer, and final when a fresh one could not do better.
  async function attempt(handle, text, label) {
    state.end = undefined
    rounds = 0
    try {
      await handle.send(`Ticket ${id}: ${title}.\n\n${text}`, { label, schema: BUILT, check: checked, ...turns })
    } catch (error) {
      if (error.code !== "STEP_LIMIT") throw error
      state.end = {
        why: `it used its ${args.turns} turns`,
        notes: `An earlier implementer used its ${args.turns} turns on this ticket. Start from its work in this folder, or set it aside.`,
      }
    }
    return state.end
  }

  // The work stays on the ticket's branch. A branch with no commit goes when the workflow ends.
  async function park(why) {
    const kept = await sh(`${COMMIT}; git rev-list --count "$BASE"..HEAD`, {
      cwd: where,
      label: `${id} park`,
      env: { MSG: `${id} ${title}, parked`, BASE: state.base },
    })
    log(`${id} parked: ${why}`)
    return { id, title, status: "parked", why, ...(kept.stdout.trim() === "0" ? {} : { branch: impl.branch }) }
  }

  let handle = impl
  let end = await attempt(impl, brief, `${id} build`)
  if (end && !end.final) {
    log(`${id}: a fresh implementer takes it`)
    handle = session({ agentType: args.implementer, label: `${id} implementer 2`, cwd: where })
    end = await attempt(handle, `${brief}\n\n${end.notes}`, `${id} build 2`)
  }
  if (end) return park(end.why)

  for (let tries = 1; ; tries++) {
    await sh(COMMIT, { cwd: where, label: `${id} commit${tries > 1 ? ` ${tries}` : ""}`, env: { MSG: `${id} ${title}` } })
    const env = { TREE: where, BRANCH: impl.branch }
    const landed = await oneAtATime(() => sh(LAND, { label: `${id} land${tries > 1 ? ` ${tries}` : ""}`, env, allowFail: true }))
    if (landed.code === 0) {
      log(`${id} landed`)
      return { id, title, status: "landed", commit: landed.stdout.trim(), reviews }
    }
    if (tries === 3) return park("it could not land after three rebases")
    state.main = landed.stdout.trim()
    state.rebased = true
    const end = await attempt(
      handle,
      `Other tickets landed while you worked. Your work is committed on ${impl.branch}. Run \`git rebase ${state.main}\` ` +
        "here, resolve each conflict so both tickets' work stays, run the stage's tests, and reply with the files you resolved.",
      `${id} rebase ${tries}`,
    )
    state.base = state.main
    if (end) return park(end.why)
  }
}

// A ticket starts once each ticket it needs has landed. One that needs a ticket that did not land
// is skipped.
const started = new Map()
function start(ticket) {
  if (!started.has(ticket.id)) {
    started.set(ticket.id, (async () => {
      const needs = await Promise.all(ticket.needs.map((id) => (byId.has(id) ? start(byId.get(id)).catch(() => null) : null)))
      const missing = ticket.needs.filter((_, i) => needs[i]?.status !== "landed")
      if (missing.length) {
        log(`${ticket.id} skipped: it needs ${missing.join(", ")}`)
        return { id: ticket.id, title: ticket.title, status: "skipped", why: `it needs ${missing.join(", ")}, which did not land` }
      }
      return build(ticket)
    })())
  }
  return started.get(ticket.id)
}

phase("build")
const built = await parallel(ordered.map((ticket) => () => start(ticket)))
const outcome = new Map(
  ordered.map((ticket, i) => [ticket.id, built[i] ?? { id: ticket.id, title: ticket.title, status: "failed", why: "a step failed, as the log says" }]),
)

phase("prove")
async function prove(gate, n, failure) {
  const serving = plan.tickets.filter((ticket) => ticket.gates.includes(gate.id))
  const proof = await agent(
    `Prove this gate on the running result. ${NO_RECORD}\n\nThe gate ${gate.id}, in the design's own words:\n${gate.words}\n\n` +
      (serving.length ? `The tickets that serve it:\n${serving.map((ticket) => `- ${ticket.id}: ${ticket.title}`).join("\n")}\n\n` : "") +
      `${DESIGN}\n\nKeep the gate's script and its evidence in ${args.proofs}/. ` +
      (failure ? `Its script failed on a rerun after a fix: \`${failure.rerun}\` exited with ${failure.code}, and its output ends with:\n${failure.output}\n\n` : "") +
      "Your answer is the proof: its verdict, the evidence, the command that reruns its script from the repository " +
      "root, the steps when only a person can judge it, and byDesign when no change the design allows can make it pass.",
    { agentType: args.verifier, label: `prove ${gate.id}${n > 1 ? ` ${n}` : ""}`, schema: PROOF },
  )
  log(`${gate.id}: ${proof.verdict}`)
  return { id: gate.id, ...proof }
}

// A gate whose tickets did not all land is blocked, and no verifier starts on it.
const blocked = (gate, evidence) => ({ id: gate.id, verdict: "blocked", evidence, rerun: "", steps: [], byDesign: false })
const proofs = (
  await parallel(
    plan.gates.map((gate) => () => {
      const open = plan.tickets.filter((ticket) => ticket.gates.includes(gate.id) && outcome.get(ticket.id).status !== "landed")
      return open.length ? blocked(gate, `${open.map((ticket) => ticket.id).join(", ")} did not land`) : prove(gate, 1)
    }),
  )
).map((proof, i) => proof ?? blocked(plan.gates[i], "its verifier's step failed, as the log says"))
// The fix tickets start from the run's branch, so they find the proofs' scripts there.
await sh(COMMIT, { label: "commit proofs", env: { MSG: "The proofs of the stage's gates" } })

// A proof that failed because of the build gets one fix ticket. Then its script runs again with
// no agent, and a verifier starts only when it still fails.
const fixable = plan.gates.filter((gate, i) => proofs[i]?.verdict === "failed" && !proofs[i].byDesign)
const fixes = await parallel(
  fixable.map((gate) => async () => {
    const proof = proofs[plan.gates.indexOf(gate)]
    const fix = await build({
      id: `${gate.id} fix`,
      title: `Make the proof of ${gate.id} pass`,
      body:
        `The proof of gate ${gate.id} failed. Its evidence:\n${proof.evidence}\n\nIts script reruns with \`${proof.rerun}\`. ` +
        "Write a test that shows the failure first, then the code. Never change the proof's script.",
      needs: [],
      gates: [gate.id],
      tested: true,
    })
    if (fix.status !== "landed") return { ...proof, fix }
    // A proof with no command to rerun gets a verifier again.
    if (!proof.rerun.trim()) return { ...(await prove(gate, 2)), fix }
    const again = await sh(proof.rerun, { label: `${gate.id} rerun`, allowFail: true })
    if (again.code === 0) return { ...proof, verdict: "passed", evidence: last(again.stdout + again.stderr, 2000), fix }
    return { ...(await prove(gate, 2, { rerun: proof.rerun, code: again.code, output: last(again.stdout + again.stderr) })), fix }
  }),
)
const gates = proofs.map((proof, i) => {
  const fixed = fixable.indexOf(plan.gates[i])
  return fixed === -1 ? proof : (fixes[fixed] ?? proof)
})

await sh(COMMIT, { label: "commit proofs 2", env: { MSG: "The proofs of the stage's gates, after the fixes" } })

return {
  tickets: ordered.map((ticket) => outcome.get(ticket.id)),
  gates,
  gaps: plan.gaps,
}

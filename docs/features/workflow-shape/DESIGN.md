# Workflow shape: the design

How sous gets from the engine at `0ad4e5b9` to the scenarios in `ACCEPTANCE.md`. Nothing is built
yet. This work changed no code. Its only model calls are the live tests it reports.

Written on 2026-11-26 from the code, `ACCEPTANCE.md`, `PROPOSAL.md` and the rooms draft in
`docs/features/rooms/DESIGN.md`. Every statement about the code comes from reading it and cites
`path:line`. Paths without a package are under `packages/engine/src`. `claude/` and `codex/` are
under `packages/harnesses/src`, and `sdk.d.ts` is the type file of the Agent SDK 0.3.330 that sous
pins. A statement that only a real run can settle says "needs a live test". A statement I could
not confirm says "not confirmed".

## The answer in short

sous keeps the journal, the call hash, replay by occurrence, the inbox, the steering board and the
worktree code. It changes five things.

1. A prompt reaches the program byte for byte. The label line and the contract paragraph leave it.
2. A step ends when the agent reports `done` through the program's own output schema. One turn
   that ends by itself is the exception a step asks for.
3. A session is a value in the script. `session()` makes one, `send()` runs a step in it, and
   `fork()` copies it. `agent()` stays as the form for one step in a fresh session.
4. A resumed run goes on in the same session and the same folder, whatever stopped it.
5. When a step needs the person, or whenever the person wants, they step into its live session
   in the program's own terminal screen. The rest of the run keeps going. sous has no channel of
   its own for questions.

## Words

| Word | Meaning |
| --- | --- |
| session | One conversation in a program. It is a Claude Code session or a Codex thread. |
| turn | One prompt sent into a session, and everything the program does until it is idle again. Under `/goal` one turn holds several model turns. A turn is one row in the journal. |
| step | One `agent()` or `send()` call in the script. It runs turns until its end condition holds. |
| status | What the agent reports at the end of a turn. It is `done`, `working` or `question`. |
| place | The folder a step works in. It belongs to the run, to a nested workflow or to one session. |

## What stays from PROPOSAL.md and what goes

Kept:

The decision numbers in this section are PROPOSAL.md's.

- The status in the answer, as one flat object, read through the native schema. Its decision 1,
  option A.
- The loop built from `agent()` calls, with one journal row per turn.
- `check` after `done`, as a command, a function or a list, with a failure sent back into the
  same session. Its decision 4.
- `maxTurns`, but with no default. The owner wants every limit off unless the script sets it.
- `room()` built from agent calls. Its decision 5.
- A step's worktree belongs to its session and its branch stays. Its decision 6, option C.
- A session the program can't find stops the step. It never starts fresh without a word.
- Every code fact. I read each one again.

Dropped:

- The `command` option of its decision 2. The owner overruled it. A prompt goes in as written.
- `until: "done"` as an opt-in. It is the default now.
- `session: "<name>"` as a string option, its decision 3. Handles replace it, for the reasons
  in decision 1 below.
- "A 0.1.0 script runs unchanged." This design takes breaking changes, listed under
  [Resume and the journal](#resume-and-the-journal).
- The old names kept alive: `keepSession`, `continue`, `isolation`, `gate`, `retry`, `checkpoint`.
  They are refused with a message, as `tier` is today (`workflow.ts:371-378`). An agent file's
  `isolation: worktree` is the exception. It reads as `place: "worktree"`.
- The pause when turns run out. `maxTurns` fails the step, as decision 6 below says.

## The new shape

### Step kinds

| Step | Takes | Ends when | Returns |
| --- | --- | --- | --- |
| `agent(prompt, options)` | A prompt as written, images, and the options of a session and of a step. | The agent reports `done` and every check passes. With `until: "turn"`, when its one turn ends. | The answer text, or the value of its `schema`. |
| `handle.send(prompt, options)` | The same, in the handle's session. | The same. | The same. |
| `sh(command, { input, schema })` | A command. `input` goes to stdin as JSON. | The process exits. | `{ code, stdout, stderr, result }`. With a `schema`, sous reads stdout as JSON and checks it, and a misfit fails the step. |
| `js`, `py`, `run` | A source or a file. `input` goes in as JSON. | The process exits. | `{ code, stdout, stderr, result }`. |
| `waitUntil(command, { every, input, schema })` | A command and `every`. `input` is passed to the command. | The command exits 0, or `timeout` runs out. | The same as `sh`. With a `schema`, sous checks the value the command returns. |
| `ask(question, { input, schema })` | A question, `choices`, `answeredBy`. `input` shows with the question. | A person answers, or an agent with `answeredBy: "anyone"`. With a `schema`, sous refuses an answer that does not fit, gives the reason and asks again. | The answer as text, or the schema's value. |
| `breakpoint(title, step, { input, schema })` | A title and what to show. `input` shows with it. | The person approves, stops or sends back. `schema` checks the answer as for `ask`. | The approved result. |
| `workflow(name, args, { place, label })` | `args`, checked against the child's `meta.inputs` before its first step. A `place` here overrides the child's `meta.place`. | The child script returns. | The child's result, checked against its `meta.schema`. |
| `room(options)` | A goal, member handles, opening messages. `input` goes into each member's opening message. | Decided, agreed, quiet or at its round limit. | `{ ended, decision, rounds, transcript, members }`. sous checks the decision against `schema`. |
| `parallel`, `pipeline`, `choose` | Functions. | Every branch settles. | A list, or the choice and its result. |
| `phase(title)`, `log(message)` | Text. | At once. | Nothing. |

The script has 16 functions. They are today's 17 (`workflow.ts:1902-1919`) without `gate`,
`retry` and `checkpoint`, and with `session` and `room`.

### Sessions

```js
const impl = session({ label: "implementer", agentType: "implementer", place: "worktree" })
const summary = await impl.send("Implement the ticket.", { check: "npm test" })
const trial = impl.fork({ label: "trial" })
```

- `session(options)` makes a handle and starts nothing. The first `send()` starts the session.
  `label` is required, and it names one handle in its workflow. A second `session()` or
  `fork()` with a label already in use fails the script, because the session's worktree name
  and `sous join` find the session by it. A nested workflow has its own labels.
  An `agent()` step's label may repeat, as step labels do today, since no later step uses its
  session. Its own worktree, when it has one, is named for its label and occurrence. Given a
  repeated label, `sous join` picks its latest step.
- A handle owns who runs and where: `label`, `agentType`, `model`, `effort`, `mode`, `skills`,
  `mcp`, `mcpServers`, `place`, `cwd`. They are set once and hold for every turn.
- `send(prompt, options)` takes what belongs to one step: `label`, `schema`, `until`, `check`,
  `maxTurns`, `maxRepairs`, `ask`, `timeout`, `retries`, `images`, `phase`, and a `model` on the
  same program. Each limit among them is off unless the script sets it.
- The `label` of `send()` names that one step for `sous log`, `sous tell` and `--answers`.
  `sous join` and the notice use the handle's label, since they reach the session.
- `--set <label>.<option>` on a handle may change only its model, on the same program. sous
  refuses any other `--set` on a handle.
- `fork(options)` returns a new handle. It records the parent's session as it is at the `fork()`
  call, which is its last finished turn. Forking a handle that has not run yet throws. Nothing the
  fork does reaches the original.
- `agent(prompt, options)` is `session(options).send(prompt, options)` for a session no later
  step uses. It takes both lists of options.
- A handle has `label`, `cwd` and `branch` as plain strings, for code steps:
  `sh("npm test", { cwd: impl.cwd })`.
- A handle runs one turn at a time. A second `send()` while one runs fails the script.
- A handle lives in the workflow that made it. `workflow()` passes JSON, so a nested workflow
  makes its own sessions.

### How a step ends

Each turn answers with one flat object, through the program's native schema:

```json
{ "status": "done", "result": "<the text, or the schema's value>", "message": null }
{ "status": "working", "result": null, "message": "Parts 4 and 5 are left." }
{ "status": "question", "result": null, "message": "Return 404 or an empty list?" }
```

- `done` runs the checks. When all pass, the step returns the `result` of that `done` status,
  whichever turn gave it.
- `working` starts another turn in the same session with the fixed prompt `Continue the task.`
  An agent that asks whether to go on reports `working`, so sous sends it back to work.
- `question` means the agent needs the person. The step waits, and sous tells the person to step
  into the session. When they leave it, the next turn sends `Continue the task.`
- A failed check starts another turn with the check's feedback as the prompt.
- A step runs turns until `done`, with no limit. With `maxTurns` set, it fails when it reaches
  the limit. `maxTurns` counts every turn sous sends in the step, replayed turns, report turns
  and repair turns included. The person's own turns are not sous's and do not count.
- `until: "turn"` ends the step when its one turn ends, with the text or the schema's value. It
  has no status. A reviewer with a verdict schema is the usual case. Such a step can still need
  the person, through the program's own question tool, as decision 9 says.

### Places

`place: "worktree"` means the same thing at three scopes.

| Scope | Written as | The worktree lives until | Branch |
| --- | --- | --- | --- |
| The run | `meta.place` or `--place` | the run ends | `sous/<run>` |
| A nested workflow | `workflow(name, args, { place: "worktree" })` | the nested workflow returns | `sous/<nested run id>` |
| A session or one step | `session({ place: "worktree" })`, `agent(prompt, { place: "worktree" })` | the workflow that made the session returns, or the one step ends | `sous/<run id>-<label>-<suffix>` |

A step without `place` works in the folder of the workflow it is in. Each new worktree starts
from the `HEAD` of the folder around it. A `place` passed to `workflow()` overrides the child's
`meta.place`, so a nested workflow has one worktree. In a session's branch, `<run id>` is the id
of the run or nested run that made the session. The suffix keeps apart two labels whose slugs
match. For a session it is a short hash of the run id and the full label, and for one step it is
the call's occurrence. When a scope ends, sous commits leftover work. The branch stays and the
folder goes.

### Rooms and being alone

An agent is alone unless the script puts it in a room. Being alone has three parts, and the
script sets each one apart.

| Part | Alone | Shared |
| --- | --- | --- |
| What it hears | Its own prompts and nothing else. | The transcript of a `room()` it is a member of. |
| What it starts from | `session()` or `agent()` starts a fresh session. | The same handle again holds everything it did before. `fork()` starts from a copy of another session. |
| Which files it sees | `place: "worktree"` gives it its own branch. | With no `place` it works in the folder of its workflow. |

`room({ members: [claude, gpt, mediator] })` takes handles. A member that worked alone before the
room keeps its session in the room and after it.

### The person in the loop

The person always works in the agent's own session. sous has no channel of its own for an
agent's questions.

- When a step needs the person, sous says so in the log, in a notice and on the page. The log
  and the notice name the handle and the command that steps in. The page shows "This agent needs
  you" and the `sous join` line. None of them shows the agent's message or takes an answer.
- `sous join <run> <label>` opens the step's session in the program's own terminal screen, in
  the session's folder. `<run>` is the id of the run that owns the session, a nested run's id
  included, as `sous log` and `sous status` show it. `<label>` is the handle's label, unique in
  that run. The person reads what the agent did, asks it things, answers it, or does part of the
  work. When they quit the program, the step goes on in the same session.
- `sous join` works on any agent step, waiting, running or idle. On a running step it stops that
  step's turn and nothing else. Every other step of the run keeps going, as two sessions opened
  by hand do.
- `sous tell` still puts a message into a running turn without stopping it.

### Script 1. A ticket with an implementer and a reviewer in one worktree

```js
export const meta = {
  name: "ticket",
  description: "Implement a ticket until its tests pass and a reviewer approves",
  inputs: {
    ticket: {
      type: "json",
      required: true,
      schema: {
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
        required: ["id", "title", "body"],
      },
    },
    test: { type: "string", description: "The command that runs the tests", default: "npm test" },
  },
  schema: {
    type: "object",
    properties: { branch: { type: "string" }, summary: { type: "string" }, tests: { type: "string" } },
    required: ["branch", "summary", "tests"],
  },
  place: "worktree",
}

const { ticket } = args
const impl = session({ label: "implementer", agentType: "implementer" })

// A fresh reviewer each round. What it asks for goes back into the implementer's session.
const review = async (_summary, round) => {
  const diff = await sh("git add -A && git diff --cached", { label: `diff ${round}` })
  const verdict = await agent(
    `Review this change for the ticket.\n\nTicket:\n${ticket.body}\n\nChange:\n${diff.stdout.slice(-20000)}`,
    {
      agentType: "reviewer",
      label: "reviewer",
      until: "turn",
      schema: {
        type: "object",
        properties: { approved: { type: "boolean" }, review: { type: "string" } },
        required: ["approved", "review"],
      },
    },
  )
  return verdict.approved || { ok: false, feedback: `The reviewer asks for these changes:\n\n${verdict.review}` }
}

const summary = await impl.send(
  `Implement this ticket in the current folder.\n\n# ${ticket.title}\n\n${ticket.body}`,
  { check: [args.test, review], maxTurns: 12 },
)

await sh('git add -A && git commit -q -m "$TITLE"', { label: "commit", env: { TITLE: ticket.title }, allowFail: true })
const branch = await sh("git rev-parse --abbrev-ref HEAD", { label: "branch" })
return { branch: branch.stdout.trim(), summary, tests: "passed" }
```

The implementer and the reviewer have no `place`, so both work in the workflow's worktree. The
implementer keeps one session through every round. Each reviewer starts fresh. Today's version
needs 90 lines and a label it changes each round
(`examples/textkit/.sous/workflows/ticket.js:24-61`).

### Script 2. An epic with one worktree per ticket

```js
export const meta = {
  name: "epic",
  description: "Split an epic into tickets and build each one in its own worktree",
  inputs: { epic: { type: "string", required: true } },
  place: "folder",
  concurrency: 3,
}

const plan = await agent(`Split this epic into tickets that can be built apart.\n\n${args.epic}`, {
  agentType: "build-planner",
  label: "planner",
  schema: {
    type: "object",
    properties: {
      tickets: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
          required: ["id", "title", "body"],
        },
      },
    },
    required: ["tickets"],
  },
})

const built = await parallel(
  plan.tickets.map((ticket) => () =>
    workflow("ticket", { ticket }, { place: "worktree", label: ticket.id }).catch((error) => ({ error: error.message })),
  ),
)

return { tickets: plan.tickets.map((ticket, i) => ({ id: ticket.id, ...built[i] })) }
```

The epic changes no file itself. Each ticket workflow gets a branch from the project's `HEAD`.
The `place` here overrides the child's own `meta.place`, so each ticket has one worktree. A
ticket whose `title` is missing fails in `workflow()`, before the child's first step. Its branch
catches the error, and the other tickets return their results.

### Script 3. Alone, a room, a fork and a slash command

```js
const claude = session({ label: "claude", model: "claude/opus", agentType: "designer" })
const gpt = session({ label: "gpt", model: "codex/gpt-6-luna", agentType: "designer" })
const mediator = session({ label: "mediator", model: "claude/opus", agentType: "mediator" })

// Alone: each proposer has its own session and hears nothing of the other.
const [a, b] = await parallel([claude, gpt].map((s) => () => s.send(`Propose a design for:\n${args.intent}`)))

// Together: the same two sessions meet, with a mediator who decides.
const agreed = await room({
  goal: `Agree on one design for:\n${args.intent}`,
  members: [claude, gpt, mediator],
  opening: [{ from: "claude", to: "all", text: a }, { from: "gpt", to: "all", text: b }],
  decider: mediator,
  schema: { type: "object", properties: { design: { type: "string" } }, required: ["design"] },
  maxRounds: 6,
})

// A fork knows the whole discussion. What it says never reaches the mediator.
const critic = mediator.fork({ label: "critic" })
const risks = await critic.send("Name the weakest point of the design we agreed on.")

// The prompt goes in as written, so the program runs /goal as it does by hand.
await mediator.send("/goal docs/design.md holds the agreed design and `npm run lint:docs` exits 0", {
  check: "npm run lint:docs",
  timeout: "1h",
})
return { design: agreed.decision.design, risks }
```

## Decisions

### 1. Session handles or named sessions

| Option | For | Against |
| --- | --- | --- |
| A. Keep `keepSession` and `continue`, and make the fallbacks fail. | The smallest change. | `continue` names a step's label, so a loop needs a label that changes each round. `keepSession` does nothing at run time (`workflow.ts:432-436`, `:592-601`). A fork needs a third option. |
| B. `session: "<name>"` on `agent()`, as PROPOSAL.md has it. | One option. A string is easy to read from the text, so `sous check` and the graph find it. | The first step that uses a name decides its program, model and folder, and later steps can disagree. A typo starts a second session. A fork needs two more options. A room member is a string that may match nothing. |
| C. A handle, as in `const impl = session({...})`, then `impl.send(prompt)`. | The program, the model and the folder are set once, where the handle is made. A typo is a JavaScript error. `fork()` returns a handle. A room takes handles. The handle is the owner a worktree needs for its lifetime. | A new kind of value in the script. The text readers read only plain calls today (`workflows/script.ts:313`, `workflows/flow.ts:330`), so they must learn `<name>.send(...)`. |

**The choice is C.** Three things the owner asked for need an owner object: a fork, a room member
and a worktree that outlives one step. With a string, each of them becomes one more option and
one more rule about which step set it first.

The cost is small. `flow.ts` already keeps a scope of the names the text binds
(`workflows/flow.ts:331`) and already reads member calls (`workflows/flow.ts:341`). `script.ts`
reads `agentType`, `model` and `mcp` from any object in the text
(`workflows/script.ts:332-346`), so it sees `session({ agentType: "reviewer" })` today. A handle
built at run time, such as `panel.map((p) => session(p))`, shows on the graph with a note, as a
label built at run time does now.

A handle reaches the engine through a key. Each `send()` calls the engine's `agent()`
with `session: { key, start }`, where `start` is `fresh`, `kept` or `fork`. The engine keeps a
map from key to the session's reference and the call hash of its last turn. That map replaces
`sessionForLabel` (`workflow.ts:592-601`), which scans by label. A replayed turn fills the map
from its journal row, as a replayed call puts its session back today (`workflow.ts:1558-1570`).

Rules that fail instead of falling back:

- A handle has a session once its first turn's row is written. Before that row, a resume runs
  the first turn again in a new session. This covers a Codex thread killed before its first turn
  ended.
- After that row, a session the program can't find stops the step with an error, and the run
  pauses on it. It never starts fresh. Today it runs fresh with a notice (`steps/steps.ts:451-454`,
  `workflow.ts:1161-1182`).
- A `send()` that asks for a model on another program fails before any model call. Today that is
  `backend-mismatch`, then a fresh session (`steps/steps.ts:442-443`).
- A second `send()` on a handle while one runs fails the script. Today two parallel steps can
  continue one session at once (`workflow.ts:1274-1275`).

On a resume, Claude Code reports the session's whole cost so far as the turn's `total_cost_usd`
(live test 6). `runOnHarness` subtracts an earlier reading only within one attempt
(`steps/steps.ts:335-336`). So the map also keeps the cost the session's turns recorded, and a
kept turn counts only what it added.

### 2. The done signal

| Option | How | For | Against |
| --- | --- | --- | --- |
| A. Status in the turn's own answer | The turn's native schema is the status object. | One model call per turn. Both adapters already send a native schema (`packages/harnesses/src/claude/run.ts:54`, `codex/run.ts:258`). The answer is the journal row. The dry run can make one up. | The schema sits on the work turn. A slash command or a skill owns that turn's output, and a native loop runs several model turns in it. |
| B. A report turn | The work turn runs with no schema. Then sous sends one fixed prompt, `Report on the task you were given.`, with the status schema, in the same session. | The work turn is exactly what a person types. It works after any command, skill or native loop. | One more model call per turn. |
| C. A tool the agent calls | sous attaches an MCP server with `done` and `ask`. | Natural for a model. | Codex needs a server process per step. The call lives in the history, not in the answer, so sous would have to copy it into the journal. An agent can call `done` and keep working. A step's `tools` allow list would have to let it through. |
| D. A Stop hook | The SDK's `hooks.Stop` blocks the stop until a check passes. | The turn can't end early. | Claude Code only. It is a check, not a statement by the agent. |
| E. The program's own goal | The program's evaluator judges. | Built in. | Each program judges its own way, from the transcript alone. The evaluator runs no test. |

**The choice is A, in the form of B where A can't apply.** The rule has three parts:

1. A prompt that does not start with `/` runs with the status schema on the turn itself.
2. A prompt that starts with `/` runs with no schema. The program expands it into a command, a
   skill or a native loop, and its output stays free text. When the turn ends, sous sends the
   report turn.
3. An answer that does not fit the schema gets a repair turn with the report prompt. That is
   today's repair turn (`steps/steps.ts:465-471`, `steps/answer.ts:20-24`) with new words.
   Repair turns have no cap unless the step sets `maxRepairs`.

Both forms give the same journal value, so the loop reads one shape whichever ran. A step with a
status returns the `result` of the status that said `done`, whichever turn gave it.

What each step returns:

| The step | Status comes from | `agent()` returns |
| --- | --- | --- |
| Plain prompt, no `schema` | the turn's answer | `result`, a string |
| Plain prompt, with `schema` | the turn's answer | `result`, the schema's value |
| Slash prompt, no `schema` | the report turn | `result`, a string |
| Slash prompt, with `schema` | the report turn | `result`, the schema's value |
| Any prompt, `until: "turn"` | nothing | the text, or the schema's value. A slash prompt with a `schema` gets one report turn for the value. |

The contract text goes neither in the prompt nor in the system prompt. The status object's own
`description` fields say what each status means, and both programs send the schema to the model.
Neither schema copy drops `description` (`packages/harnesses/src/schema.ts:6-41`, `:123-158`).
`CONTRACT` (`steps/answer.ts:12-17`) and `buildPrompt` (`steps/answer.ts:34-40`) go. Whether models
fill the status well with no contract paragraph needs a live test.

The object stays flat, with every field required and `null` allowed. This is a choice. The
adapter already turns optional fields into required, nullable ones for Codex
(`packages/harnesses/src/schema.ts:186-197`), and declaring them that way gives both programs the
same shape.

With `/goal`, the goal's evaluator ends the turn. Then the report turn asks the agent itself.
`working` after a cleared goal gets a plain `Continue the task.` turn. Then the checks run. The
check is the stronger guarantee, since it runs the tests.

**The default is `until: "done"`.** The owner wants it as the norm. Always on changes the call
hash of every agent step, so a run paused under 0.1.0 runs its agent steps again. This design
takes that. It is listed under breaking changes.

### 3. When a turn ends under a native loop

A Claude step ends at the first `result` today. The prompt is an open stream
(`claude/run.ts:137-147`, `:172`), so it could carry more input, but the adapter closes it. At
the first `result` it sets `resulted`, and `release()` closes the stream (`claude/run.ts:254-257`).
Later frames are skipped (`:175-176`), and `q.close()` runs in `finally` (`:268`). Keeping the
query open across several model turns means changing those lines.

A live test on 2026-11-26 settled this. Through `query()` with an open prompt stream, as sous
calls it, `/goal` ran three model turns. The goal's Stop hook sent the agent back twice, and one
`result` came after the goal was met. So the first `result` already comes after the whole goal
loop. No `active_goal` message reached the caller, though the SDK declares the type
(`sdk.d.ts:3867-3878`).

**The choice is to keep the end rule.** A turn ends at the first `result`, and the Claude
adapter needs no new code for a goal. Each model turn's text is already a line of the step's
history (`claude/run.ts:208-210`), so the page shows the goal's turns inside the one step.
Decision 8 changes `release()` for another reason. After a `result`, the stream stays open for
the step's next turn, and it closes when the step ends.

The same test with `outputFormat` set ended early. The structured output rule made the agent
answer after two of the three turns, and the `result` carried `working`. So a slash prompt runs
with no schema, and the report turn after it asks for the status, as decision 2 says.

Codex has the same shape with other names. Its app-server protocol at 0.169.0 has
`thread/goal/set`, `thread/goal/get` and `thread/goal/clear`, with `thread/goal/updated` and
`thread/goal/cleared` notifications. `codex app-server generate-ts` shows them, with or without
`--experimental`. The generated `UserInput` also has a `skill` input with a name and a path.
sous's copy keeps only the files its imports reach (`packages/harnesses/scripts/codex-types.mjs:2-3`).
It already has the `skill` item in `generated/v2/UserInput.ts`. It lacks the goal and fork
methods (`packages/harnesses/src/codex/rpc.ts:28-39`), which come from `generate-ts` at 0.169.0.

A live test on 2026-11-26, on `gpt-6-luna` at low effort, showed how a Codex goal runs:

- `thread/goal/set` with an `objective` starts the first turn by itself. sous sends no
  `turn/start` after it.
- Each step of the goal loop is its own turn with its own `turn/completed`.
  `thread/goal/updated` reports the goal's status after each one.
- The status became `complete` just before the last `turn/completed`.

So a Codex `/goal` step keeps the thread open while the goal is `active`. It ends at the first
`turn/completed` after the status leaves `active`. The other statuses are `complete`, `paused`,
`blocked`, `usageLimited` and `budgetLimited`.

### 4. Where the loop lives and what a row is

This stands as PROPOSAL.md decided it, and the reasons hold.

- One turn is one engine `agent()` call and one journal row. A report turn or a repair turn runs
  inside that call, in the steps module, as repair turns do today (`steps/steps.ts:465-471`).
- The loop that reads the status, asks the person, runs the checks and counts the turns is a loop
  of `agent()` calls, as `ask: true` is today (`sous-globals.ts:246-271`). It moves to a file of
  its own.
- A worker that dies in turn 5 leaves four rows. A resume replays them and goes on.

One thing is new. Every turn of a session carries the call hash of the turn before it in that
session, as `after` in its own hash. So two sessions that both send `Continue the task.` never
share a pairing queue, even when their calls interleave in another order on resume. And a turn
replays only when every turn before it in its session replayed.

### 5. Prompts as written

`buildPrompt` puts `Task label: <label>` before every prompt (`steps/answer.ts:36`,
`steps/steps.ts:426`). The SDK's documentation, as PROPOSAL.md cites it, runs a command when the
prompt starts with `/<name>`. So the label stops every slash command.

| Option | For | Against |
| --- | --- | --- |
| A. A `command` option, as PROPOSAL.md chose. | Text from outside never starts a command. | The owner overruled it. A second way to say what a prompt already says. |
| B. Send the prompt as written. Move the label to the system channel. | A prompt is the same bytes by hand and in a workflow. | A prompt built from outside text that starts with `/` runs a command. |

**The choice is B**, as the owner decided, with one check for the risk. `sous check` notes each
prompt whose first characters come from a value made at run time, such as `agent(args.ticket)`.
The note says to start the prompt with fixed words.

The label goes to the system channel, which both adapters have: `systemPrompt.append` on Claude
Code (`claude/run.ts:37`) and `developerInstructions` on Codex (`codex/run.ts:227`). A session's
system text is built once, from its agent's prompt and its label, and is the same on every turn.
Today it holds the phase (`workflow.ts:2213`), which changes between steps, and the requested
isolation (`:2216`). Fixed text keeps the
program's prompt cache valid across the turns of a kept session.

Skills load as they do in a session opened by hand. Claude Code loads user and plugin skills
through `settingSources: ["user", "project", "local"]` (`claude/run.ts:36`). Codex loads skills
itself, and `skills/list` names the repo skills in `.agents/skills` and `.codex/skills`.

sous sends Codex typed inputs, and a prompt goes as one `text` input (`codex/run.ts:246-249`). A
live test on 2026-11-26, on `gpt-6-luna` at low effort, showed that the app-server reads no slash
command from text:

- The `skill` item ran a repo skill from `.agents/skills/canary`. The text `$canary` ran it too.
- The text `/canary` did not run it. The model guessed and answered with another skill's word.
- The text `/status` meant nothing to the model.
- The app-server also has `review/start` and `thread/compact/start`.

So the Codex adapter maps a leading slash this way:

- `/goal <text>` goes to `thread/goal/set`, with the text as the objective.
- `/<name>`, when `skills/list` has a skill of that name, goes as the `skill` item.
- `/review` and `/compact` go to `review/start` and `thread/compact/start`.
- `/prompts:<name>` expands `~/.codex/prompts/<name>.md`, as the full-screen view does.
- Any other leading slash fails the step with a message that names the command.

Before phase 8, a Codex slash prompt goes as written text. Phase 8 brings the rest.

`sous resume --note` adds the person's note to the prompt of the turn it resumes. On a plain
prompt the note goes after a blank line, as today (`steps/steps.ts:109`). On a slash prompt it
goes as another text block of the same user message on Claude Code, or as another text input
item on Codex, before the prompt. Claude Code 2.1.332 reads a slash command only from the
message's last text block: with the note after `/canary`, live test 1 showed the command never
ran, and with the note first it ran and the model followed the note. The note never lands inside
the slash prompt, and it is never a turn of its own.

### 6. Limits

The owner's rule is that every limit is off unless the script sets it. A step runs turns until
the agent reports `done` and its checks pass. Today a run's token budget has no default
(`runs/home.ts:33`), a run's time limit is only what `meta` sets (`workflows/meta.ts:46`), and a
step's time limit is only what the step or its agent sets (`steps/steps.ts:198`). This design
adds no default either.

Four limits have a default today. Each loses it and stays as a setting:

| Limit | Today's default | Setting |
| --- | --- | --- |
| The agent, code and checkpoint calls of a run | `MAX_AGENTS_PER_RUN` (`config.ts:6`, used at `workflow.ts:516`, `:880`) | `maxAgents` on the run |
| The repair turns of a step | `REPAIRS` (`steps/steps.ts:91`) | `maxRepairs` on the step |
| How deep workflows nest | `DEFAULT_MAX_NESTING_DEPTH` (`sous-globals.ts:12`, used at `workflow.ts:1751`) | `maxNestingDepth` on the run |
| How often the person sends a `breakpoint` step back | 5 (`sous-globals.ts:174`) | `max` on the breakpoint |

- `maxTurns` has no default, and neither has a room's `maxRounds`.
- The config's `maxAgents` of 4 (`runs/home.ts:37`) stays. It caps how many agents run at once
  across runs. The others wait in a queue and none fails, so it limits no work.
- The config's `retries` of 2 (`runs/home.ts:37`) stays, and so does its ceiling of 4
  (`MAX_AGENT_RETRIES`, `config.ts:12`). A retry runs an attempt again after an error sous can
  recover from, such as a crash of the program. When the retries run out the run pauses, and the
  person resumes it, so no work ends for good.

What a limit does when it is reached:

- The run's time limit, the budget and the account's usage limit pause the run, as today.
- `maxTurns` and `maxRepairs` fail the step with an error the script can catch. The error takes
  a path outside `afterFailedAttempt`, which would retry it and then pause the run. Uncaught, it
  fails the run as any script error does, and a failed run resumes.
- A step's `timeout` keeps today's path. It throws a recoverable error, sous retries the step,
  and then the run pauses (`failed-attempt.ts:55-56`).

With no limit, a step whose agent never reports `done` runs until the person stops it, or until
a budget or the account's usage limit pauses the run. A check that keeps failing does the same,
and so do a schema answer that never fits and a workflow that calls itself.

### 7. Worktree scopes and branches

Today "where a step works" has four spellings. `meta.place` and the `place` of `workflow()` keep
their branch (`places/places.ts:86-90`, `:128-133`). `isolation: "worktree"` deletes the
worktree and the branch when the step ends, and when it fails before it runs
(`workflow.ts:1546`, `:1649`, `places/places.ts:151-158`,
`:191-195`). `cwd` picks a subfolder.

| Option | For | Against |
| --- | --- | --- |
| A. Keep step isolation as it is. | No change. | The work is deleted. Nothing can continue the session where it worked. |
| B. Only runs and nested workflows get worktrees. | One mechanism, and it works today (`examples/textkit/.sous/workflows/factory.js:60`). | A saved workflow file for every agent that should work apart. |
| C. `place: "worktree"` on a session or a step. The worktree lives as long as the session, and its branch stays. | One word at three scopes. Parallel implementers keep their work. | Branches stay until someone merges them. |
| D. C, and sous merges the branch back when the scope ends. | Complete. | sous would own merges and conflicts. |

**The choice is C.** D can come later, as a `check` that merges.

The rules:

- A session's worktree is named for its run and its label, `<run id>-<label>`, and ends in a
  short hash of the run id and the full label. A resumed run finds the same one. The hash keeps
  two labels apart when their slugs match, since a slug keeps 32 characters
  (`places/places.ts:93-95`). `makeStepWorktree` names a worktree with the call index today
  (`places/places.ts:137`), which a resume can change.
- A one-step worktree, from `agent(prompt, { place: "worktree" })`, ends in the call's
  occurrence instead.
- A resume reuses the branch and the folder, through the path `makePlace` takes
  (`places/places.ts:76`). `makeStepWorktree` passes `reuseBranch: false` (`:141`), so a session
  place does not go through it.
- It starts from the `HEAD` of the folder of the workflow that made the session
  (`places/places.ts:54`).
- It lives until that workflow returns. For `agent(prompt, { place: "worktree" })` it lives
  until the step ends, checks included.
- When any scope ends, sous commits what is uncommitted on the branch, with the message
  `sous: uncommitted work of <label>`, and removes the folder. That holds for a step, a session,
  a nested workflow and the run. A branch that never moved is deleted, as an unchanged run's is
  today (`places/places.ts:180-188`, `:214-226`).
- A paused run keeps every folder of a scope that has not ended. `sous gc` keeps the worktrees
  of a run that has not finished through `runWorktrees` (`places/places.ts:201-211`, `:268-272`),
  which reads the run's `stepWorktrees` (`runs/records.ts:77`). Session worktrees join that list,
  or gc would remove them.
- A fork can have its own place on both programs. Live test 10 on 2026-11-26 showed it. A Claude
  Code fork with a chosen `sessionId` runs in another folder and resumes later from there.
  Codex's `thread/fork` takes a `cwd`. sous copies no transcript.
- On Codex an agent's own `git commit` needs a rights request, in a worktree as in a checkout.
  Codex's `workspace-write` sandbox keeps `.git` read-only, and a worktree's git files sit in the
  main checkout's `.git`. In the default `agent` mode the reviewer grants the request, but on
  2026-11-27 `gpt-6-luna` at low effort made none: it tried once, failed, and reported the
  failure or a `question`. A Codex session opened by hand does the same, so sous keeps the
  sandbox as it is, and the commit at the scope's end keeps the work. Adding the worktree's git
  folders to `writableRoots` would let Codex commit with no request. That is the owner's call.
- `isolation: worktree` in an agent's frontmatter (`agents.ts:234`, `:256`, `:605`) is read as
  `place: "worktree"`. sous does not refuse it, so agent files the owner also opens by hand keep
  working.

### 8. One program per step, a resume per step

| Option | For | Against |
| --- | --- | --- |
| A. One program per turn, as today. Each turn starts the program, resumes the session by id and closes. | The worker holds nothing but an id. A pause, a kill or a usage limit loses nothing. An idle session costs no memory. No process holds the session while a person takes it over. | Each turn pays the program's start. A background shell the agent started ends with the turn, which a session opened by hand never does. |
| B. One process per session, kept open across turns. | No start cost. Background tasks live on. | The worker holds one process per open session, idle ones included. A crash still needs the resume path, so B is A with more code. Two writers on one session when a person takes over. |
| C. One program per step. It stays open across the step's turns and closes when the step ends. | A background shell lives as long as the step. The step's later turns pay no start. An idle session between steps holds no process. | A long step holds one process. A crash still needs the resume path. |

**The choice is C.** A workflow step keeps every feature a session opened by hand has, and a
background shell is one of them.

- On Claude Code the prompt stream is already open (`claude/run.ts:137-147`). It takes the
  step's next prompt instead of closing at the first `result` (`:254-257`).
- On Codex the thread stays open between `turn/start` calls.
- The program closes when the step ends, when the run pauses and when the person joins. A
  background shell the agent started lives as long as the step.
- The journal still has one row per turn. A resume still starts the program again and finds the
  session by its id.

The prompt cache belongs to the provider and not to the process, so a resume within its
lifetime reads from it either way.

### 9. When an agent needs the person

Today sous turns off Claude Code's `AskUserQuestion` on every step. It is always in
`disallowedTools` (`claude/run.ts:24-25`, `:38`), so the model never sees it, and the
`canUseTool` refusal (`:39-41`) is only a fallback. sous also refuses Codex's
`item/tool/requestUserInput` (`codex/run.ts:194-195`). An agent with `ask: true` ends its turn
with a `QUESTION:` line instead (`sous-globals.ts:51-54`, `:258-262`). The question goes to the
inbox, where `sous answer` or the page answers it.

The owner decided against a channel of sous for questions. A person who lacks context gets it
best from the session itself, and the session is where they would answer by hand.

- The agent says it needs the person with the status `question`. Its `description` says the
  status is only for what the agent cannot decide or do without the person. Asking whether to go
  on, such as "Should I continue?", is `working`, and sous sends the agent back to work.
- Every agent step may need the person unless it says `ask: false`. An `until: "turn"` step has
  no status, so it reaches the person through the native question tool.
- With `ask` on, `AskUserQuestion` leaves `disallowedTools`, so the model sees it. When the agent
  calls it, the `canUseTool` refusal answers "The person will step into this session to answer
  you. End your turn now." Codex's `item/tool/requestUserInput` gets the same refusal. The turn
  then counts as a `question`. The SDK's refusal can end the turn at once with `interrupt: true`
  (`sdk.d.ts:2731`). That needs a live test.
- The step then waits on one row, a checkpoint whose `answeredBy` is `join`. Who may answer lives
  in `CheckpointPurpose.answeredBy` (`checkpoint-call.ts:24-34`), which stays out of the call
  hash. The widget `kind` keeps its three values. The row keeps the agent's message for the
  journal. `sous join` writes its value when the person quits the program. A replay keeps the
  value, so a resumed step never waits twice.
- After the person leaves, sous sends `Continue the task.`, with the step's schema if it has
  one. A step with a status reports as usual. An `until: "turn"` step returns that turn's result.
- The wait is the one questions use today. The worker polls for the value while the rest of the
  run goes on (`runs/worker.ts:292-327`). The log line names `sous join <run> <label>` where it
  names `sous answer` today, and the notice says "<label> needs you", with the handle's label.
- `sous answer` refuses a `join` row and names `sous join`. The page shows "This agent needs you"
  and the `sous join` line to copy. It shows no answer box and not the agent's message.
- `ask: false` takes `question` out of the status and keeps the native tool off, as every step
  does today.

What goes: `answeredBy` on an agent step, the `<label> (answer N)` labels, the cap of five
questions, and the inbox entry for an agent's question. Today `answeredBy: "anyone"` lets an
agent answer through `sous answer` (`runs/inbox.ts:34`). An agent cannot step into a session, so
on an agent step that option has nothing left to do.

`ask()` and `breakpoint()` stay as they are. Each is a question from the script itself, with no
session to step into, so `sous answer` and the page still answer them.

### 10. Stepping into a session

The owner's rule is that stepping into one session stops nothing else, as with two sessions
opened by hand. Pausing the whole run while the person works is not an option.

`sous join <run> <label>` does this:

1. It finds the step's session in the saved state of the run that owns it, which keeps each
   ended call's session (`runs/persistence/run-persistence.ts:56`). `<run>` may be a nested
   run's id. A handle's label is unique in its run. Given a label that several `agent()` steps
   used, it picks the latest.
2. It takes the session's hold file, named for the run and the session id. A session has one
   writer at a time.
3. When a turn runs in the session, it writes a join request and signals the worker, the way
   `sous stop --step` writes its request (`runs/run.ts:459`, `runs/worker.ts:350-357`). The
   worker aborts that one call with an abort code of its own for `join`. Today every abort is
   `AGENT_CANCELLED` (`workflow-manager.ts:1890-1895`), and that code pauses the whole run
   (`workflow.ts:1461-1483`). So `runLive` gets a path for the join code. The turn settles as an
   ordinary row with `{ status: "working", result: null, message: "The person stepped in." }`,
   and the run goes on. A turn of an `until: "turn"` step, or a room member's turn, settles the
   same way with no status.
4. It starts the program on the session's id, in the session's folder. It passes the step's
   model, effort, permission mode, MCP servers and appended system text, as the program accepts
   them, and the account's login from the adapter's `env()` (`packages/harnesses/src/types.ts:158`).
   Skills load from the settings, as in any session opened by hand. The command is
   `claude --resume <session id>`, or `codex resume <thread id>` with `-m <model>` and
   `-c model_reasoning_effort=<effort>`. It finds the program as a step does, through
   `programLookup(config)`, which honors `claudePath` and `codexPath`, so tests reach the fakes.
   The cli cannot import the harnesses, so this lives in the engine's `runs/join.ts`.
5. When the program exits, it releases the hold. When the step waited on a `join` row, it writes
   that row's value.
6. The step's loop checks the hold under the hold file's lock before each turn in the session.
   Once the hold is free, the next turn follows the one rule for a turn that stopped early,
   under "Resume" below.

A session that is idle between steps, such as an implementer while its reviewer reads, works the
same way. Its next `send()` waits for the hold. A run killed while the person is in a session
keeps the hold file, so the resumed step waits too.

Around the hold:

- A hold file whose pid is dead is free.
- A paused run can be joined, since joining needs no worker.
- The `join` row is a checkpoint call of its own, so a step's `timeout` does not count the
  person's time.
- The person's own turns do not count against the budget, since sous does not see their tokens.

`sous step` and the page show each agent step's session id, program and folder, and its
`sous join` command. Today neither shows a session id (`runs/step-view.ts:14-46`). Only
`sous show <run> --full --json` prints it, inside the saved engine state
(`packages/cli/src/commands/reads.ts:115`).

Live test 11 on 2026-11-26 showed that a person can step in on both programs:

- On Claude Code 2.1.330, an SDK session opened with `claude --resume <id>` in the full-screen
  view inside tmux showed its history and took the person's line. The SDK then resumed it under
  the same id and knew both its own word and the person's.
- A folder Claude Code never trusted shows its trust prompt first, so `sous join` into a new
  worktree asks the person once.
- On Codex 0.169.0, an app-server thread opened with `codex resume <id>` in the full-screen view
  showed its history and took the person's line. `thread/resume` then went on with both words.
- Codex's full-screen view started at high reasoning effort. That is why `sous join` passes the
  step's model and effort.

### 11. Fork

- A fork starts from the parent's session as it is at the `fork()` call, which is its last
  finished turn. Forking a handle that has not run yet throws.
- On Claude Code, `forkSession: true` with `resume` gives a new session (`sdk.d.ts:1850`). The
  fork also passes a `sessionId` that sous chooses. The SDK accepts `sessionId` with `resume`
  only when `forkSession` is set (`sdk.d.ts:2270-2273`).
- `runClaude` reports the fork's id. Today the id it returns is `step.resume ?? randomUUID()`
  (`claude/run.ts:113`, `:242`), which for a fork is the parent's.
- On Codex, `thread/fork` with the parent's `threadId` and a `cwd` gives a new thread. It is in
  the 0.169.0 protocol and not in sous's copy.
- The adapters' `Step` gets `fork: true`, valid only with `resume`
  (`packages/harnesses/src/types.ts:74`).
- The fork's first turn has `after` set to the parent's last call hash, and `fork` in its own
  hash. Later turns of the parent do not change the fork's rows.

Live test 10 on 2026-11-26 passed on both programs:

- On Claude Code, `resume` with `forkSession: true` and a chosen `sessionId`, run in another
  folder, gave that id. The fork knew the parent's words and resumed later from its own folder.
  The parent was unchanged.
- On Codex, `thread/fork` with a `cwd` gave a new thread id in the new folder. The fork knew the
  parent's words, and the parent was unchanged.

### 12. Structured input and output

- Every step kind other than an agent step takes an optional `input` and an optional `schema`.
  The step kinds table says where each one's `input` goes and what its `schema` checks.
- An agent step's input is its prompt. The script puts a value in with a template string. An
  `input` option would be a second way to write the same bytes, so there is none.
- A nested workflow's `args` are checked before its first step today
  (`workflow.ts:1772`, `workflows/meta.ts:167-174`). An input of type `json` has no shape
  (`workflows/meta.ts:25-31`). It gets an optional `schema`, checked the way a step's answer is
  (`steps/answer.ts:59-67`).
- `meta.schema` is the shape of a workflow's result, the same word as on `agent()`. A result
  that does not fit fails the `workflow()` call. `meta.outputs` stays as the text the page shows.

### 13. Rooms

The rooms draft (`docs/features/rooms/DESIGN.md`) stands. These changes from its first version
are made in it:

1. A member is a handle, or `{ session, role }` where `role` is a line added to that member's
   room messages. The first draft's `continue: "<label>"` goes.
2. A room turn is `handle.send(prompt, { until: "turn", schema })` with the room's own schema.
   The `done` flag stays, since it is a field of the room's answer and not a step status.
3. The first draft refused a member that continued a step with `isolation: "worktree"`. That
   rule goes, since a session keeps its folder.
4. `sessionOf(label)` goes. A handle already holds its program, model and folder.
5. `maxRounds` has no default, by the owner's rule on limits in decision 6.
6. `turns: "together"` stays the default, so members work at the same time. `in order` and
   `moderated` stay as the other choices. The owner chose this on 2026-11-26.
7. Whom a member hears becomes an option, `hears`. With `"all"`, the default, every member hears
   every message. With `"addressed"`, a member's turn holds only the messages sent to it or to
   `all`. The owner asked for both, with every message as the default.
8. The first draft's `person` option and its channel go, by decision 9. A member reaches the
   person as any `until: "turn"` step does, through the native question tool, and waits on a
   `join` row. sous says the member needs the person, and the person steps into that member's
   session with `sous join <run> <member>`.
9. The room goes on while the person is in one member's session. Each round takes the turns of
   the free members. The member the person is in skips rounds until the person leaves. Its next
   turn then holds every message it missed. Nothing outside the room stops, and inside it only
   that member waits.
10. `decider` is a member's handle, not its label.

## Reuse

### `packages/engine`

| Part | Verdict | What happens |
| --- | --- | --- |
| The journal, the step ledger, pairing by occurrence (`resume-pairing.ts`, `resume-rows.ts`, `step-ledger.ts`) | Keep | No change. |
| `hashAgentCall` (`workflow.ts:2141-2172`) | Change | Gains `until` when it is `done`, and `after` and `fork` for a turn in a kept session. Loses `configOptions`. |
| `callInputs` (`workflow.ts:979-991`) | Change | `isolation` stays as a key that is always null, as `meta` does today (`workflow.ts:985-990`). `keepSession` stays `false` on every call, as today (`workflow.ts:982`), so the inputs hash holds and old code steps still replay. `hashCallInputs` (`workflow.ts:2064-2076`) only hashes and does not change. |
| `AgentOptions` and `AGENT_OPTION_KEYS` (`workflow.ts:348-453`) | Change | `configOptions`, `isolation`, `keepSession` and `continue` leave. `until` and `session` enter. 16 fields. |
| `sessionForLabel` (`workflow.ts:592-601`) | Replace | A map from session key to its reference and last call hash. |
| Step worktrees in `runLevel` (`workflow.ts:622-628`, `:1025-1027`, `:1092-1099`, `:1546`, `:1625-1642`, `:1649`) | Replace | A session's place comes in as `cwd`. The engine opens and closes none. |
| `agentImplementation` and `runLive` (`workflow.ts:899`, `:1103`) | Change | Read the session map where they read `continue` (`:1274-1275`). Pass `until` and `fork` to the runner. A lost kept session throws. |
| Continuation on resume (`workflow.ts:1110-1112`, `:1250-1269`, `:1617-1621`) | Change | Works in nested runs too. The `worktree-isolated` skip goes, and the `cwd-mismatch` skip accepts a session worktree's folder (`:1259-1261`). |
| `workflowImplementation` (`workflow.ts:1744-1795`) | Change | Passes the continuation to the child (`:1786`). Checks the child's result against `meta.schema`. |
| `retry` and `gate` (`workflow.ts:1813-1848`), `checkpoint` in the script (`:1917`) | Remove | `check` and a plain loop replace them. `ask` replaces `checkpoint`. |
| The script's globals (`workflow.ts:1902-1919`) | Change | One line hands over every function of `createSousGlobals`, as the rooms draft proposes. |
| `createSousGlobals` (`sous-globals.ts:75-274`) | Change | The `ask: true` loop (`:246-271`) leaves. `session` and `room` come in. `agent` becomes one line. Code steps, `ask`, `breakpoint` and `choose` stay. |
| `buildPrompt`, `CONTRACT` (`steps/answer.ts:12-40`) | Remove | The prompt goes as written. |
| `REPROMPT_TEXT`, `CONTINUATION_INSTRUCTION` (`steps/answer.ts:20-31`) | Change | The first becomes the report prompt. The second becomes `Continue the task.`, since any stop now leads to it. |
| `runOnHarness` (`steps/steps.ts:279-489`) | Change | Sends the prompt as written. Picks the turn's schema. Runs the report turn. Waits for the session's hold. Fails the step on `no_session` once the handle's first row is written. Keeps the program open across the step's turns. Passes a `--note` on a slash prompt as a text block before it, where `withNote` appends it to the prompt today (`steps/steps.ts:109`). Counts only the cost a kept turn added. |
| `createSteps.run` (`steps/steps.ts:164-239`) | Change | Builds the status schema before the split at `:218`, so a stand-in gets it too. |
| `AgentRunner`, `StepAsk` (`steps/agent-runner.ts`) | Change | `isolation` leaves `StepAsk` and `StepRoute`. |
| `EngineFields` (`steps/agent-run.ts:76-171`) | Change | Gains `until` and `fork`. `continueFromSession` and `continueWithPrompt` stay. |
| `SteeringBoard` (`steps/steering.ts`) | Keep | `sous tell` reaches each turn by the step's label. |
| `checkpointCall`, the inbox (`checkpoint-call.ts`, `runs/inbox.ts`) | Change | A new purpose, `answeredBy: "join"` (`checkpoint-call.ts:24-34`), which only `sous join` answers. The widget `kind` keeps its three values. `ask()` and `breakpoint()` use the inbox as today. |
| `runPlaces` (`places/places.ts:123-160`) | Change | `makeStepWorktree` and `removeStepWorktree` become `sessionPlace` and `closeSessionPlace`. A session place takes `makePlace`'s path, which reuses the branch and the folder (`:76`). Its name ends in a hash and not a call index, and sous commits before the folder goes. Places reach `turns/` through deps, as `nestedPlace` does. |
| `gcWorktrees`, `dropUnchangedWorktrees`, `preparePlace` (`places/places.ts`) | Keep | No change. |
| `buildPreparedContinuation` (`workflow-manager.ts:666-734`) | Change | Takes any pause reason and any error code, and the calls of nested runs. Today it takes two reasons (`:672`), two codes (`:688-693`) and the root run only (`:682`, `:701`). It moves to a file of its own. |
| `reconcileExternallyDeadRun` (`workflow-manager.ts:521-561`) | Change | Gives each agent still marked running an interrupted call row, with the session recorded when it opened. Today a call with no call row gives a resume no row to pair with (`resume-rows.ts:55-59`). How the manager writes that row is not confirmed. |
| The run's callbacks (`workflow.ts:220-346`) | Change | A new `onTurnSession` tells the manager a turn's session id when the program reports it, so a kill does not lose it. Today the engine keeps it in memory until the attempt settles (`workflow.ts:1334-1338`, `:1147-1159`). The step request already has an `onSessionOpen` (`workflow.ts:1334-1338`, `steps/agent-run.ts:125`, `workflows/dry-run.ts:45`), so the new field takes another name. |
| `fabricateFromSchema` (`fabricate.ts`) | Keep | The first enum value is `done` (`fabricate.ts:23`). |
| Stand-in agents (`workflows/dry-run.ts:38-57`) | Change | One session id per session, a new id for a fork, and a plain answer read as `done`. |
| `script.ts`, `flow.ts`, `step-options.ts`, `check.ts` (`workflows/`) | Change | Read `session()`, `<name>.send()`, `fork()`, `room()` and the new options. Drop `gate`, `retry`, `keepSession`, `continue`, `isolation`. |
| `workflows/meta.ts` | Change | `schema` on an input, and `meta.schema`. |
| `runs/step-view.ts` | Change | A step's view gains its session id, program, folder and open command. |
| `runs/tell.ts` | Keep | No change. |
| `runs/records.ts` | Change | `stepWorktrees` (`:77`) lists session worktrees too, so `sous gc` keeps them while the run has not finished. |
| `MAX_AGENTS_PER_RUN` (`config.ts:6`), `REPAIRS` (`steps/steps.ts:91`), `DEFAULT_MAX_NESTING_DEPTH` (`sous-globals.ts:12`) | Change | Each loses its default. `maxAgents`, `maxRepairs` and `maxNestingDepth` set them, as decision 6 says. |
| `afterFailedAttempt` (`failed-attempt.ts`) | Keep | A step's `timeout` still goes through it. `maxTurns` and `maxRepairs` throw on a path outside it. |
| `cancelAgentSteps`, `requestAgentCancellation` (`workflow-manager.ts:1859`, `:1877-1898`) | Change | A join abort gets a code of its own. Every abort is `AGENT_CANCELLED` today (`:1890-1895`), and that code pauses the run (`workflow.ts:1461-1483`). `runLive` settles a join abort as a row, and the run goes on. |

New files in the engine:

| File | Holds |
| --- | --- |
| `turns/status.ts` | The status schema for a step, the fixed prompts, and reading an answer. Pure. |
| `turns/loop.ts` | One step's turns until `done`, with its wait for the person, its checks and its optional turn limit. |
| `turns/session.ts` | The handles, with `session()`, `send()`, `fork()`, the rule of one turn at a time, and the place's lifetime. |
| `room/options.ts`, `room/order.ts`, `room/prompt.ts`, `room/room.ts` | As the rooms draft lists them. |
| `continuation-candidates.ts` | `buildPreparedContinuation`, moved out of the manager. Pure. |
| `runs/session-hold.ts` | The hold file of a session. |
| `runs/join.ts` | The join request, the command that opens a session in its program, and the `join` row's value. |

### `packages/harnesses`

| Part | Verdict | What happens |
| --- | --- | --- |
| `Step`, `StepResult` (`packages/harnesses/src/types.ts:54-99`) | Change | `Step.fork`. A note that goes as a text block or input item before a slash prompt. `StepResult.asked`, set when the agent called the native question tool. |
| `claudeOptions` (`claude/run.ts:28-71`) | Change | `forkSession` and a chosen `sessionId` with `resume`. With `ask` on, `AskUserQuestion` leaves `disallowedTools` (`:38`), and the `canUseTool` refusal (`:39-41`) gets new words. |
| `runClaude` (`claude/run.ts:112-279`) | Change | Reports a fork's own id and not the parent's (`:113`, `:242`). Passes `asked` from `canUseTool` to the answer. Settles the `interrupt: true` refusal as a question, where today it falls to `failed, retry: true` (`:250-251`, `:278`). Keeps the prompt stream open after a `result` for the step's next turn (`:254-257`). A turn still ends at the first `result`, which comes after a whole goal loop. |
| `Tells` (`claude/tells.ts`) | Keep | No change. |
| `runCodex` (`codex/run.ts:57-306`) | Change | `thread/fork` with a `cwd`. Counts a refused `item/tool/requestUserInput` as a question. Keeps the thread open across the step's turns. In phase 8 it maps a leading slash as decision 5 says and ends a goal step as decision 3 says. |
| `Methods` (`codex/rpc.ts:28-39`), `generated/` | Change | `thread/fork` first. `skills/list`, the goal methods, `review/start` and `thread/compact/start` in phase 8, from `generate-ts` at 0.169.0. |
| `schema.ts` | Keep | No change. |
| The fake programs (`test/fakes/claude`, `test/fakes/codex`, `test/fakes/lib.mjs`) | Change | New rules, listed under the scenarios. |

### The cli and the page

| Part | Verdict | What happens |
| --- | --- | --- |
| `cmdAnswer`, `cmdInbox` (`packages/cli/src/commands/questions.ts`) | Change | `sous answer` refuses a `join` row and names `sous join`. The inbox lists a step that needs the person with its `sous join` command. |
| `cmdTell`, `cmdStop` (`packages/cli/src/commands/control.ts`) | Keep | No change. |
| `cmdResume` (`packages/cli/src/commands/runs.ts:67`) | Keep | No change. |
| `cmdStep` (`packages/cli/src/commands/step.ts`) | Change | Prints the session and its `sous join` command. |
| New `join.ts` in `packages/cli/src/commands/` | New | `sous join`. |
| The page's calls (`packages/cli/src/serve/call.ts:17`) | Keep | No change. The page shows the command and runs nothing. |
| `QuestionPanel` (`packages/view/src/pages/run/needs-you.tsx:183`) | Change | A step that needs the person shows "This agent needs you" and the `sous join` line to copy. It shows no answer box and not the agent's message. `ask()` and `breakpoint()` keep theirs. |
| The step panel (`packages/view/src/pages/run/step-call.tsx`) | Change | Shows a step's turns, its status, its session and its place. |
| The graph (`packages/view/src/graph`, `api/contract.ts`) | Change | A step with a loop is one node. Its checks draw as its body, as a gate's body does today (`workflows/flow.ts:494-505`). A room is one node with a lane per member. |
| `docs/guide.md`, `README.md`, `examples/` | Change | In the last phase. |
| The golden files (`test/baseline/golden`) | Change | In each phase that changes what sous prints, from phase 1 on. Phase 1 takes the `Task label:` line and the contract out of the golden prompts. |

### What the removed names touch

Each removed name reaches past the engine. The build ports each place below.

| Name | Where it reaches |
| --- | --- |
| `isolation` | The call hash, through `agentDefinitionKey` (`agents.ts:482`). The resume matcher, which pairs `worktree: true` with isolation `"worktree"` (`resume-matcher.ts:138`, `:153-154`, `workflow.ts:1192`). `workflow-result.ts:206`, `:454-455`, `run-observability.ts:300`, `workflows/step-options.ts:26` and `workflows/flow.ts:70`. The view's `api/contract.ts:292`, `:464`, `plan/step-about.tsx` and `pages/agent/agent-detail.tsx`. Engine tests and `packages/cli/test/runs.test.ts`. |
| `gate`, `retry` | The view's loop kinds (`packages/view/src/api/contract.ts:322-330`), fed by `workflows/flow.ts`. `packages/view/src/kit/kit-data.ts`. The engine tests `flow`, `script-functions` and `steps`. |
| `<label> (answer N)` | The view's `graph/match.ts:7`, `:104-105`. The view tests `graph-overlay` and `confirm`, and the cli tests `questions` and `replies`. |
| `checkpoint()` | Test scripts in `packages/cli/test/` that call it: `answer-file.test.ts:13`, `questions.test.ts:60`, `:256`, `serve.test.ts:19`, `time-limit.test.ts:46` and `resume.test.ts:106`. |
| `keepSession`, `continue` | `test/baseline/workflows/agent-session.js:10`, `:21`. `packages/cli/guide/writing.md:42-59`. `README.md` and `docs/guide.md`. `examples/textkit/.sous/workflows/ticket.js:28`, `:57-58`. |
| The `Task label:` line | The golden prompts, and the comment at `packages/view/e2e/world.mjs:115`. |

The `join` purpose reaches the six places that repeat the question `kind` union: the view's
`api/contract.ts:219`, `runs/inbox.ts:23`, `errors.ts:79`, `workflow-result.ts:127`,
`checkpoint-call.ts:16` and `workflows/flow.ts:85`. `runs/inbox.ts` branches on it in `standIn`
and `answer` (`:130-133`, `:278-300`).

The port keeps each test's strength:

- A ported test keeps the strength of each assertion.
- A pinned title in the architecture test changes in a commit of its own.
- The call-hash pins move when `until` enters the hash, and that commit says why.

## The scenarios

The deterministic tests run on the fake programs in `test/fakes`, which answer by rules that
match the prompt (`test/fakes/lib.mjs:4-6`), or on stand-in agents. They need these new rules in
the fakes:

| Rule | What the fake does |
| --- | --- |
| `recall` | It answers with the made-up words, such as `PELICAN-4417`, found in the prompts this session got before. A fork starts with its parent's prompts. This stands in for memory. The fakes already keep each session's user messages (`test/fakes/claude:13`, the threads folder in `test/fakes/codex:97`), so the rule reads those. The existing `hold`, `tool` and `times` rules (`test/fakes/lib.mjs:9`, `:27`, `:36`) cover the rest of scenarios 7, 13 and 14. |
| `slash` | The rule matches only when the prompt's first character is `/`. |
| `goal` | On a `/goal` prompt it runs N model turns, with a `Stop hook feedback:` user message between them and one `result` at the end. With a schema set, it ends after its first model turn with `working`. Both as the live test recorded. |
| `status` | It answers a status schema with the given statuses in turn. |
| `system`, `session` | A rule matches the session's system text or its session id, besides the prompt. Today a rule sees only the program and the prompt (`test/fakes/lib.mjs:96-109`). After decision 5 every session sends the same fixed prompts, and the label lives only in the system text. The syntax is the implementer's. |
| `ask` | It calls the native question tool before it answers. The fake codex already does this with `approval: { kind: "question" }` (`test/fakes/lib.mjs:21-25`). The fake claude must learn to send a `can_use_tool` request. Today it only answers incoming ones (`test/fakes/claude:118-156`). |
| `fork` | Both fakes fork a session, and the fork starts with its parent's prompts. Today the fake codex answers `thread/fork` with an empty object (`test/fakes/codex:489-490`). |
| by hand | Started as `claude --resume <id>` or `codex resume <id>` with no stream, it appends one user line to that session and exits. This stands in for a person in the program. The fake claude appends to `claude-sessions/<id>`, the file a resume reads. The fake codex must accept `resume`, which exits 2 today (`test/fakes/codex:26-29`). |

The fake claude reports `init` after the first user message (`test/fakes/claude:288-308`), so it
cannot show which Claude message marks a delivered prompt. A live test in phase 4 settles that.

| # | Scenario | What it needs | The deterministic test |
| --- | --- | --- | --- |
| 1 | A skill runs from the prompt | The prompt as written, decision 5. The report turn, decision 2. | A fake rule answers `PELICAN-4417` only to a prompt that starts with `/canary`. The step returns the word, and the fake's log shows the prompt bytes `/canary`. The log also shows the setting sources that load user and plugin skills. On 0.1.0 the log shows `Task label:` first. |
| 2 | `/goal` holds a long task | Decision 3. | The `goal` rule runs three model turns, and each appends a line to a file. The check `test $(wc -l < done.txt) -ge 3` stands in for `npm test`. The step returns after the third, with three activity lines in one call. On 0.1.0 the label line in front of the prompt keeps the rule from starting. |
| 3 | The agent says when it is done | Decisions 2 and 4. | A `status` rule answers `working` with the message "Should I continue?", then `done`. The log shows `Continue the task.` sent in the same session after the question, and the step returns the `done` result. A dry run with `--answers '{"implementer":[{"status":"working"},{"status":"working"},{"status":"done","result":"ok"}]}'` shows three calls of `implementer` and starts no program. |
| 4 | Structured in, structured out | Decision 12. | The testing kit's in-process runner runs Script 2, and the planner's answer has three tickets. One lacks `title`. That `workflow()` call throws, its branch catches the error, and the journal has no row in that child's scope. The two others return objects that fit `meta.schema`. |
| 5 | The implementer remembers, the reviewer starts fresh | Decisions 1 and 4. | The fakes with `recall`. The implementer's third turn answers with the word, and the reviewer's answer has none. The log shows one session id on every implementer turn and another on each reviewer. |
| 6 | Fresh and fork | Decision 11. | `recall` again. A fresh handle has no word. A fork has the first word. After the fork gets a second word, the original's next turn has only the first. |
| 7 | A stop does not lose the session | The wider continuation. | A `hold` rule keeps the third turn open. `sous stop <run> --step implementer` pauses the run, then `sous resume`. The log has no second request for turns one and two. The next request resumes the same session id with `Continue the task.`, and `recall` gives the word. A second test kills the worker during the third turn instead. The run is left `interrupted`, and the same checks hold after `sous resume`. |
| 8 | The ticket loop in one worktree | Decision 7, and `check` in the step's place. | A `tool` rule makes each implementer turn write and commit a file. The log shows the same `cwd` for the implementer and the reviewer. The project's `git status` is clean and its `HEAD` did not move. The branch `sous/<run>` has the commits. |
| 9 | The epic gives each ticket its own worktree | Decision 7. Continuation in nested runs. The session id recorded when it opens. | Three tickets whose `tool` rules change the same line. A `hold` rule keeps ticket 2's second turn open, and the test kills the worker. After `sous resume` the log has no new request for tickets 1 and 3, and ticket 2's next request resumes its session in its own `cwd`. Three branches exist, each with one change. |
| 10 | A room talks | Decision 13. | Each proposer gets its own word alone. In the room, `recall` puts each word in that member's message. The mediator's decision holds both. |
| 11 | An agent kept alone hears nothing | Nothing new. It holds by construction. | In the same run a third agent's `recall` answer has neither word, and no prompt in its log lines holds one. |
| 12 | The agent needs you, and you step in | Decisions 9 and 10. | A `status` rule makes the implementer's first turn a `question`. A second branch has a `hold` rule. The test runs `sous join` with the fake as the program, which appends the person's line and exits. The next request resumes the same session id with `Continue the task.`, and `recall` returns the person's line. The second branch's turn ended while the person was in. The journal has one `join` row. No call ran twice. |
| 13 | Step into a running session | Decision 10. | A `hold` rule keeps two turns open in two branches. `sous join <run> impl` stops only the implementer's turn, which settles as `working`. The fake appends its line and exits. The next request resumes the same session id with `Continue the task.`, and `recall` returns the person's line. The other branch's turn ran on throughout. |
| 14 | An overnight run survives limits | The continuation that exists, on a kept session and in a nested run. | A `limit` rule with `times: 1` on the implementer's second turn, inside a nested workflow. The run pauses with `usage_limit` and has a `resumesAt`, the time the sous service resumes it. The test resumes it. The same session id goes on in the same `cwd`, and no finished row is requested again. |
| 15 | The owner's build process | Everything above. | `sous check` passes on the ported workflow, and a dry run with scripted answers for one stage gives the expected order of calls. The live run decides the result, on a stage the owner chooses before phase 9. It passes when the run finishes the stage's tickets with `pnpm test` green, with fewer of the owner's actions than the owner's manual run of the same stage. The actions are commands typed, sessions joined and answers given, counted from the owner's notes. |

Scenario 7 uses `sous stop <run> --step <name>`, which pauses the run on that step
(`runs/rule.ts:104`, `docs/guide.md:352`). `sous stop <run>` ends the run, and a stopped run does
not resume (`runs/rule.ts:111`, `runs/run.ts:520`). This design keeps that. A killed worker
leaves the run `interrupted`, and an interrupted run resumes (`runs/rule.ts:98`).

Each live version runs behind its own `SOUS_LIVE_<NAME>=1` variable, on the fixture repository
of its scenario, with the same script deciding the result.

## Resume and the journal

How each new thing replays:

- A turn is an agent row. Its hash covers its prompt, its model, its schema, `until`, and
  `after`, the hash of the turn before it in its session. Its result is the status object, or
  the bare value with `until: "turn"`.
- The loop reads only journal values: a status, a check's exit code and output, a `join` row.
  The next prompt is the script's text, a fixed sentence or a check's feedback. So a
  resumed step asks the same prompts and finds its rows.
- A check command is a code step labelled `<label>: check`, in the step's folder. A check
  function's calls are ordinary rows.
- A wait for the person is a `join` checkpoint row. A replay keeps its value, as it keeps a
  recorded answer today (`checkpoint-call.ts:164-198`).
- A session is rebuilt from rows. A replayed turn puts its session id in the engine's map,
  so the first live turn resumes it.
- A fork has its own rows. Its first row holds the forked session's id, so a replay never
  forks again.
- A place is found by name. A session's worktree is named for its run and label, with its
  hash. A resume reuses the branch and the folder through `makePlace`'s path
  (`places/places.ts:76`), where `makeWorktree` checks out a branch that already exists
  (`:55-58`).
- A nested run's id is `<parent>-nested<N>`, with N from the order of the `workflow()` calls
  (`resume-identity.ts:8`, `workflow.ts:1763`). A resume replays the script in the same order, so
  the id holds, and so does the branch `sous/<nested run id>`.
- An interrupted turn goes on in its session, whatever stopped it: the person stepping in, a
  pause for the budget, a time limit or the usage limit, a lost login or a kill. One rule picks
  the next turn's prompt:
  - A slash step sends its slash prompt again as written, with no schema, then the report turn
    as decision 2 says. The goal may not outlive the process.
  - A plain step sends `Continue the task.` with the turn's schema. That is the status schema,
    or on an `until: "turn"` step the step's own schema if it has one.
- The adapter marks a turn whose prompt the program received. When the mark is missing, the
  resumed turn sends the turn's own prompt instead. A reported session is not that mark. Codex
  reports the thread before `turn/start` (`codex/run.ts:242`, `:250`), and Claude reports `init`
  before the prompt stream yields the prompt (`claude/run.ts:137-145`, `:182-185`). On Codex the
  mark is `turn/start` returning. A live test in phase 4 settles which Claude message marks it.
- A handle whose first turn left no row has no session yet, so a resume runs that first turn
  again in a new session. A Codex thread killed before its first turn has no rollout
  (`codex/run.ts:48`, `:234`), and this rule covers it. Once the first row is written, a session
  the program can't find stops the step with an error. It never starts fresh.
- A tell and the person's own turns in a session are not rows. They change the session, not
  the journal. Each leaves a line in the activity and in `events.jsonl`.
- A room replays as the rooms draft says, turn by turn.
- In the dry run, a stand-in answers a status schema with `done`, the first value of its enum.
  A plain answer in an `--answers` file counts as `done` with that result, so old files work. An
  object whose only keys are `status`, `result` and `message` is a status. A check command runs
  once, for real. Whatever it exits with, the loop ends and the dry run notes the code, as
  PROPOSAL.md argued. A scripted `question` is noted too, and the dry run
  goes on as if the person had stepped in and left.

`phase()` is kept per branch of `parallel()` and `pipeline()` (`steps/phase-scope.ts`), so a
branch's phase reaches neither its siblings nor the code after it, and a nested workflow has its
own. A step reads it when it is called, and it stays in the call hash. Phase 0's test
(`packages/engine/test/phase-resume.test.ts`) shows that a resume gives each step the phase it had
the first time, however the branches interleave.

### What changes for a 0.1.0 script

| In a script today | What happens | What to write |
| --- | --- | --- |
| Any `agent()` step | It gets more turns when the agent reports `working`, and it may ask a question. | Nothing, or `until: "turn"` for one turn. |
| `keepSession`, `continue` | Refused with a message. | `session()` and `send()`. |
| `isolation: "worktree"` on a step | Refused with a message. | `place: "worktree"`. The branch now stays. |
| `isolation: worktree` in an agent's frontmatter | Read as `place: "worktree"`. The branch now stays. | Nothing. |
| `ask: true` | Works, by the status. The person steps into the session to answer. | Nothing. `ask: false` forbids questions. |
| `answeredBy` on an agent step | Refused with a message. | Remove it. The person steps in with `sous join`. |
| `gate()`, `retry()` | Refused with a message. | `check` and `maxTurns`, or a plain loop. |
| `checkpoint()` | Refused with a message. | `ask()`. |
| `configOptions` | Refused with a message. No program read it (`workflow.ts:396-401`). | Remove it. |
| A prompt that relied on the `Task label:` line or the contract paragraph | Neither is in the prompt. | Nothing. The label is in the system text. |
| An `--answers` file keyed by `<label> (answer N)` | No match. An agent's question has no text answer now. | Remove those keys. |

### What changes for a paused run

A run paused under 0.1.0 runs its agent steps again after the upgrade. Their hash has `until`
now. Its code steps and the answers to its `ask()` and `breakpoint()` calls replay. Finish or stop paused runs before the upgrade, or start them again with
`sous rerun`. One breaking release carries all of it.

## The architecture test

Where the new code lives:

- `packages/engine/src/turns/` and `packages/engine/src/room/` join `CORE`
  (`test/architecture.test.mjs:230`). Neither reaches `runs/`. `BREAKS.reach`
  (`test/architecture.test.mjs:461-465`) shows that `steps/steps.ts` already reaches
  `runs/home.ts` through `agents.ts`. So `turns/` imports neither `agents.ts` nor `steps/`.
- `turns/status.ts`, `room/order.ts`, `room/prompt.ts` and `continuation-candidates.ts` join
  `RULE_MODULES` (`test/architecture.test.mjs:215-227`).
- `runs/session-hold.ts` and `runs/join.ts` are outside `CORE`. The steps module
  is in `CORE`, so the worker hands it the hold as a function in `StepsOptions`, as it hands it
  `steering` and `gate` today (`steps/steps.ts:66-69`).
- The cli may not import `packages/harnesses` (`test/architecture.test.mjs:43-68`). `sous join`
  gets the program's path, arguments, folder and environment from `runs/join.ts`.
- The engine README's Inside table gets a row for `src/turns/`, `src/room/` and
  `src/continuation-candidates.ts`. The test fails on a folder the table does not name
  (`test/architecture.test.mjs:1029-1042`).
- No package gains an outside library.

It touches these caps. A cap must match its count exactly (`test/architecture.test.mjs:438-442`),
and none goes up. So each cap change goes in a commit of its own, before the code that needs it,
and the phase ends green after the code commit.

| Cap | Today | After | Why |
| --- | --- | --- | --- |
| `AgentOptions` fields | 18, at its cap (`test/architecture.test.mjs:441`) | 16 | Four options leave and two enter, in one move in phase 2. `check`, `maxTurns`, `maxRepairs`, `ask` and `place` sit on the send options if the count needs it. |
| `WorkflowRunOptions` fields | 36, at its cap (`:440`) | 36 | `loadSavedWorkflow` and `listSavedWorkflows` (`workflow.ts:273`, `:281`) become one field. That frees one for `onTurnSession`. |
| `workflow.ts` lines | 2,309 of 2,312 (`:425`) | lower | Step worktrees, `retry`, `gate`, `configOptions` and the nine globals lines leave. I count about 150 lines out and about 40 in. The test asks for a lower cap once a file is 50 lines under it (`:918`). |
| `runLevel`, `agentImplementation`, `runLive` | 1,472 of 1,476, 780 and 446 (`:427-429`) | lower | The same removals. |
| `workflow-manager.ts` lines | 2,079 of 2,084 (`:426`) | lower | `buildPreparedContinuation` moves out, 69 lines. |
| `WorkflowManager` methods | 11 (`:439`) | 11 | No new public method. The join abort goes through `cancelAgentSteps` (`workflow-manager.ts:1859`), whose `select` takes the join reason. |
| A function's 250 lines (`:422`) | `createSousGlobals` has 200. `runOnHarness` has 211. | under 250 | The ask loop leaves `createSousGlobals`. `runOnHarness` gets a helper for picking the turn's schema and running the report turn. |

No cap goes up.

## Build order

The phases are milestones on this branch. Each ends with `pnpm test` green and a commit. One
breaking release carries them all, at the end. Each scenario's deterministic test lands in the
phase that makes it pass, under `packages/cli/test/scenarios/`.

| Phase | What it builds | Scenarios | Live tests |
| --- | --- | --- | --- |
| 0. Ground | The `phase()` test. The new rules in the fake programs, with the `system` and `session` matchers. The scenario helper. The architecture rows for `turns/` and `room/`, in commit 7d7c6ab2. | None. | Tests 10, 11 and 13, done on 2026-11-26. |
| 1. Prompts as written | `buildPrompt` and the contract go. The label moves to the system text. The report turn, only for a slash prompt with the step's own schema. The `sous check` note. `--note` on a slash prompt. The golden files rewritten. | 1 | Skills, test 8. `/goal` tests 4 and 6. Test 1 with a `--note`. |
| 2. Sessions | The cap commit for `AgentOptions`, then its 16 fields in one move. Lines freed in `workflow.ts` and the old options refused. The session map and `after` in the hash. `session()`, `send()` and `agent()` on it. The `QUESTION:` loop goes. The text readers. | 5 | One kept session on each program. |
| 3. The done signal | `turns/status.ts` and `turns/loop.ts`. `until`, `check`, `maxTurns` and `maxRepairs`. The report turn asks for the status. `question` waits on a `join` row, which engine tests answer through the testing kit. One program per step, open across its turns. The defaults of decision 6 go. Each step kind's `input` and `schema`, input schemas and `meta.schema`. The dry run. | 2 on Claude Code, 3, 4 | Test 9, the status on both programs. Scenario 3 on each program. Scenario 4, with one ticket that fails through a `check` that exits 1. |
| 4. Resume keeps the session | The wider continuation, in nested runs too. `onTurnSession`. Rows for a killed worker's calls. The one rule for a turn that stopped early. | 7, 14 | Scenario 7 on each program. `/goal` test 5. Which Claude message marks a delivered prompt. |
| 5. Places and forks | `place` on a session and a step, with its branch kept. `fork()` on both programs. | 6, 8, 9 | A fork in a worktree and an epic of two tickets in worktrees, on each program. Test 7. Done on 2026-11-27. |
| 6. The person in the loop | The session on `sous step` and the page. `sous join`, which answers the `join` row. The hold and its lock. The needs-you panel. The refused native question. | 12, 13 | Scenarios 12 and 13, with `sous join` driven in tmux. The needs-you notice in a Playwright browser. Test 12. |
| 7. Rooms | `room()` from handles, then the room's page. | 10, 11 | Scenarios 10 and 11, in one room of Claude Code and Codex. |
| 8. Codex's slash prompts | On Codex, `/goal` through `thread/goal/set`, a skill as the `skill` item, `/review`, `/compact` and `/prompts:<name>`. Any other leading slash fails the step. | 2 on Codex | Scenario 2 on Codex. |
| 9. The capstone | The owner's build process as one workflow. The guide, the examples and the changelog. | 15 | One real stage, which the owner chooses before phase 9. |

### What the live tests must show

Every live test runs on the smallest model, since it tests sous and not the model. On Claude
Code that is Haiku at low effort. On Codex it is the smallest model the account lists,
`gpt-6-luna` today, at its lowest reasoning effort.

The live tests are in `packages/harnesses/test/live/` and `packages/cli/test/live/`. Each runs only
when its `SOUS_LIVE_<NAME>=1` variable is set, so `pnpm test` runs none of them.

The building agent runs the person-in-the-loop tests itself:

- On the terminal side, `tmux new-session -d` starts `sous join`, `tmux send-keys` types the
  person's lines, and `tmux capture-pane` reads the screen.
- On the page side, Playwright drives a browser against `sous serve`.
- A script decides each result from the journal, the run state and the session file. It never
  decides from what the screen showed.

The `/goal` tests, on Claude Code through `query()` with an open prompt stream. Tests 1 to 3 ran
on 2026-11-26 with Claude Code 2.1.330, SDK 0.3.330 and Haiku at low effort, for under one cent
each. Tests 1, 4, 5 in part, 6 and 8 ran later that day with Claude Code 2.1.332, where `haiku`
is `claude-haiku-5-5` (`packages/harnesses/test/live/slash.test.ts`, `SOUS_LIVE_SLASH=1`). The
rest of test 5 ran on 2026-11-27.

1. `/goal <condition>` starts the loop when it is the whole prompt. It did, and `goal` is in the
   init message's `slash_commands`. Today's label line in front stops it. With `sous resume
   --note`, a slash prompt must still run its command. It does when the note's block comes
   before the prompt, and not after it (decision 5).
2. How many `result` messages the loop sends. One, after the goal was met. The goal's Stop hook
   sent the agent back twice, as user messages that begin `Stop hook feedback:`. No
   `active_goal` message reached the caller.
3. Whether the loop runs to the end with `outputFormat` set. It does not. The structured output
   rule ended the query after two of three model turns, with the status `working`. A slash
   prompt runs with no schema, and the report turn asks for the status.
4. A plain turn with `resume` and a schema after the goal cleared returns the status object. It
   did. A later turn on a goal that is still set runs the goal again: with a schema, the model
   did the goal's work and reported `done`, and the goal cleared. With no schema, the Stop hook
   sent the model back until the goal was met, and the turn's answer was the goal's last message.
   `/goal` with no condition reports the goal, and `/goal clear` clears it. Neither spends a
   token. A met goal clears by itself.
5. After an abort in the middle of the loop, whether a `resume` finds the goal still active. It
   does. After a stop at "Goal set", and again after a stop at the agent's first tool call,
   `/goal` on the resumed session answered "Goal active: ... (not yet evaluated)". The slash
   prompt sent again in that session, as sous sends it on a resume, met the goal, and the goal
   cleared (2026-11-27, Claude Code 2.1.332).
6. Whether the evaluator's tokens are in the usage sous reads (`claude/run.ts:201-205`,
   `:228-230`). They are not. On a goal turn, the model calls came to about 11,100 to 11,300
   tokens more than `result.usage`, most of them cache writes. A plain turn has a gap of about
   1,200 tokens from another background call. `total_cost_usd` includes them. So a budget in
   dollars counts the evaluator, and a count of tokens does not. On a resume, `total_cost_usd`
   is the session's total so far (decision 1). The Stop hook's feedback reaches the session
   file and not the step's history, which keeps only tool results from user messages.
7. Whether a new worktree under `~/.sous/worktrees` passes the trust rule that hooks need. It
   does. On 2026-11-27, with Claude Code 2.1.332 and Haiku at low effort, a session with place
   "worktree" sent `/goal every test in test/ passes` in a worktree Claude Code had never seen.
   The goal's Stop hook ran, the model made the fixture's tests pass, and the goal cleared: a
   second `/goal` in the same session printed "No goal set". The test is in
   `packages/cli/test/live/places.test.ts`, behind `SOUS_LIVE_PLACES=1`.

The other tests, each behind its own variable. Tests 10, 11 and 13 ran on 2026-11-26, with
Claude Code 2.1.330, SDK 0.3.330 and Haiku at low effort, and with Codex 0.169.0 on `gpt-6-luna`
at low effort.

8. `/canary` runs a project skill marked `disable-model-invocation: true`, a user skill and a
   plugin skill. The project skill ran, and is in the init message's `skills` despite the mark.
   A user skill and a plugin skill are in `skills` too. A plugin's commands are only in
   `slash_commands`.
9. Both programs fill the status object with no contract paragraph, and a model that stops early
   reports `working`.
10. `forkSession` with `resume` gives a new id and leaves the parent as it was, and a fork can
    run from another folder. The same for Codex's `thread/fork` with a `cwd`. It passed on both
    programs. Decision 11 has the results. On 2026-11-27 the same ran through `sous run`, in
    `packages/cli/test/live/places.test.ts`: a fork with place "worktree" recalled its parent's
    code word and its own, the parent recalled only its own, and the fork's branch held the file
    the fork wrote, through the commit sous makes when the fork's scope ends.
11. `claude --resume <id>` opens a session the SDK made, and the SDK resumes it under the same id
    after the person's turns. The same for `codex resume` and `thread/resume`. It passed on both
    programs. Decision 10 has the results.
12. After a refused `AskUserQuestion`, the model ends its turn with `question`. Whether
    `interrupt: true` leaves the session fit to resume.
13. On Codex, a `skill` input runs the skill, `thread/fork` copies a thread, and a goal set with
    `thread/goal/set` sends the notifications the protocol names. It passed. A goal starts its
    first turn by itself, and the text `/canary` runs no skill. Decisions 3 and 5 have the
    results.
14. The build workflow of `examples/build` runs a stand-in stage end to end, until the owner names
    a real one. The stage adds two functions to a new library, with two gates, and stand-in
    agents with the owner's agent names run on Haiku at low effort. On 2026-11-27 it passed
    twice: 7 agent steps, both tickets landed after one review each, both gates passed, and the
    stage's tests and each gate's proof passed again on the run's branch with no agent. Each run
    took 160 to 200 seconds and $0.03 to $0.05. The test is in
    `packages/cli/test/live/build.test.ts`, behind `SOUS_LIVE_BUILD=1`.

How the plan holds:

| If the test shows | Then |
| --- | --- |
| The goal does not outlive an abort | Nothing changes. A resumed slash turn sends its prompt again. |
| The evaluator's tokens are missing | They are. The guide says so: a budget in dollars counts them, and a count of tokens is a lower bound for goal steps. |
| Models ignore the status with no contract | The fixed sentence of the report prompt gets the contract's words. The prompt of the work turn stays as written. |

## The owner's answers

The owner answered on 2026-11-26. The design above follows these answers.

1. Handles, with the breaking release and agent steps of a paused 0.1.0 run running again: yes.
2. Every agent step may ask the person, unless it says `ask: false`: yes.
3. Every limit is off by default, and a script can set one. Decision 6 has the rule.
4. Leftover work is committed on the session's branch when its scope ends: yes.
5. The person's exchange with an agent happens in the agent's own session: yes.
6. Stepping into a session stops nothing else in the run, as with two sessions opened by hand.
   Decision 10 holds one session and lets the rest of the run go on.
7. The status goes through the program's native schema, with no report turn after each work
   turn: yes.

   A plain prompt gets no report turn. A slash prompt's turn runs with no schema, since a schema
   ends `/goal` early (live test 3). So one report turn follows a slash prompt's turn. An answer
   that does not fit the schema gets a repair turn.
8. An agent's structured input is its prompt: yes.
9. sous has no channel of its own for an agent's questions. When an agent needs the person, sous
   tells them to step into the session, and they ask and answer there. Decision 9 has the rule.

10. The command that steps in is `sous join`: yes.
11. The live tests may spend the owner's tokens, on the smallest model of each program. `/goal`
    must work in a step. Live tests 1 to 3 show it starts and loops through the SDK.

## Open

- The real stage for scenario 15. The owner chooses it. Live test 14 runs a stand-in stage until
  then.

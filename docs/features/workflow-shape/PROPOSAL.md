# The shape of a workflow

A proposal for how workflows and their steps are built. `DESIGN.md` in this folder replaces it,
and its section on PROPOSAL.md says what stays. Nothing is built yet. It starts a
discussion with the owner, so each section ends in a decision, and the last section lists what the
owner has to decide.

Written on 2026-11-26 from the code at `0ad4e5b9`, the rooms draft in
`docs/features/rooms/DESIGN.md` and the event triggers design on `feature/event-triggers`. This
work called no model. Each claim that only a real run can settle says "needs a live test".

## Today's shape in short

A workflow is a JavaScript file with a `meta` block and a script. The script gets 17 step
functions (`workflow.ts:1902-1919`):

- `agent`
- `sh`, `js`, `py`, `run`, `waitUntil`
- `ask`, `checkpoint`, `breakpoint`
- `parallel`, `pipeline`, `retry`, `gate`, `phase`, `log`
- `workflow`, `choose`

`agent()` takes 20 options: the 18 of `AGENT_OPTION_KEYS` (`workflow.ts:348-368`), plus `ask` and
`answeredBy`, which `sous-globals.ts:247` takes off before the engine sees them.

Every call of `agent()`, a code step or a question is one row in the journal. A resumed run
replays the rows whose kind, call hash and inputs hash match, the n-th with the n-th
(`resume-pairing.ts:5-9`).

## The real problems

### 1. An agent step ends when its turn ends, whatever the agent says

- On Claude Code the step ends at the first `result` message (`claude/run.ts:175-176`, `:254`),
  and sous closes the query (`:268`).
- On Codex the step ends at the first `turn/completed` (`codex/run.ts:149-155`), and sous
  closes the app-server (`:281-282`).
- The steps module runs one turn and returns its text as it is (`steps/steps.ts:458-464`). No
  code asks whether the work is finished. An implementer that answers "I did parts 1 to 3" gives a
  normal result, and the script goes on.

### 2. Turns after the first exist in two places that share nothing

- A schema answer that does not fit gets up to two repair turns in the same session, inside the
  steps module (`steps/steps.ts:91`, `:465-471`).
- `ask: true` is a loop of `agent()` calls in `sous-globals.ts:246-271`. It reads a `QUESTION:`
  line from the text (`:51-54`), so it refuses a schema (`:254`). It gives each later turn a new
  label, `<label> (answer N)` (`:264-266`), so `sous tell --step <label>` and
  `sous stop --step <label>` miss those turns. A sixth question fails the script (`:260`).

### 3. Sessions fall back without an error

- `keepSession` does nothing at run time. It marks the session record and enters the inputs hash
  (`workflow.ts:432-436`, `:982`). `sessionForLabel` returns the latest session of a label
  whatever the mark says (`:592-601`).
- `continue: "<label>"` with a label no step had gives no session, and the step starts fresh
  (`workflow.ts:1274-1275`). The notice code runs only when a session was found (`:1386`), so the
  log shows nothing. `sous check` does not read `continue` at all (`workflows/script.ts:282-294`).
- A step that continues a session on the other harness records `backend-mismatch`, and one whose
  session the program can't find records `reattach-failed`. Both then run fresh
  (`steps/steps.ts:442-443`, `:451-458`). The engine turns that into a notice, never a failure
  (`workflow.ts:1161-1182`). A step whose prompt is "Address this review" then runs in a session
  that never saw the work.
- A step with `isolation: "worktree"` loses its worktree and its branch when it ends
  (`workflow.ts:1546`, `places/places.ts:151-158`, `:191-195`), so nothing can continue its
  session where it worked.
- Nothing stops two steps in `parallel` from continuing one session at the same time. The lookup
  hands out the same session id to both (`workflow.ts:1274-1275`).

### 4. A stopped step starts over

A resumed run goes on in a step's own session only when the run paused at the usage limit or on a
lost login (`workflow-manager.ts:669-693`). A step stopped by `sous stop --step`, by the budget
or by the workflow's time limit runs again in a new session with its first prompt. A long
implementer loses its whole conversation, and finds its own half-made edits in the folder.

### 5. Feedback loops are written by hand

`retry` and `gate` are plain loops around a function (`workflow.ts:1808-1848`). They know nothing
of sessions, so the feedback reaches the same agent only when the script wires `continue` itself.
The example ticket workflow needs 25 lines and a label it changes each round for that
(`examples/textkit/.sous/workflows/ticket.js:37-61`).

### 6. Isolation deletes the work

`isolation: "worktree"` deletes the step's worktree and branch at the end, so "the step hands its
work back in its answer" (`docs/guide.md:493-497`). Two implementers in `parallel` either share
one folder and can clash, or work apart and lose their files. Only a nested
`workflow(..., { place: "worktree" })` keeps a branch. "Where a step works" has four spellings:
`meta.place`, the `place` of `workflow()`, `cwd` and `isolation`.

### 7. A step can't run a native command

- The steps module puts `Task label: <label>` before every prompt
  (`steps/steps.ts:425`, `steps/answer.ts:34-40`), and every step has a label
  (`workflow.ts:966`). Claude Code reads `/<name>` as a command at the start of a prompt, so
  `agent("/goal ...")` reaches the model as plain text.
- `skills` lists what the model may pick on Claude Code (`claude/run.ts:53`) and does nothing on
  Codex (`codex/run.ts:59`). No option makes a step run one skill or command.
- A goal starts follow-up turns after a turn ends. sous closes at the first turn's end (problem
  1), so those turns never run.

### 8. The interface has overlaps, and two caps are full

- `checkpoint` and `ask` ask the same question through the same call
  (`sous-globals.ts:132-144`).
- "Retry" means three things: the `retries` option, which tries a failed attempt again, the
  `retry()` function, and `gate()`.
- `AgentOptions` sits at its cap of 18 fields, and `workflow.ts` has 2,309 lines under a cap of
  2,312 (`test/architecture.test.mjs:425`, `:441`).

One more thing seen on the way. `phase()` sets one value for the whole run (`workflow.ts:696`), a
step reads it when it is called (`:910`), and it is part of the call hash (`:2161`). Two
`parallel` branches that each call `phase()` and then run several steps can give a step another
phase on a resume than on the first run. A test should confirm this before anyone acts on it.

## Principles of the new shape

1. **A step returns only when its end condition holds.** When it can't get there, the run pauses
   on the step. It never moves on with half a result.
2. **One loop of turns.** Keeping an agent going, asking the person, feeding back a failed check
   and a room member's turns are the same thing: more turns in one session. Each turn is an
   ordinary `agent()` call in the journal.
3. **A session has a name.** The name owns the harness, the model, the agent and the folder.
   Steps that give the same name talk to the same agent.
4. **What a script names must exist.** A session that is gone, a command the program lacks or a
   session on the wrong harness stops the step with a message.
5. **sous decides from journal values only.** A prompt holds the script's text, earlier results
   and fixed sentences. Nothing depends on timing, so resume stays exact.
6. **A script asks for a native feature by name, and sous still checks the result itself.**
7. **A 0.1.0 script runs unchanged.**

## Decision 1. How an agent step ends and hands off

The owner wants the agent to say when its step is done. Five ways to get that:

| Option | How | For | Against |
| --- | --- | --- | --- |
| A. Status in the answer | Each turn answers through the schema with `done`, `working` or `question`. | Works the same on both harnesses, which already enforce a schema. The answer is in the journal. Every turn has to declare. The dry run can make one up. | The agent judges itself. The answer costs a few tokens per turn. |
| B. A `done` tool | sous attaches a small MCP server with `done` and `ask`. | Natural for a model. | Codex needs a real server process per step. A tool call lives in the history, so sous would have to copy it into the answer to journal it. An agent can call `done` and keep working. A `tools` allow list would have to let it through. |
| C. A `sous done` command | The agent runs it in its shell. | No server. | A reviewer with `tools: [Read, Grep, Glob]` has no shell. Codex's sandbox may refuse the write to the home (`docs/guide.md:299-301`). The state lands in a file outside the journal. |
| D. A Stop hook | The SDK's `hooks.Stop` blocks the stop until a check passes. | The turn can't end early. | Claude Code only. The state lives in the program. It is a check, not a declaration. |
| E. The native goal | The program's own evaluator judges. | Built in. | Another model judges from the transcript alone, and each program does it its own way. See decision 2. |

**The choice is A**, with a check sous runs itself for the cases where a claim is not enough.

A step asks for it with `until: "done"`. The answer of each turn is one flat object, with `done`
first in the list of statuses:

```json
{ "status": "done", "result": "<the step's text, or its schema's value>", "message": null }
{ "status": "working", "result": null, "message": "Parts 4 and 5 are left." }
{ "status": "question", "result": null, "message": "Should the flag cover import too?" }
```

- `done` ends the step, and `agent()` returns `result`. A step's own `schema` becomes the shape of
  `result`, so a script reads the same value as today.
- `working` starts another turn in the same session with a fixed sentence that says to go on.
- `question` exists only with `ask: true`. The question goes to the inbox as today, and the
  answer starts the next turn. `ask` then works with a schema.
- `maxTurns`, 10 by default, caps the turns that run live in one go of the run. Replayed turns
  don't count. This is the rule the budget and the time limit follow already
  (`docs/guide.md:470-481`). At the cap the step fails as `not done`, and the run pauses on it.
  `sous resume` goes on in the same session with the same allowance.

The object is flat, with every field required and `null` allowed, because Codex takes a strict
schema whose root is an object (`codex/run.ts:258`). Whether both programs fill it well, and
whether a model that stops early then says `working`, needs a live test.

### Opt-in or always

- Always on would change the schema, and so the call hash, of every agent step. A run that is
  paused today would run its finished steps again after the upgrade.
- A reviewer with a verdict schema already ends with a deliberate answer. A status adds cost and
  no information there.

**The choice is opt-in per step.** The long steps ask for it.

### Where the loop lives

| Option | For | Against |
| --- | --- | --- |
| In the steps module, next to the schema repairs. | One journal row per step. | The engine writes the row at the end. A worker that dies in turn 5 leaves no row and no session id, since the engine builds the session record when the attempt settles (`workflow.ts:1147-1159`). The loop can't ask the person, because questions are the engine's job (`steps/agent-runner.ts:66`). |
| In `sous-globals`, as a loop of `agent()` calls, the way `ask: true` and the rooms draft do it. | Each turn is a row. A resume replays the finished turns and goes on from the first one with no result. Questions and check commands are ordinary journaled calls. | A long step shows as several calls. |

**The choice is a loop of `agent()` calls**, in a file of its own. Every turn keeps the step's
label, as the rooms draft asks for its members, so `sous tell`, `sous stop --step` and `--set`
reach each turn. Turns that send the same fixed sentence pair by occurrence on resume
(`resume-pairing.ts:5-6`).

### Handing off

A step hands the next one three things, and no new option is needed for them:

- its `result`, with a `schema` when the next step reads fields;
- its session, when the next step should talk to the same agent (decision 3);
- its folder, when the next step should see its files (decision 6).

The new part is the guarantee in front of them. The next step starts only after the end condition
held.

## Decision 2. Native goals and commands

What the docs say, and what they leave open:

- Claude Code's `/goal <condition>` is a prompt-based Stop hook for one session. A small model
  reads the conversation after each turn and Claude starts another turn until the condition holds.
  With `claude -p` the whole loop runs in one invocation. The condition holds at most 4,000
  characters and is itself the first prompt. The evaluator runs no tool, so it judges only what
  the conversation shows. It is off under `disableAllHooks` or `allowManagedHooksOnly`
  ([goal docs](https://code.claude.com/docs/en/goal)).
- The Agent SDK runs a command when the prompt starts with `/<name>`, lists the commands of a
  session in its `init` message, and gives them through `supportedCommands()`
  ([SDK docs](https://code.claude.com/docs/en/agent-sdk/slash-commands)). The goal page does not
  name the SDK. The SDK's types do carry an `active_goal` message with the condition and the
  turn count, and `null` when the goal clears (`SDKActiveGoalMessage` in `sdk.d.ts` of 0.3.330,
  the version sous pins). The type is not in the `SDKMessage` union, but `query()` passes the
  message through to the caller (`sdk.mjs` queues every `active_goal` it reads), so the adapter
  needs a type guard of its own. That suggests `/goal` works through `query()`. **Needs a live
  test.**
- Codex keeps a goal on the thread and starts follow-up turns when the thread is idle
  ([cookbook](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)).
  Third-party write-ups name `thread/goal/set`, `get` and `clear` as experimental app-server
  methods. sous's copy of the protocol has none of them (`codex/rpc.ts:32-37`). It does have a
  `skill` input for a turn (`codex/generated/v2/UserInput.ts`).

The options:

| Option | For | Against |
| --- | --- | --- |
| A. No native goal. `until: "done"` and `check` do the job on both harnesses. | Nothing new. | The owner asked for `/goal`. |
| B. A `command` option. The step's prompt is the command's arguments, and sous sends `/<name> <prompt>` as the first thing the program reads. | One option covers `/goal`, a skill, a custom command and `/compact`. sous sends the command itself, so the model can't skip it. | `/goal` is Claude Code only at first. |
| C. A portable `until: "goal"` that sous maps to each program. | One spelling for both. | Codex's side is experimental and not in sous's protocol copy. Two evaluators that judge differently would hide behind one word. |
| D. Read a prompt that starts with `/` as a command. | Nothing to learn. | A ticket's text that starts with `/some-skill` would run that skill. The label line in front protects against that today by accident. |

**The choice is B.** `command` is explicit, so text from outside never starts a command.

How it works:

- `agent("the tests in test/auth pass", { command: "goal" })` sends `/goal the tests in test/auth
  pass`, with no label line and no contract text around it. `command` enters the call hash.
- Before the first message, the Claude adapter asks `supportedCommands()`, as it asks
  `supportedModels()` today (`claude/run.ts:139-144`). A command the session lacks stops the step
  before any model call.
- For a goal, the adapter ends the step at the first `result` that comes while no goal is set. It
  tracks the `active_goal` messages for that. This rule is right whether Claude Code sends one
  `result` for the whole loop or one per turn.
- On Codex, `command: "<skill>"` becomes a `skill` input when Codex has that skill. `sous check`
  and the step itself refuse `command: "goal"` on Codex, with a message that points to
  `until: "done"`. A goal that silently ran as one plain turn would be the opposite of forcing
  it.
- `command` combines with the rest. After the goal clears, sous runs the step's `check`, and a
  failed check goes back into the session as a plain turn. The check is the stronger guarantee,
  since the goal's evaluator runs nothing.
- A goal loop is one turn for sous. `timeout` and the run's budget bound it, and the condition
  can say "or stop after 30 turns", as the goal docs advise.

What a live test has to show before this is built:

1. `/goal` sent through `query()` in streaming input mode starts the loop, and the label line in
   front of a prompt stops a command today.
2. How many `result` messages a goal loop sends, and what `active_goal` holds at each.
3. Whether the final answer can fit a schema, so `until: "done"` works with a goal.
4. Whether the evaluator's tokens are in the usage sous reads. If not, the budget under-counts.
5. Whether a new worktree under `~/.sous/worktrees` passes the trust rule hooks need.
6. What a later step in the session sees when the goal never cleared, and whether sous has to
   send `/goal clear`.
7. A forced skill on Codex through the `skill` input.

## Decision 3. Sessions

| Option | For | Against |
| --- | --- | --- |
| A. Keep `keepSession` and `continue`, and turn the silent fallbacks into failures. | Smallest change. | A script that relied on the fallback breaks. `continue` points at a step's label, so a loop needs one call site to start the session and another to continue it. |
| B. A session object: `const s = session({...})`, then `s.run(prompt)`. | Explicit. | A new kind of value in the script, and a second way to run an agent. |
| C. `session: "<name>"` on `agent()`. The first step that gives the name starts the session, and later ones go on in it. | One option replaces two. One call site works in a loop. The name is a string, like every other address in sous. | A typo in the name starts a second session. `sous check` can catch a name used once. |

**The choice is C.** The rules:

- A step with no `session` starts a new session, as today.
- A session owns its harness, model, agent and folder, from its first step. A later step takes
  them unless it gives its own model on the same harness. A step that asks for another harness or
  another folder fails, in `sous check` when the text shows it, else when it runs.
- One turn at a time. A second step that names a session while a turn runs in it fails.
- A session the program can't find any more fails the step, and the run pauses on it. It does not
  start fresh.
- An interrupted turn of a named session goes on in that session on resume, whatever stopped it:
  the person, the budget, the time limit, the usage limit or a lost login. This widens
  `buildPreparedContinuation` (`workflow-manager.ts:669-693`) for calls that name a session.
- A step with a loop (`until`, `check` or `ask`) and no `session` gets a session of its own, named
  from its label and its place in the script.
- `session` stays out of the call hash, as `continue` is today (`workflow.ts:2141-2172`).

A named session is also something later work can name. A room member is a session (decision 5).
The event triggers design wants to send a new comment on a ticket to that ticket's run, and a
named session is what such a message would go to.

## Decision 4. Feedback loops

| Option | For | Against |
| --- | --- | --- |
| A. Keep `gate` and `retry`, and document the `continue` wiring. | No change. | The loop stays by hand (problem 5). |
| B. A new `loop(worker, checker)` function. | Explicit. | A third loop function, and it still has to learn about sessions. |
| C. A `check` option on `agent()`. | The loop of decision 1 already runs turns in one session. A check is one more reason for another turn. | `agent()` gets one more option. |

**The choice is C.** `check` is a command, a function, or a list of them run in order.

- A command runs as a code step labelled `<label>: check`, in the step's folder. Exit 0 passes.
  Otherwise the end of its output goes back into the session as the next turn's prompt.
- A function gets `(result, round)` and returns `true`, `false` or `{ ok, feedback }`, the
  contract of `gate`'s check today (`docs/guide.md:148-150`). It may run steps, such as a
  reviewer. Its calls are journaled like any others.
- Checks run when the agent says `done`, or after each turn for a step without `until: "done"`.
  So `agent("Fix the failing tests", { check: "npm test" })` is test and fix, and a reviewer in a
  check function is review and fix.
- A list puts the cheap check first: `check: ["npm test", review]`.
- A person can be the check. `breakpoint(title, { show })` already returns the person's decision.

When the turns run out with a check still failing, the step fails and the run pauses on it, with
the last feedback as the reason. A script that wants to go on anyway lets its check function
return `true` in the last round it allows.

`gate` and `retry` stay for old scripts and for loops around something other than one agent. The
guide stops teaching them.

## Decision 5. Collaboration

| Option | For | Against |
| --- | --- | --- |
| A. `room()` as the draft has it, built from `agent()` calls. | Designed, and resume-exact. | It was written against `continue` and its pitfalls. |
| B. Agents that message each other through a mailbox tool. | Messages arrive at once. | Outside the journal. The draft rejects it for that reason. |
| C. No room, only `parallel` and a merging step. | Nothing new. | No conversation. |

**The choice is A**, with four changes that the decisions above make possible.

1. A member names a `session`, by default its label, where the draft has `continue`. A proposer
   that worked alone under `session: "gpt"` joins the room as that session, and a later
   `agent(..., { session: "mediator" })` goes on after the room.
2. A member's `done: true` becomes `status: "done"`, so one word means one thing in sous. The
   turn's answer is `{ status, messages }`.
3. The draft's rule that refuses a member whose step had `isolation: "worktree"` goes away, since
   a session keeps its folder (decision 6).
4. The room runs its turns through the same turn function as the step loop, in the same folder
   of the source.

Everything else in the draft stands: the three turn orders, the endings, the transcript, the
person in the room, and phase 2.

## Decision 6. Isolation

| Option | For | Against |
| --- | --- | --- |
| A. Keep `isolation: "worktree"` as it is. | No change. | The work is deleted (problem 6). |
| B. Drop step isolation. A nested `workflow(..., { place })` is the only way to work apart. | One way. | A saved workflow file for every agent that should work apart. |
| C. A step's own place belongs to its session and stays. | Sessions and folders line up. Parallel implementers keep their work. | Branches stay until someone merges them. |
| D. C, and sous merges the branch back when the step ends, with conflicts sent back into the session. | Complete. | sous would own merges and conflicts. Too much for a first version. |

**The choice is C now and D later.** The rules:

- `place: "worktree"` on `agent()` is the new spelling. It is the word `meta.place` and
  `workflow()` already use.
- The worktree and its branch belong to the step's session. Later steps in the session work
  there. Both stay until the run ends, and then follow the rule of the run's own worktree: kept
  when it changed, removed when it did not, and cleaned by `sous gc` once merged
  (`docs/guide.md:485-489`).
- The branch is named `<the run's branch>-<session name>`. Code steps get the run's branch in
  `SOUS_BRANCH`, so a script merges with `sh('git merge --no-edit "$SOUS_BRANCH-impl-a"')`.
- A `check` command runs in the step's own place. `check: "git diff --quiet && npm test"` makes
  the agent commit before it is done.
- Steps without `place` share the run's place, as today. `cwd` stays for a subfolder.
- `isolation: "worktree"` keeps its old behavior under its old name.

## Decision 7. The smallest set

Remove a function or an option only when something deeper replaces it.

| Today | New shape | Why |
| --- | --- | --- |
| `keepSession`, `continue` | `session` | One option, with rules that fail loudly. |
| `isolation` | `place` on the step | One word for where work happens. |
| `ask: true` by `QUESTION:` line | `ask: true` by the status | One loop, and it works with a schema. |
| `gate`, `retry` | `check` and `maxTurns` | The loop knows the session. |
| `checkpoint` | `ask` | The same question. `ask("...", { choices: ["yes", "no"] })` is a confirm. |
| `configOptions` | gone | No harness reads it (`workflow.ts:396-401`). |
| no way | `until`, `command` | The owner's points 1 and 2. |

`pipeline` and `choose` stay. Both are short forms the page draws, and this proposal has nothing
deeper to put in their place. The code steps stay as they are. They end when their command exits,
and nobody is confused by them.

The count goes from 17 functions to 14, and to 15 with `room`. `agent()` goes from 20 options to
22, in four groups with one job each: who runs, where, until when, and what comes back. Two
words get one meaning each. `retries` are tries after a failure. `maxTurns` are turns of work.

## The new shape

### Step functions

| Function | Returns |
| --- | --- |
| `agent(prompt, options)` | The result: text, or the schema's value. It returns once the end condition holds. |
| `room(options)` | `{ ended, decision, rounds, transcript, members }`, as in the rooms draft. |
| `sh(command, options)`, `js(source, input, options)`, `py(source, input, options)`, `run(file, options)`, `waitUntil(command, options)` | `{ code, stdout, stderr, result }`. Unchanged. |
| `ask(question, { choices, answeredBy })` | The answer as text. |
| `breakpoint(title, step, { show, max })` | The approved result, or the decision when it has no step. Unchanged. |
| `parallel(functions)`, `pipeline(items, ...stages)` | A list of results. Unchanged. |
| `workflow(name, args, { place, label })` | The nested workflow's result. Unchanged. |
| `choose(prompt, options)` | `{ choice, reason, result }`. Unchanged. |
| `phase(title)`, `log(message)` | Nothing. |

Kept for old scripts, with a note from `sous check`: `gate`, `retry`, `checkpoint`.

### Options of agent()

| Group | Option | Meaning |
| --- | --- | --- |
| Who | `label` | The step's name in the log, on the page and for `--set`, `tell` and `stop`. |
| | `agentType`, `model`, `effort`, `mode`, `skills`, `mcp`, `mcpServers`, `images` | As today. |
| | `command` | A command or skill of the program. The prompt is its arguments. |
| Where | `session` | The name of the session the step runs in. |
| | `place` | `"worktree"` gives the session a worktree of its own. |
| | `cwd` | A subfolder. |
| Until when | `until` | `"done"` asks for the status answer. Without it the step ends with its turn. |
| | `check` | A command, a function, or a list of them. A failure goes back into the session. |
| | `maxTurns` | Most live turns in one go. Default 10. |
| | `ask`, `answeredBy` | The agent may ask the person, and who may answer. |
| | `timeout`, `retries` | One attempt's time limit, and tries after a failure. As today. |
| What comes back | `schema` | The shape of the result. |
| Display | `phase` | As today. |

Kept for old scripts: `keepSession`, `continue`, `isolation`.

### Example 1. Implement, review and verify a ticket, with a long implementer

```js
export const meta = {
  name: "ticket",
  description: "Implement a ticket until its tests pass, a reviewer approves and a verifier confirms",
  inputs: {
    ticket: { type: "string", description: "What to build or fix", required: true },
    turns: { type: "number", description: "Most implementer turns in one go", default: 12 },
    test: { type: "string", description: "The command that runs the tests", default: "npm test" },
  },
  outputs: { summary: "What was built", evidence: "What the verifier checked", commit: "The commit" },
  place: "worktree",
}

const ticket = String(args.ticket).trim()
const title = ticket.split("\n")[0].replace(/^#+\s*/, "").slice(0, 72)
let evidence

// A check returns true, or what failed. What failed goes back into the implementer's session.
const review = async (_built, round) => {
  const diff = await sh("git add -A && git diff --cached", { label: `diff ${round}` })
  const verdict = await agent(
    `Review this change for the ticket below.\n\nTicket:\n${ticket}\n\nChange:\n${diff.stdout.slice(-20000)}`,
    {
      agentType: "reviewer",
      label: "reviewer",
      schema: {
        type: "object",
        properties: { approved: { type: "boolean" }, review: { type: "string" } },
        required: ["approved", "review"],
      },
    },
  )
  return verdict.approved || { ok: false, feedback: `The reviewer asks for these changes:\n\n${verdict.review}` }
}

const verify = async () => {
  const proof = await agent(`Check that this ticket is done here. Try its cases.\n\nTicket:\n${ticket}`, {
    agentType: "verifier",
    label: "verifier",
    schema: {
      type: "object",
      properties: { passed: { type: "boolean" }, evidence: { type: "string" } },
      required: ["passed", "evidence"],
    },
  })
  evidence = proof.evidence
  return proof.passed || { ok: false, feedback: `The verifier found this:\n\n${proof.evidence}` }
}

const summary = await agent(`Implement this ticket in the current folder.\n\nTicket:\n${ticket}`, {
  agentType: "implementer",
  label: "implementer",
  until: "done",
  ask: true,
  check: [args.test, review, verify],
  maxTurns: args.turns,
})

const made = await sh(
  'git add -A && if git diff --cached --quiet; then echo; else git commit -q -m "$TITLE" && git rev-parse --short HEAD; fi',
  { label: "commit", env: { TITLE: title } },
)
return { summary, evidence, commit: made.stdout.trim() || undefined }
```

The implementer works until it says `done`. Then the tests run, then the reviewer reads the diff
in a fresh session, then the verifier tries the cases. The first check that fails goes back to the
implementer, which keeps its whole conversation. The commit step runs only after all three
passed. Today's version of this workflow is 90 lines and moves on when the implementer stops
early.

### Example 2. Three models propose alone, then agree in a room

```js
export const meta = {
  name: "design",
  description: "Three models propose a design alone, then agree on one in a room",
  inputs: { intent: { type: "string", required: true } },
  outputs: { design: "The agreed design", ended: "How the room ended" },
  place: "worktree",
}

const panel = [
  { label: "claude", model: "opus" },
  { label: "gpt", model: "codex/gpt-6-luna" },
  { label: "sonnet", model: "sonnet" },
]

// Alone: each proposer has a session of its own and knows nothing of the others.
const proposals = await parallel(panel.map((p) => () =>
  agent(`Propose a design for:\n${args.intent}`, { ...p, agentType: "designer", session: p.label, until: "done" })))

// Together: the same three sessions meet, with a mediator who decides.
const agreed = await room({
  name: "design",
  goal: `Agree on one design for:\n${args.intent}`,
  members: [
    ...panel.map((p) => ({ label: p.label, session: p.label })),
    { label: "mediator", agentType: "mediator", model: "opus" },
  ],
  opening: panel.map((p, i) => ({ from: p.label, to: "all", text: proposals[i] })),
  decider: "mediator",
  schema: {
    type: "object",
    properties: { design: { type: "string" }, open: { type: "array", items: { type: "string" } } },
    required: ["design", "open"],
  },
  maxRounds: 6,
})

// Alone again: the mediator writes the document in the session it decided in.
await agent(`Write the design to docs/design.md:\n${agreed.decision.design}`, {
  label: "mediator",
  session: "mediator",
  check: "test -s docs/design.md",
})
return { design: agreed.decision.design, ended: agreed.ended }
```

Each proposer runs on its own harness and model in the room too, because the session owns them.
A member that named the wrong harness would stop the room before its first turn.

### Example 3. /goal in the implementer

```js
export const meta = {
  name: "goal-ticket",
  description: "Implement a ticket under Claude Code's /goal, then check it with the tests",
  inputs: {
    ticket: { type: "string", description: "What to build or fix", required: true },
    test: { type: "string", description: "The command that runs the tests", default: "npm test" },
  },
  outputs: { summary: "What was built" },
  place: "worktree",
}

const ticket = String(args.ticket).trim()

// The first turn puts the ticket into the session. The goal's evaluator reads the conversation.
await agent(`Read this ticket and reply with a short plan. Change no file yet.\n\nTicket:\n${ticket}`, {
  agentType: "implementer",
  label: "implementer",
  model: "claude/opus",
  session: "implementer",
})

// sous sends "/goal <prompt>" as written. Claude Code starts turns until its evaluator says the
// condition holds. Then sous runs the tests itself, and a failure goes back into the session.
const summary = await agent(
  `the ticket above is implemented, and \`${args.test}\` exits 0 with its output shown. Or stop after 30 turns.`,
  {
    label: "implementer",
    session: "implementer",
    command: "goal",
    check: args.test,
    maxTurns: 3,
    timeout: "2h",
  },
)
return { summary }
```

`maxTurns: 3` counts sous's turns, which are the goal loop and at most two fixes after a failed
check.
With `model: "codex"`, `sous check` refuses this workflow and names `until: "done"`.

## How the rest holds

### Resume

- Each turn is an `agent()` call, each check command a code step, each question a checkpoint. A
  resume replays them from the journal in the order the script makes them.
- A turn's prompt is the script's prompt, a fixed sentence, a journaled check's output or a
  journaled answer. So a resumed step asks the same prompts and finds its rows.
- `until`, `check`, `maxTurns` and `ask` never reach the engine. They shape the prompt and the
  schema, which the hash already covers. A step with none of them sends the engine the same call
  as in 0.1.0, so a run paused before the upgrade replays its finished steps.
- `maxTurns` counts live turns only. For that the loop has to learn from the engine whether a
  call replayed, which is one new value on the way back from `agent()` inside `sous-globals`.
- Raising `maxTurns` in the file and running `sous resume --latest` keeps every finished turn,
  since the option is not in the hash.

### The dry run

- A stand-in answers with the first status in the list, `done`, as `fabricate.ts:23` picks the
  first value of an enum. A loop ends after one turn.
- The stand-ins skip the harness and its schema check (`steps/steps.ts:218`). So the loop reads an
  answer without a `status` as done, with the answer as the result. An old `--answers` file with
  plain text for a step keeps working.
- `--answers` scripts a loop by label, one entry per turn, since every turn has the step's
  label. `"implementer": [{ "status": "working" }, { "status": "done", "result": "ok" }]` gives
  two turns.
- A check command runs once, for real, as code steps do in a dry run. Whatever it exits with, the
  loop ends, and the dry run notes the exit code. Otherwise `npm test` on a ticket nobody
  implemented would fail every dry run. A check function runs as written, and its stand-in
  agents answer `true` (`fabricate.ts:72-73`).
- A step with `command` sends nothing to a program. The dry run only confirms that the step's
  options fit.

### sous check

New problems it reports from the text:

- a value of `until` other than `"done"`, or a `maxTurns` under 1;
- steps that give one session two harnesses or two places;
- a `command` the step's harness lacks, read from the skill and command folders, and
  `command: "goal"` on Codex;
- a session name that only one step uses while another step has `continue`, as a note.

New notes: each use of `keepSession`, `continue`, `isolation`, `gate`, `retry` and `checkpoint`,
with its replacement. `script.ts` learns to read `session`, `place`, `command` and the loop
options, where it reads `keepSession` today (`workflows/script.ts:292`).

### The page

- A step with a loop is one node. Its turns are the calls of that step, which the page and
  `sous step --call N` already show for a step that ran more than once.
- The node shows `until`, the check's command, the turns used and the session's name. A check
  function's steps draw as the node's loop body, the way `gate`'s body draws today
  (`workflows/flow.ts:495-499`).
- `StepOptions` gains the new fields in `workflows/flow.ts` and in the view's
  `api/contract.ts`, which mirror each other field for field (`workflows/flow.ts:8-9`).
- Steps of one session can share a color or a lane. That is the view's choice, later.

### tell, stop and --set

- `sous tell --step implementer` reaches the turn that runs now, since every turn has the label.
  Between two turns, while a check runs, a tell gets `turn_not_steerable` today. The steering
  board should hold it and send it when the next turn opens. The prompt does not change, so
  resume stays exact.
- `sous stop --step implementer` stops the running turn, and the run pauses on it. `sous resume`
  goes on in the session where today it starts over.
- `--set implementer.model=` reaches every turn. The loop options become settable too, such as
  `--set implementer.maxTurns=20`, once `sous-globals` merges the overrides before it reads
  `ask` (`sous-globals.ts:247-252` reads it first today).

### The budget

- Each turn is an agent step, counted as its tokens arrive (`steps/steps.ts:391-394`). A check
  command counts none. sous counts a long goal loop while it runs, so the budget can stop it in
  the middle.
- The run's cap of 1,000 agent calls counts each turn.
- Whether the goal evaluator's tokens show in the usage is in the live test list.

### The architecture test

- The loop goes in new files: `packages/engine/src/turns/status.ts`, with the status schema and
  the fixed sentences, pure and a rule module, and `turns/loop.ts`. `createSousGlobals` is 200
  lines under a function cap of 250, so the loop can't go inside it.
- `workflow.ts` has three lines of room. Removing `configOptions` frees about 50, and giving the
  script every function of `createSousGlobals` in one line frees eight, as the rooms draft
  proposes. The caps then go down in a commit of their own.
- `AgentOptions` stays at 18. `configOptions` and `continue` leave the type, and `session` and
  `command` enter it. An old script's `continue: "x"` reaches the engine as `session: { step:
  "x" }`, which does today's lookup by label with today's fallback. `continue` was never in a
  hash, so no row changes. `place: "worktree"` reaches the engine as `isolation`, and the engine
  keeps the worktree when the call names a session. When `keepSession` goes in a later version,
  the count drops to 17.
- The harness package changes in two files: `claude/run.ts` for the command and the goal rule,
  and `codex/run.ts` for the skill input. `Step` in `types.ts` gets `command`.

## Migration

Every 0.1.0 script runs on the new version with one exception.

| In a script today | What happens | What to write |
| --- | --- | --- |
| `keepSession: true` and `continue: "x"` | Runs as today, fallbacks included. `sous check` adds a note. | `session: "x"` on both steps |
| `isolation: "worktree"` | Runs as today. The worktree is deleted at the end. | `place: "worktree"`, with a `session` if later steps go on |
| `ask: true` | Runs. The agent asks through the status, and later turns keep the step's label. | Nothing |
| `gate(...)`, `retry(...)` | Run as today. | `check` and `maxTurns` on the agent step, or a plain loop |
| `checkpoint(...)` | Runs as today. | `ask(...)` |
| `configOptions` | Refused with a message, as `tier` is today (`workflow.ts:371-378`). | Remove it |

What changes for someone who does nothing:

- A script with `configOptions` stops. No harness read it.
- An `--answers` file keyed by `"<label> (answer 1)"` no longer matches, since those turns are
  now `<label>`.
- A run paused under 0.1.0 inside a step with `ask: true` runs that step again after the
  upgrade, because its prompt changed. Every other finished step replays.

The old names leave in a later version, with the same refusal messages `tier` has.

## Build order

1. The live tests of decisions 1 and 2, by hand, behind their environment variables. They decide
   whether `command: "goal"` ships with the rest or after.
2. The architecture test's tables, in a commit of their own.
3. Free the lines in `workflow.ts`: remove `configOptions`, hand over the script's functions in
   one line. No change in behavior.
4. `session` in the engine: the lookup by name, the failures, one turn at a time, and the resume
   of an interrupted turn. `continue` maps onto it.
5. `place: "worktree"` kept with its session, the branch name and `SOUS_BRANCH`.
6. `turns/status.ts` and `turns/loop.ts`: `until`, `maxTurns`, `ask` on the status, then `check`.
7. `command` in the two adapters and through the engine, with the goal rule.
8. `script.ts`, `flow.ts`, `step-options.ts`, `check.ts`, the dry run's check rule, and the view.
9. `room()` from the rooms draft, on sessions and the turn function.
10. The guide, the example workflows, the changelog and the golden files.

Steps 4 to 6 fix the owner's first point and can ship without 7 and 9.

## Questions for the owner

1. **Pause or return.** When a step can't reach its end, because its turns ran out, a check keeps
   failing or a goal was judged impossible, this proposal pauses the run on it. The other choice
   returns an outcome such as `{ done: false, feedback }` and lets the script go on, as the ticket
   example does today with `approved: false`. Which do you want as the default?
2. **Opt-in or default.** `until: "done"` is opt-in per step here, to keep old scripts and paused
   runs exact. Do you want it on by default for every agent step, or set once in an agent's
   frontmatter, such as the implementer's?
3. **The goal.** May the live tests of `/goal` through the SDK spend your tokens? And is Claude
   Code only acceptable for `command: "goal"` at first, with Codex refused until its goal methods
   are stable?
4. **A lost session.** Should a step whose named session is gone pause the run, as proposed, or
   start fresh with a note, as `continue` does today?
5. **Merging back.** Is a kept branch that the script merges enough for isolated steps, or should
   sous merge it when the step ends and send conflicts back to the agent?
6. **The names.** `until: "done"`, `check` and `maxTurns` here, where your sketch had
   `untilDone`, `verify` and `maxTurns`. `check` is the word `gate` uses today, and it also
   covers a step with no status.
7. **How far to cut.** `pipeline` and `choose` stay in this proposal. Do you want them gone too?
   And when should the old names stop working: the next minor version, or 1.0?
8. **The default of `maxTurns`.** 10 here. A step with no cap could run until the budget stops
   it.

# Rooms

A room is a workflow step where several agents talk to each other until they reach a goal. This
is a design. Nothing is built yet. Decision 13 of `docs/features/workflow-shape/DESIGN.md`
changes this draft. Where the two differ, decision 13 holds.

Written on 2026-11-26, after a look at the outside tools that let coding agents talk to each other
(see [Sources](#sources)). The owner asked for agents that collaborate as a group, each on its own
model, and for sous to become a flexible way to write any way of working with agents.

## What the owner asked for

- Several agents, each on its own model, talk to one another toward one goal, such as a design.
- A room is one step of a workflow, so it composes with `agent`, `parallel` and `pipeline`.
- The same agents can work alone first and then meet in a room. A design workflow runs three
  proposers in parallel, each on another model, with no contact between them. Then the proposers
  meet in a room with a mediator and agree on one design. Each proposer keeps its own session from
  its solo work.
- Gemini can wait. The room works with any program sous runs.

## Words

| Word | Meaning |
| --- | --- |
| room | One `room()` step: its members, its goal and its transcript. |
| member | One agent in the room, given as a session handle and named by its label. A member is one session, from its first turn to its last. |
| turn | One `send()` on a member's handle: it reads what is new and answers with its messages. |
| round | One pass of turns. In a round of `together`, every member with something new speaks at once. |
| message | Text from one member to another member, or to `all`. |
| transcript | Every message of the room, in order. |
| decider | The member whose decision ends the room, when the room names one. |

## The example

```js
export const meta = {
  name: "design",
  description: "Three models propose a design alone, then agree on one in a room",
  inputs: { intent: { type: "string", required: true } },
  place: "worktree",
}

const panel = [
  { label: "claude", model: "opus" },
  { label: "gpt", model: "codex/gpt-6-luna" },
  { label: "sonnet", model: "sonnet" },
]
const proposers = panel.map((p) => session({ ...p, agentType: "designer" }))
const mediator = session({ label: "mediator", agentType: "mediator", model: "opus" })

// Alone: each proposer works in its own session and knows nothing of the others.
const proposals = await parallel(proposers.map((s) => () =>
  s.send(`Propose a design for:\n${args.intent}`)))

// Together: the same sessions meet, with a mediator who decides.
const design = await room({
  name: "design",
  goal: `Agree on one design for:\n${args.intent}`,
  members: [...proposers, mediator],
  opening: panel.map((p, i) => ({ from: p.label, to: "all", text: proposals[i] })),
  decider: mediator,
  schema: { type: "object", properties: { design: { type: "string" }, open: { type: "array", items: { type: "string" } } }, required: ["design", "open"] },
  maxRounds: 6,
})

// Alone again: the mediator writes the document in the same session it decided in.
await mediator.send(`Write the design to docs/design.md:\n${design.decision.design}`)
return { design: design.decision.design, ended: design.ended }
```

## How a room runs

### A member is a session

A member is a session handle, or `{ session, role }`, where `role` is a line added to that
member's room messages. The member is named by the handle's label. Each turn is one `send()` on
the handle, so every turn goes on in the member's own session. A handle that worked alone before
the room brings that session in. After the room, a `send()` on the same handle goes on in it
again. So one agent can work alone, then in a room, then alone, and remember all of it.

A handle holds its program, model and folder, so a member runs on them in the room.

Each turn of a member keeps the handle's label. A step that runs more than once is already
normal in sous: `sous step --call N` picks one call. So `--set gpt.model=...` reaches every turn,
and `sous tell --step gpt` reaches the turn that runs now.

### Turn order

`turns` picks one of three orders. Each one decides who speaks next from the transcript alone.

- `together`, the default. Round 1: every member speaks at once. Each later round: every member
  that got a new message in the last round speaks at once. The turns go through the same limiter
  as any agent call, so `concurrency` and the configured `maxAgents` hold. The messages of a
  round join the transcript in member order, never in the order the turns finished.
- `in order`. One member at a time, in member order, as around a table. Each turn sees every
  message before it. A member with nothing new is skipped. A round is one pass around the table.
- `moderated`. The decider speaks first and after each other turn, and names the next speaker in
  `next`, as AutoGen's selector does with a model of its own. A round is one pick.

### What a member reads

By default every member hears every message. A message's `to` decides who must answer it, not
who may read it. A message to `gpt` wakes `gpt` alone, and the others read it at their next turn.
With `hears: "addressed"`, a member's turn holds only the messages sent to it or to `all`.

The first room turn of a member holds the goal, the member list with each member's model, the
member's `role` when it has one, the rules of the room, the opening messages and everything said
before this turn. Each later turn holds only the messages since the member's last turn, since the
session already holds the rest:

```
Round 3. New messages since your last turn:
[gpt to all] I can live with the event log if we keep the queue out of v1.
[mediator to claude] Can your design drop the queue? Say what breaks.
```

No prompt holds a time, a token count or anything else that changes between two runs.

### What a member answers

Each turn answers with JSON, through the step's `schema`:

```json
{ "messages": [{ "to": "all", "text": "..." }], "done": false }
```

- `to` is an enum, with `all` first and then each member's label.
- `done: true` says the member has nothing more to add and accepts where the room stands. A
  message to it wakes it again.
- The decider's answer adds `decision`, as `anyOf` with the room's `schema` first and null second.
  The order matters for the dry run, below.

The turn works as any agent step does before it answers. It can read files, run tools and take
`sous tell` messages from the person.

### When the room ends

In this order, after each round:

1. `decided`: the decider gave a decision that fits the schema.
2. `agreed`: there is no decider, and every member's last answer said `done`. Messages sent in
   that same round don't open the room again.
3. `quiet`: no member has a new message, so nobody would speak.
4. `limit`: the room reached `maxRounds`.

When the room would end `agreed`, `quiet` or `limit` and it has a decider with no decision yet,
the decider gets one more turn first. That turn says why the room is ending and asks it to decide
now.

`maxRounds` has no default. With none, a room ends only `decided`, `agreed` or `quiet`, or when
the person stops the run.

A room that ends on `limit` or `quiet` with no decision returns as it is. The workflow decides
what that means. A member turn that fails its last try pauses the run, as
in `parallel`.

### What room() returns

```js
{
  ended: "decided" | "agreed" | "quiet" | "limit",
  decision: <the decider's value> | null,
  rounds: 4,
  transcript: [{ round: 1, from: "claude", to: "all", text: "..." }],
  members: { claude: { turns: 4, done: true }, mediator: { turns: 5, done: true } },
}
```

### Options

| Option | Meaning |
| --- | --- |
| `goal` | Required. What the room must reach. |
| `members` | Required, two at least. Each is a session handle, or `{ session, role }`, where `role` is a line added to that member's room messages. The handle sets the label, program, model and folder. The room sets each turn's schema. |
| `name` | The room's name in the log and on the page. Default `room`. |
| `opening` | Messages said before round 1, such as each proposer's proposal. |
| `turns` | `together`, `in order` or `moderated`. |
| `decider` | A member's handle. Required for `moderated`. |
| `schema` | The shape of the decision. |
| `hears` | `"all"`, the default, or `"addressed"`. See [What a member reads](#what-a-member-reads). |
| `maxRounds` | No default. |

A label is unique in the room and is never `all`.

## The person in the room

A room has no channel of its own to the person. A member that needs the person asks through its
program's own question tool, as any agent step does. sous says the member needs the person, and
the person steps into that member's session with `sous join <run> <member>`. Decisions 9 and 10 of
`docs/features/workflow-shape/DESIGN.md` have the rule.

The room goes on while the person is in one member's session. Each round takes the turns of the
free members. The member the person is in skips rounds until the person leaves. Its next turn
then holds every message it missed.

The person can also reach a member while its turn runs, with `sous tell <run> --step gpt "..."`,
since a turn is an ordinary agent call. That message lands in the member's activity, not in the
transcript.

## Why a room is built from agent() calls

Each turn is one `send()` on the member's handle, with `until: "turn"` and the room's schema. A
`send()` is one engine `agent()` call. The room adds no state of its own. The transcript is the turns' answers,
put in order. Everything sous does for an agent step holds for a turn:

- **Resume.** sous pairs a resumed call with a recorded one by its kind, its prompt hash and its
  inputs, the n-th with the n-th (`resume-pairing.ts`), and a replayed turn puts its session id
  back in the engine's session map. A turn's prompt depends only on the room's options and the
  answers of earlier turns, in round and member order. So a resumed room replays each finished
  turn, builds the same transcript, asks the same prompts, and runs live from the first turn that
  has no answer.
- **Retries, time limits, the budget, `maxAgents`, `--set gpt.model=...`, `sous stop --step` and
  `sous tell`** work on a turn because it is an agent step.
- **The dry run** answers each turn with a stand-in that fits its schema (`fabricate.ts`). Each
  stand-in carries one message to `all`, the first value of the enum, and `done: true`. The
  decider's stand-in decision is the room's schema, its first `anyOf` choice. So a room with a
  decider ends `decided` after round 1, and one without ends `agreed`. `--answers` scripts a
  whole conversation by label, a list per member. A label's list covers every call with that
  label in the run, so a proposer's solo call takes the first entry.
- **The log and the page** show each turn as a call of the member's step.

Today `agent(..., { ask: true })` is built the same way, from `agent()` calls in
`sous-globals.ts`.

This is why the order rules above never look at which turn finished first. A room where each
member runs as soon as a message reaches it would be livelier, but its prompts would depend on
timing. A resume would then ask different prompts, find no recorded answers, and run the turns
again.

## What a person sees

- `sous log <run>` shows a line for each message: `room design  gpt to all: I can live with...`,
  the first line of the text, through the run's log.
- `sous show <run> --json` lists each member as a step with its calls, as for any step.
- `sous room <run> [name] [--json]` prints a room's transcript in full. Phase 2.
- The page draws a room as one node with a lane per member, and its panel shows the transcript as
  a conversation. Phase 2, with the view.

## Cost

Every member reads every message, and each turn resumes a session, so the program reads the whole
conversation again, mostly from its prompt cache. A room of four for five rounds is up to 20
turns, plus the decider's last one. The run's budget counts their tokens. When the run sets a
cap on agent calls (`maxAgents`), it counts each turn. The room keeps cost down three ways:

- A member speaks only when it has something new. `done` members stay quiet.
- A turn's prompt holds only what is new since the member's last turn.
- `maxRounds` caps it, when the script sets it.

## Shared files

Members share the run's place, as the steps of `parallel` do. Two members that write the same
file at once can clash. The room does not lock files in its first version. The guide will say to
let one member write and the others review, or to give each member a `cwd` of its own. MCP Agent
Mail reserves files for this. sous could add that later if rooms of writers become common.

## Phase 2: live delivery

In a round of `together`, a member often finishes while others still work. In phase 2, its
messages go at once into the running turns they address, through the steering board that already
carries `sous tell` (`steps/steering.ts`). Claude Code reads them after its current tool call, and
Codex through `turn/steer`.

Each message still comes again in its addressee's next prompt, since a prompt can't depend on
timing. The prompt says that some of these messages may have reached the member while it worked.
That keeps resume exact, at the cost of a few repeated lines.

The worker builds the board and gives it to the steps module, which is the run's agent runner.
The runner's interface, `AgentRunner` in `steps/agent-runner.ts`, gets an optional `tell`, and the
room calls it when the runner has one. It does not go in `WorkflowRunOptions`, which is at its cap
of 36 fields in the architecture test. In a dry run the stand-in agents open no turn on the board,
so nothing is delivered live.

The same function is the first half of the roadmap item that sends later events into a running
run, such as a new comment on a ticket. Both deliver a message to a step that runs now. That item
also needs to wake a step that waits, which a room does by giving it a turn.

## Later

- **Messages during a turn.** A `say` tool, from a small MCP server sous attaches to each member,
  sends a message before the turn ends. The steering board delivers it live. To keep resume
  exact, the steps module copies each `say` call from the turn's history into the turn's answer,
  which the journal keeps.
- **File reservations** for rooms of writers.
- **Gemini,** as a third adapter in `packages/harnesses`. Nothing in the room depends on it.

## What changes in the code

New files under `packages/engine/src/room/`:

| File | Holds |
| --- | --- |
| `options.ts` | Reads and checks `room()`'s options. Pure. |
| `order.ts` | Who speaks next and whether the room ends, from the transcript and `turns`. Pure, a rule module. |
| `prompt.ts` | Each turn's prompt and schema, the member's and the decider's. Pure, a rule module. |
| `room.ts` | The loop: runs turns through the members' handles and `parallel()`, puts their messages in the transcript, logs them. |

Changed files:

| Where | Change |
| --- | --- |
| `engine/src/sous-globals.ts` | `SousGlobalDeps` gets `parallel`. `createSousGlobals` returns `room`, built with `room/room.ts`. The room sends each turn through the member's handle, so `--set` changes reach turns. |
| `engine/src/workflow.ts` | `parallel` in the deps. The file has 2,309 lines under a cap of 2,312, and `runLevel` holds the globals, so the change first frees lines (below). `vm.createContext` stays here, since the architecture test allows the `vm` import in this file. |
| `engine/src/workflows/script.ts` | Records a `room()` call and the handles it names as members. |
| `engine/src/workflows/flow.ts` | `room` joins `StepKind`, with its members, for the graph. |
| `engine/src/workflows/check.ts` | What it can see in the text: labels unique and never `all`, the decider a member, `moderated` with a decider, and each member's agent and model on their harness. Labels built in code, as `panel.map` builds them in the example, it can't see. `room/options.ts` checks all of it again when the room starts, before any turn. |
| `engine/README.md` | `room` in the script's functions, and a row for `src/room/` in the Inside table. The architecture test fails on a folder of `src` that table doesn't name. |
| `docs/guide.md`, `CHANGELOG.md` | A section on rooms, and the change. |
| `test/architecture.test.mjs` | `room/order.ts` and `room/prompt.ts` in `RULE_MODULES`, and `room/` in `CORE`. Done in commit 7d7c6ab2. |

To free lines in `runLevel`, the context gives the script every function of `createSousGlobals`
in one line, each wrapped in `tracked`, in place of the nine lines from `agent` to `choose`. That
frees eight lines, so `room` needs no new line there. The caps stay as they are. The architecture
test fails only when a file or function falls 50 lines under its cap.

Phase 2 adds the optional `tell` to `AgentRunner` and to the steps module, adds `sous room` in
`packages/cli`, and adds the room node and panel in `packages/view`.

What stays as it is: `packages/harnesses`, the journal and its format, resume, the run record and
the home's folders.

## Tests

All in `pnpm test`, with no network and no credential.

- `order.ts`: who speaks in each order, the four endings and their precedence, the decider's last
  turn before any ending but `decided`, `done` members woken by a message to them.
- `prompt.ts`: the first and later prompts, with nothing that changes between two runs, and the
  two schemas.
- The example above through the test kit's runner with scripted answers. The room ends
  `decided`, each member's turns go on in one session, and a `send()` on the mediator's handle
  after the room goes on in the mediator's session.
- A resume after a member's turn fails: the finished turns replay, the transcript and prompts
  match the first run, and only the failed turn and the ones after it run live.
- A member whose handle runs on Codex runs on Codex in that handle's session.
- A member that asks the person through its question tool waits, and the other members go on.
- The dry run ends `decided` after round 1 with a decider and `agreed` without one, and
  `--answers` scripts three rounds.
- A member whose handle has its own folder runs in that folder.
- `sous check` refuses each wrong option it can see, and the room refuses the same options built
  in code before its first turn.
- A live test behind its variable: a room of Claude Code and Codex, two rounds, ends `agreed`.

## Build order

1. The rows in `test/architecture.test.mjs`. Done in commit 7d7c6ab2.
2. Give the script the functions of `createSousGlobals` in one line, with no change in behavior.
3. `order.ts` and `prompt.ts`, with their tests.
4. `options.ts`, `room.ts`, `room()` in the script, and the example test.
5. The resume, Codex, folder and waiting-member tests.
6. `script.ts`, `flow.ts` and `check.ts`.
7. The guide, the engine README, the changelog and the golden files.
8. Phase 2: live delivery, `sous room`, the page.

## The owner's answers

The owner answered on 2026-11-26. Decision 13 of `docs/features/workflow-shape/DESIGN.md` carries
these into the design and changes this draft where they differ.

1. `together` is the default order, and `in order` stays a choice.
2. Every member hears every message by default. A room can switch that to only the messages
   addressed to the member.
3. `maxRounds` has no default. Every limit is off unless the script sets it.
4. `room` is the name.

## Alternatives rejected

- **A mailbox over MCP for agents to read, as MCP Agent Mail and agmsg do.** The agent must
  remember to check its inbox, nothing wakes an idle agent, and the messages live outside the
  journal, so a resume can't replay them. sous runs each turn itself, so it delivers a message as
  the next prompt instead.
- **Members that run as soon as a message reaches them, as Claude Code's agent teams do.** The
  prompts would depend on timing, so a resume would run turns again. Claude Code's issue tracker
  also reports late messages and agents that go idle before a peer's message arrives. Phase 2's
  live delivery gives the speed without the timing.
- **A model that picks every speaker, as AutoGen's selector does by default.** It costs a call per
  turn. `moderated` gives the same thing with a member that also takes part.
- **Typing into each agent's terminal, as Herdr does.** It depends on reading screens and leaves
  no record. sous already drives each program through its SDK.
- **Agents that call each other as tools, as Weft does.** That is one call and its answer, not a
  conversation, and the agent called remembers nothing of it.

## Sources

- [Herdr](https://github.com/ogulcancelik/herdr), a terminal multiplexer for coding agents.
- [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) and [agmsg](https://raw.githubusercontent.com/fujibee/agmsg/main/README.md), mailboxes for agents.
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams), and issue reports on late
  messages ([98998](https://claudeissues.com/issue/98998-bug-agent-teams-leads-sendmessage-to-a-running-teammate-is-delivered-only-after))
  and idle waits ([28075](https://claudeissues.com/issue/28075-agent-teams-no-waiting-for-peer-message-state-idle-nudges-expire-before-first-me)).
- [AutoGen SelectorGroupChat](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/selector-group-chat.html).
- [Weft](https://github.com/cipher982/weft), agents as each other's tools.
- [aidebate](https://github.com/markuslund/aidebate) and [adversarial-spec](https://cdn.jsdelivr.net/gh/zscole/adversarial-spec@main/README.md), debates in rounds.

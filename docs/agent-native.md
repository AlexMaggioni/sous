# sous, agent native

The reference for making sous easy to drive from an agent. It holds what the owner decided, what sous does today, the design so far, the facts about Claude Code and Codex it rests on, the build order, the proof, and the rules for the build.

Written 2026-11-23 against main at a6e35a8a. Nothing here is built yet. The next step is an intent for this work, written from this file.

## Why

The owner wants to do anything with their workflows by talking to an agent, the way they work with subagents: write and edit a workflow, start it, watch it, answer it, steer it, stop it and review what it did. Agents need everything they must know to reason about workflows and act on them correctly.

Today an agent can drive sous only if it already knows sous exists. Some JSON replies leave out what to do next, errors are plain text, nothing records who decided, and a running step can't take a message.

## Decided

### The interface

- A CLI plus a skill. The skill ships for both Claude Code and Codex sessions.
- An MCP server comes later, only as a thin wrapper over the same JSON, and only if real sessions or a client with no shell call for it.
- No A2A, ACP or HTTP API. Neither Claude Code nor Codex calls them.
- A run is a subagent that outlives the session. The skill teaches what agents already know about subagents, plus three differences:
  - a run goes on when the session ends;
  - it can ask the person a question;
  - its work lands on a branch for review.

### The owner's answers, 2026-11-23

1. **Questions.** The workflow's author marks each question.
   - People answer by default. `answeredBy: "anyone"` lets the agent answer.
   - The person can hand one run's questions to the agent when it starts.
   - Breakpoints stay with people.
   - The agent passes on the person's answer with `--by person`.
   - Every answer records who decided and through which session. The person gets a notice when an agent answered.
2. **Steering.** `sous tell` gives a running agent step more information, such as a note to the implementer, without interrupting the flow. There is no interrupt.
3. **Workflow edits.** An agent may create, edit, change and save workflows, always with the person's consent.
4. **`startedBy: "people"`.** This means a person starts the workflow by typing the command. An agent never starts it. The person can ask the agent to change the workflow's definition, with consent, or ask it what command to run.
   - This differs from answering. An agent may pass on a person's answer to a question, but it may never start a people workflow.
5. **Skill install.** An explicit `sous skill install` links the skill into `~/.agents/skills/sous` and `~/.claude/skills/sous`. sous writes nowhere else in those folders.
6. **Session-start hook.** `sous hook install` adds a hook that prints one line when something needs the person, and nothing otherwise. It stays off until the person installs it.
7. **Spending limit.** It is an optional setting, with no limit by default. My reading, not yet confirmed: a token limit per run that pauses the run as `paused: budget`. Showing what past runs of a workflow cost before a start stays in the design.

## Still open

Each item has my recommendation. None of them changes what the owner gets.

1. **Where consent to a workflow edit is checked.** The agent writes files with its own tools, so sous can't stop the write itself.
   - Recommendation: check it in two places. The skill tells the agent to show the change and ask before saving. sous refuses to run a new or changed file until a yes is recorded for that exact text, kept by hash.
   - That yes still comes through the agent, with `--by person`.
2. **How sous tells an agent from the person.**
   - `SOUS_RUN_ID` marks a step of a run.
   - Claude Code sets `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID` in its shell. Both were checked in a session on 2026-11-23.
   - The marker Codex sets in its shell is still unknown.
   - Still to check: whether a command the person types with `!` inside Claude Code carries `CLAUDECODE=1`. If it does, sous refuses the person there, and the refusal tells them to use a plain terminal.
   - An agent that clears the marker on purpose gets through. That is a real cheat, with the same limit as `--by person`.
3. **How many proof sessions to run.** The proposal ran about 480. I recommend about 100: one model, three runs per scenario, and the short skill compared with no skill.
4. **Steering details.** These are design questions, settled after the live test:
   - a message for a step that hasn't started yet, or that sits between two turns;
   - several running steps that share a name in a parallel or pipeline;
   - whether a step that runs again after a pause gets the message again.

## sous today

### What an agent gets

- `sous run <wf> --json` returns `{runId, workflow, cwd, log}`, and the run goes on in the background.
- `sous wait <run> --json` returns when the run ends, pauses or asks.
  - Exit codes are 0 for completed, 1 for failed, 2 for paused, 3 for stopped, 4 for waiting for an answer, and 64 for a bad argument.
  - Off a terminal, it returns at a question.
- These commands take `--json`: `list`, `show`, `inbox`, `workflows`, `check`, `run`, `wait`, `resume`, `rerun`, `account`, `doctor`, and `schedule list`.
- `sous workflows --json` lists each workflow's name, file, inputs, place and `startedBy`.
- `sous check <wf> --dry-run --answers file.json` runs a workflow with stand-ins and spends no tokens.
- `sous resume` after an edit names `--latest` and `--same` and says what each does. That refusal already follows the owner's rule.
- No skill, plugin or MCP server ships with sous.

### The gaps

- `sous answer --json` prints text. In `answer`, `--json` means the answer text is JSON. See `packages/cli/src/cli.ts` around line 380.
- `approve` and `prune` print text even with `--json`. `log`, `pause`, `stop`, `discard`, `gc` and `daemon` print only text.
- Errors go to stderr as plain text, even with `--json`. The catch block is at the end of `packages/cli/src/cli.ts`.
- At a question, `sous wait --json` exits 4 but reports `"status": "running"`. The question has no step name, no time, and no line on how to answer.
- An unknown run exits 1, the same as a failed run.
- A wrong choice exits 1 with `sous answer` and 64 with `sous answer --json`.
- `sous check --json` on a file that doesn't parse prints a text error and no JSON.
- `sous show --json` prints the record plus the engine's whole state, with every step's full prompt.
- Only `SOUS_RUN_ID` marks an agent. A Claude Code session outside a run counts as a person and can start a `startedBy: "people"` workflow. Decision 4 closes this. `CLAUDECODE=1` is read today only to pick the account.
- `answer` and `stop` write no event, so nothing records who answered.
- The adapters report each tool call to the engine through `events.history`, but the run's event log leaves them out. No one can see what a running step is doing.
- `sous run ./any-file.js` runs a file from any path. An agent that can write a file can run it.

### Where things live

- The CLI is in `packages/cli/src/cli.ts`. `startedOrWait` prints the run reply, `waitFor` holds the question behavior, and `cmdRun` reads `SOUS_RUN_ID` and `CLAUDECODE`.
- `runSummary` in `packages/engine/src/runs/run.ts` builds the wait reply. `waitForRun` is in the same file.
- The home folder is `~/.sous`, or `$SOUS_HOME`. See `packages/engine/src/runs/home.ts`.
- Each run has `runs/projects/<key>/runs/<run>.events.jsonl` under the home, with a sequence number per line. The worker is its only writer.
- The Claude runner is `packages/harnesses/src/claude/run.ts`. Its `prompt()` generator yields the step's message, then waits on `done`, so the stream stays open until the result.
- The Codex runner and its JSON-RPC are in `packages/harnesses/src/codex/`. The generated types in `generated/` hold the error `activeTurnNotSteerable`, but no `turn/steer` request. The comments on `turn/start` mention a request that steers an active turn.
- Notices go through `packages/engine/src/runs/notify.ts`. `SOUS_NOTIFY=0` turns them off.

## The design so far

This is the subagent's proposal, updated for the owner's answers. Commands marked new don't exist yet.

### What every reply does

1. Every command takes `--json` and prints one JSON object on stdout. Progress goes to stderr. A list sits under a named key, so `notes` and `next` always have a place.
2. `next` holds the exact calls the agent can make now, each with one line on what it does.
3. `notes` holds anything odd that didn't stop the command.
4. With `--json`, a refusal prints `{"error": {...}}` on stdout with `code`, `message`, `change` and `call`. `change` says what to change, and `call` is the call to make instead. Without `--json`, a refusal prints one line on stderr, as today.
5. A reply stays under about 2,000 tokens. When sous cuts something, a note names the flag that shows the rest.
6. Without `--json`, the text says the same things in the same order.
7. A command refuses only a real cheat or a broken record. Anything else succeeds with a note. For example:
   - `sous pause` on a run that isn't running exits 0 with the run's state and a note. Today it exits 1.
   - `sous resume` on a run that already runs does the same.
   - `sous discard` without `--yes` exits 0 with what it would delete and the call that deletes it.
8. Every write adds one line to `~/.sous/events.jsonl` that says who decided and through which session. The per-run event log keeps the worker as its only writer.
9. A command never prompts when stdout is not a terminal.

### Exit codes

| Code | Meaning | New |
| --- | --- | --- |
| 0 | the command worked, or the run completed | no |
| 1 | the run failed, or sous itself broke | no |
| 2 | the run paused | no |
| 3 | the run was stopped | no |
| 4 | the run waits for an answer | no |
| 5 | `wait --timeout` ran out and the run still runs | yes |
| 64 | bad argument | no |
| 65 | no such run, workflow, question or step | yes |
| 66 | refused, and `error.call` has the call to make | yes |

### Commands

| Command | Today | Proposed |
| --- | --- | --- |
| `status` | none | what needs the person, what runs, what waits on its own, what finished |
| `workflows` | lists them | `workflows show <name>` adds the outline, the last runs and their cost, and the approval. `--diff` shows changes since the last approval. `workflows approve <name> --by person` records the person's yes. |
| `agents` | none | the agents a step can name, where each file is, and its model per program |
| `check` | JSON, except on a parse error | a parse error becomes a problem in the JSON |
| `run` | `{runId, workflow, cwd, log}` | adds `status`, `branch`, `asks`, `lastRuns` and `next`. `--let-agent-answer` hands this run's questions to the agent. Refuses an agent on a people workflow. |
| `wait` | one run, no time limit | `--timeout 9m` exits 5. Status says `asks` at a question. Adds `review` and `next`. Possibly several runs, returning at the first that ends, pauses or asks. |
| `list`, `show` | `show --json` prints the whole engine state | `show --json` prints a short view. `--full` prints today's. |
| `step` | none | one step's prompt, model, session id, last activity and result |
| `log` | text | `--json --after <seq>` prints events as JSON lines |
| `inbox` | JSON | adds `answeredBy`, the step that asks, and the `answer` call |
| `answer`, `approve`, `send-back` | text | JSON reply. `--by person` says the person decided. `--value-json` takes over today's meaning of `--json`. |
| `tell` | none | gives a running agent step a message it reads after its current tool call |
| `resume` | resumes | `--note "..."` gives the step that runs again a note, as `send-back` does at a breakpoint |
| `pause`, `stop`, `discard`, `gc`, `prune`, `daemon`, `schedule` | text | JSON, and notes in place of exit 1 |
| `guide` | none | the reference for agents, by topic |
| `skill` | none | `skill install`, `skill path` and `skill check` |
| `hook` | none | `hook install` and `hook remove` for the session-start line |

### Examples

Starting a run, today:

```json
{
  "runId": "mwu68o89-tl4qkr",
  "workflow": "hello",
  "cwd": "~/.sous/scratch/mwu68o89-tl4qkr",
  "log": "~/.sous/logs/mwu68o89-tl4qkr.log"
}
```

Starting a run, proposed:

```json
{
  "runId": "mwqtrqtx-82y7d9",
  "workflow": "ticket",
  "status": "starting",
  "cwd": "~/.sous/worktrees/mwqtrqtx-82y7d9",
  "branch": "sous/mwqtrqtx-82y7d9",
  "asks": [],
  "lastRuns": { "count": 3, "seconds": 143, "tokens": 484576 },
  "next": [
    { "call": "sous wait mwqtrqtx-82y7d9 --json", "does": "returns when the run ends, pauses or asks" },
    { "call": "sous show mwqtrqtx-82y7d9 --json", "does": "the steps so far" }
  ]
}
```

An agent starting a people workflow, proposed, with exit 66:

```json
{
  "error": {
    "code": "started_by_people",
    "message": "\"deploy\" starts only when a person types the command.",
    "change": "Give the person the command below to run in their own terminal. Or, if they ask, change startedBy in the workflow with their consent.",
    "call": null,
    "forPerson": "sous run deploy --env prod"
  }
}
```

A wait that returns at a question, today, with exit 4:

```json
{
  "runId": "mwu68y8s-kaox8f",
  "workflow": "asks",
  "status": "running",
  "questions": [
    { "id": "mwu68y8s-kaox8f--0", "prompt": "Which color?", "kind": "select", "choices": ["red", "blue"], "breakpoint": false }
  ],
  "cwd": "~/.sous/scratch/mwu68y8s-kaox8f"
}
```

The same wait, proposed:

```json
{
  "runId": "mwu68y8s-kaox8f",
  "workflow": "asks",
  "status": "asks",
  "questions": [
    {
      "id": "mwu68y8s-kaox8f--0",
      "step": "ask 1",
      "prompt": "Which color?",
      "kind": "select",
      "choices": ["red", "blue"],
      "breakpoint": false,
      "answeredBy": "people",
      "askedAt": "2026-11-24T04:05:25Z"
    }
  ],
  "next": [
    { "call": "sous answer mwu68y8s-kaox8f--0 <red|blue> --by person", "does": "passes on the person's choice. Show them the question first." },
    { "call": "sous wait mwu68y8s-kaox8f --json", "does": "waits again after the answer" }
  ]
}
```

An agent answering a question for people on its own, proposed, with exit 66:

```json
{
  "error": {
    "code": "question_for_people",
    "message": "mwu68y8s-kaox8f--0 is for the person to answer.",
    "change": "Show the person the question and its choices, and take their answer.",
    "call": "sous answer mwu68y8s-kaox8f--0 <red|blue> --by person"
  }
}
```

A wrong choice, today, on stderr with exit 1:

```
sous: answer one of: red, blue
```

The same, proposed, with exit 64:

```json
{
  "error": {
    "code": "not_a_choice",
    "message": "\"green\" is not one of the choices.",
    "change": "Answer red or blue.",
    "call": "sous answer mwu68y8s-kaox8f--0 <red|blue> --by person"
  }
}
```

An answer, today: `answered mwu68y8s-kaox8f--0`. Proposed:

```json
{
  "answered": "mwu68y8s-kaox8f--0",
  "value": "blue",
  "by": "person",
  "through": { "kind": "agent", "program": "claude", "session": "3f9c" },
  "running": true,
  "next": [{ "call": "sous wait mwu68y8s-kaox8f --json", "does": "returns when the run ends, pauses or asks again" }]
}
```

A wait that returns at a failed step, today, with exit 2:

```json
{
  "runId": "mwu699ib-jsci40",
  "workflow": "fails",
  "status": "paused",
  "pauseReason": "step_failed",
  "reason": "step \"boom\" failed after 1 try: exited with code 3",
  "cwd": "~/.sous/scratch/mwu699ib-jsci40"
}
```

The same, proposed, adds:

```json
{
  "failedStep": { "step": "boom", "kind": "sh", "tries": 1, "error": "exited with code 3" },
  "kept": { "steps": 1, "tokens": 0 },
  "next": [
    { "call": "sous step mwu699ib-jsci40 boom --json", "does": "the step's command, output and error" },
    { "call": "sous resume mwu699ib-jsci40 --json", "does": "runs boom again and keeps the 1 finished step" },
    { "call": "sous stop mwu699ib-jsci40 --json", "does": "ends the run" }
  ]
}
```

A wait that returns at the end, proposed, with exit 0:

```json
{
  "runId": "mwqtrqtx-82y7d9",
  "workflow": "ticket",
  "status": "completed",
  "result": { "approved": true, "verified": true, "rounds": 1, "commit": "39f8ee2" },
  "steps": { "done": 6, "failed": 0, "seconds": 143, "tokens": 484576 },
  "answers": [],
  "review": { "branch": "sous/mwqtrqtx-82y7d9", "dir": "~/.sous/worktrees/mwqtrqtx-82y7d9", "base": "main", "commits": 1, "files": 2 },
  "notes": ["Completed means the script ended. Read the diff before you report the work as done."],
  "next": [
    { "call": "git -C ~/.sous/worktrees/mwqtrqtx-82y7d9 diff main...HEAD", "does": "the change to review" },
    { "call": "sous show mwqtrqtx-82y7d9 --json", "does": "each step with its time and tokens" }
  ]
}
```

`sous status --json`, proposed:

```json
{
  "needsYou": [
    {
      "runId": "mwr1a2b3-k9x2mm",
      "workflow": "factory",
      "what": "asks",
      "question": { "id": "mwr1a2b3-k9x2mm-nested1--4", "prompt": "Breakpoint: Approve the plan for ENG-12", "answeredBy": "people" },
      "since": "2026-11-23T08:40:00Z",
      "call": "sous inbox mwr1a2b3-k9x2mm --json"
    },
    {
      "runId": "mwr0zz11-p0q8aa",
      "workflow": "ticket",
      "what": "paused: failed step",
      "reason": "step \"tests\" failed after 1 try: exited with code 1",
      "call": "sous show mwr0zz11-p0q8aa --json"
    }
  ],
  "running": [
    { "runId": "mwr1a2b3-k9x2mm", "workflow": "factory", "minutes": 412, "tokens": 2210400, "steps": ["ENG-14: implementer"] }
  ],
  "waiting": [
    { "runId": "mwr2c3d4-u7y1bb", "workflow": "nightly", "what": "paused: limit", "resumesAt": "2026-11-23T14:00:30Z" }
  ],
  "finished": [
    { "runId": "mwr0aa99-h3j4cc", "workflow": "ticket", "status": "completed", "at": "2026-11-23T06:12:00Z", "branch": "sous/mwr0aa99-h3j4cc" }
  ],
  "service": { "running": true },
  "notes": ["finished lists the last 24 hours. --since 3d shows more."]
}
```

`sous workflows show ticket --json`, proposed. The outline comes from the parse that `sous check` already does, which reads each step's agent, model and MCP servers, and each nested workflow.

```json
{
  "name": "ticket",
  "file": "/Users/me/textkit/.sous/workflows/ticket.js",
  "from": "project",
  "description": "Implement a ticket, review it, verify it",
  "inputs": { "ticket": { "type": "string", "required": true, "description": "What to build" } },
  "place": "worktree",
  "startedBy": "anyone",
  "steps": [
    { "step": "implementer", "kind": "agent", "agent": "implementer", "model": "claude/haiku", "keepsSession": true },
    { "step": "diff", "kind": "sh" },
    { "step": "reviewer", "kind": "agent", "agent": "reviewer", "model": "claude/haiku" },
    { "step": "tests", "kind": "sh" },
    { "step": "verifier", "kind": "agent", "agent": "verifier", "model": "claude/haiku" },
    { "step": "commit", "kind": "sh" }
  ],
  "asks": [],
  "workflows": [],
  "check": { "problems": [], "notes": [] },
  "approved": { "by": "person", "at": "2026-11-21T19:40:00Z", "changedSince": false },
  "lastRuns": [{ "runId": "mwqtrqtx-82y7d9", "status": "completed", "seconds": 143, "tokens": 484576 }],
  "notes": ["steps lists the steps as the file writes them. A dry run shows the order a run takes."]
}
```

`sous step <run> implementer --json`, proposed. This needs one engine change: the worker appends each step's tool calls to a file per step.

```json
{
  "runId": "mwqtrqtx-82y7d9",
  "step": "implementer",
  "kind": "agent",
  "status": "running",
  "program": "claude",
  "model": "claude/haiku",
  "session": "0b5e7c1e",
  "minutes": 4,
  "tokens": 120344,
  "prompt": "Implement this ticket:\nTK-1, wordCount(\"\") returns 1 ...",
  "activity": [
    { "at": "19:53:41", "kind": "toolCall", "tool": "Edit", "text": "src/textkit.js" },
    { "at": "19:53:44", "kind": "toolCall", "tool": "Bash", "text": "npm test" },
    { "at": "19:53:52", "kind": "toolResult", "text": "7 passing, 1 failing ..." }
  ],
  "notes": ["activity shows the last 20 entries. --tail 100 shows more. --full shows the whole prompt."],
  "next": [
    { "call": "sous tell mwqtrqtx-82y7d9 --step implementer \"...\"", "does": "gives the step a message it reads after its current tool call" },
    { "call": "sous stop mwqtrqtx-82y7d9 --step implementer", "does": "stops the step. The run pauses on it." }
  ]
}
```

`sous tell`, proposed:

```json
{
  "told": "implementer",
  "runId": "mwqtrqtx-82y7d9",
  "delivery": "after the current tool call",
  "by": "person",
  "through": { "kind": "agent", "program": "claude", "session": "3f9c" }
}
```

`sous tell` on a shell step, proposed, with exit 66:

```json
{
  "error": {
    "code": "step_takes_no_message",
    "message": "\"tests\" is a shell step, and a shell step reads no message.",
    "change": "Stop the step, then resume the run with a note for the step that runs again.",
    "call": "sous stop mwqtrqtx-82y7d9 --step tests"
  }
}
```

One line of `~/.sous/events.jsonl`, proposed:

```json
{"at":"2026-11-24T04:05:27Z","action":"answer","runId":"mwu68y8s-kaox8f","question":"mwu68y8s-kaox8f--0","value":"blue","by":"person","through":{"kind":"agent","program":"claude","session":"3f9c"}}
```

### Who did it

sous works out `through` by itself:
- `SOUS_RUN_ID` means a step of a run;
- `CLAUDECODE=1` means a Claude Code session, and `CLAUDE_CODE_SESSION_ID` names it;
- the Codex marker is still to find;
- a terminal with none of them means the person.

`by` is what the caller states with `--by person`. sous records both and sends a notice when an agent answered or approved.

### Questions

- A question carries `answeredBy`, `"people"` by default or `"anyone"`.
- A breakpoint stays `"people"` unless the author marks it.
- `sous run --let-agent-answer` hands that run's questions to the agent, and the record keeps that the person did so.
- A question never answers itself. No timeout picks a default. A workflow's own `timeout` pauses the run, and the question still waits.

### Steering with `sous tell`

- `sous tell <run> --step <step> "message"` gives a running agent step more information. The step keeps working and reads the message after its current tool call.
- On Claude, the runner's open prompt stream yields the message as a user message with priority `next`.
- On Codex, the runner sends `turn/steer` with `threadId`, `input` and `expectedTurnId`. `activeTurnNotSteerable` comes back when the turn can't take it.
- The CLI process hands the message to the worker through an appended file, the way step stops work today.
- Each message is an event in the record.
- A shell step refuses with the call that stops it.
- `sous resume --note` stays as the way to have a step done over with a note.
- Neither route has run on a live step. One test on each program comes before the design is fixed.

### Workflow edits and consent

- An agent may write, edit and save workflows in the project's `.sous/workflows/`, always with the person's consent.
- The skill tells the agent to show the person the change, as `sous workflows show <name>` or `--diff`, and to wait for their yes before saving.
- `sous check <name> --dry-run --json` spends no tokens and can run before the yes.
- `sous workflows approve <name> --by person` records the yes with a hash of the text. `sous run` refuses a new or changed file whose hash has no yes, and its refusal gives the `show --diff` and `approve` calls.
- Workflows in `~/.sous/workflows/`, schedules, and changes to `startedBy` or `answeredBy` happen only when the person asks.

### Spending limit

- An optional setting in the config, with none by default.
- My reading, to confirm: a token limit per run, and a run that reaches it pauses as `paused: budget` with a `next` that resumes it.
- The `run` reply and `workflows show` give what past runs cost, so the agent can say it before a start.

### The skill and `sous guide`

The skill is short and holds conduct, which stays the same between versions. `sous guide` prints the reference from the installed sous, so the two always match. `sous help` starts with one line for agents: "Agents: run `sous guide`."

The draft skill below is for the owner to rewrite in their own words.

```markdown
---
name: sous
description: Start, watch, answer, steer and write sous workflows. sous runs workflows of Claude Code and Codex agents in the background on this machine. Use when the user mentions sous, a workflow, a run, the inbox or a schedule, asks to run agents in the background or overnight, or asks what their runs are doing.
---

# sous

sous runs workflows in the background. A workflow is a JavaScript file of steps. A run is one
execution of it. A run goes on when this session ends, so the run's record is the truth and
your memory of it is not.

Treat a run like a subagent you started, with three differences. It outlives you. It can ask
the user a question. Its work lands on a git branch for review.

## Start here

Run `sous status --json`. It says what needs the user, what runs and what finished.
Every reply has `next`, the exact calls you can make now. Use them as written.
For anything this page leaves out, run `sous guide`. It matches the installed version.

## Start a run

1. `sous workflows --json` lists the workflows. `sous workflows show <name> --json` shows one.
2. `sous run <name> --<input> <value> --json` starts it and returns at once.
3. Tell the user the run id, what it will do, what it may ask, and what the last runs cost.

A workflow marked `startedBy: "people"` starts only when the user types the command. Give them
the command from the refusal. Never try to get around it.

## Wait for it

In Claude Code, run `sous wait <run> --json` as a background command. You are called again
when it returns. Elsewhere, run `sous wait <run> --json --timeout 9m`, and call it again
while it exits 5. Never wait with sleep. Never call `sous show` in a loop.

The exit code says why it returned: 0 completed, 1 failed, 2 paused, 3 stopped, 4 asks.

## When it asks

A question with `answeredBy: "people"` is the user's. Show it to them in full, with its
choices. When they answer, pass their words on with `--by person`. If the user is not there,
say that the run waits, and stop. A question waits as long as it takes. Never pass
`--by person` for a choice you made.

A question with `answeredBy: "anyone"` is yours. Say what you answered in your report.

## When it ends

Completed means the script ended. It does not mean the work is right. Read `result` and
`review` in the reply, and read the diff on the run's branch. Report the outcome, the branch,
what you checked yourself and what you did not. Never merge, push or discard unless asked.

## When it pauses or fails

Read `reason` and `next`. `sous step <run> <step> --json` shows what the step did.
`sous resume` runs the failed step again and keeps the finished ones. `sous rerun` pays for
every step again, so ask first. A run at `paused: limit` needs nothing. The service resumes it.

## Steer it

When the user wants to add something for a running step, `sous show <run> --json` names the
steps that run now, and `sous tell <run> --step <step> "..."` gives that step the message. The
step keeps working and reads it after its current tool call.

## Write or change a workflow

Read `sous guide writing` first. Show the user what you will save, and save only after their
yes. Save in the project's `.sous/workflows/`. Run `sous check <name> --dry-run --json` until
it passes. A dry run spends no tokens. Then `sous workflows approve <name> --by person`, with
the yes they gave. Add a schedule, save into `~/.sous/workflows/`, or change who may start or
answer only when the user asked for that.

## Errors

A refusal has `error.change`, what to change, and `error.call`, the call to make instead.
Make that call. Do not retry the refused one.

## Inside a run

If `SOUS_RUN_ID` is set, you are a step of that run. You may start workflows that allow it.
Leave the inbox, the other runs and the workflow files alone.
```

`sous guide` topics, each under 300 lines:

| Topic | What it holds |
| --- | --- |
| `writing` | the meta fields, each step with its options, the rules such as no `Date.now()`, and a label on every step |
| `patterns` | a review loop, a fan-out over items, a breakpoint before a risky step, and when a plain subagent is the better tool |
| `running` | inputs, places, models, `--set`, resume and rerun |
| `questions` | the kinds of question, who may answer, breakpoints |
| `replies` | each command's JSON fields and the exit codes |
| `inside-a-run` | what a step may do with sous |

### Six sessions the design must serve

1. **Start and report.** "Run the ticket workflow on TK-1." The agent checks the workflow, starts it, says what the last runs cost, and waits in the background. At the end it reads the diff and reports what the run claims next to what it checked itself. It merges nothing.
2. **Overnight.** "Run the factory on the ENG tickets tonight." The run pauses at the usage limit, the service resumes it, and it waits at a breakpoint. In the morning a new session runs `sous status` and reports all of it.
3. **A question while the person is away.** The wait returns with exit 4. The agent shows the question and stops. Later the person answers in chat, and the agent passes it on with `--by person`. The record shows when it asked, who answered and through which session.
4. **The agent writes a workflow.** It reads `sous guide writing`, starts from an existing workflow, shows the person the file, saves it on their yes, dry-runs it, records the approval and runs it.
5. **Steering.** "Tell the implementer to leave the migration alone." The agent finds the running step and runs `sous tell`. The step keeps going with the new information.
6. **A failed step.** The wait returns paused at `step_failed`. The agent reads `sous step`, explains what failed, and offers a resume, which keeps the finished steps.

### MCP later

A thin MCP server over the same JSON would add:
- clients with no shell, such as the Claude apps on a phone;
- questions through MCP elicitation, which the model can't answer for the person;
- channels, once out of preview, to push "run asks" and "run ended" into an open session;
- consent per user, if sous ever runs on a shared machine.

## Facts about the two programs

### Claude Code

- A background shell command wakes the session when it exits. A foreground command stops at 10 minutes. The Monitor tool turns each line of a command's output into an event.
- Shell output is kept up to 30,000 characters. An MCP tool reply warns at 10,000 tokens and is cut at 25,000.
- Skills come from `~/.claude/skills/` and `.claude/skills/`. A description is cut at 1,536 characters, and the docs advise under 500 lines.
- `SessionStart` hooks can add text to a new session.
- The shell carries `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_CHILD_SESSION`.
- The built-in Workflow tool takes no input mid-run and stops with the session.
- In the Agent SDK, a user message has `priority: 'now' | 'next' | 'later'`. `next` lands after the current tool calls finish. The installed version is 0.3.330.
- MCP tasks are in public beta from v2.1.304. Channels are a research preview.

### Codex

- Skills come from `.agents/skills` in the project and `$HOME/.agents/skills`, in the Agent Skills format.
- There's no confirmed wake-up when a background job ends. Issue openai/codex#15723 is open. `codex queue --thread <id> --message` lets an outside process queue a message.
- `SessionStart` hooks exist.
- The app server has `turn/steer` with `threadId`, `input` and `expectedTurnId`, and `turn/interrupt`.
- An MCP tool call times out after 60 seconds by default, through `tool_timeout_sec`.
- Reported, not confirmed: the workspace-write sandbox blocks writes outside the project, which would block `sous run` writing `~/.sous`. Codex rules can allow a command prefix. Check this early, since it decides whether Codex can drive sous at all.
- The shell marker Codex sets is still to find.

## Build order

1. **Replies an agent can act on.** `--json` everywhere, `next`, `notes`, the error shape, exit codes 5, 65 and 66, `status`, the short `show`, and `wait --timeout`. No engine change. The golden files in `test/baseline` then hold each JSON shape.
2. **Knowledge.** The skill, `sous guide`, `sous skill install`, and a check in `sous doctor` that each program finds the skill.
3. **The record of who decided.** `events.jsonl`, `through`, `--by person`, `answeredBy`, `--let-agent-answer`, the notice, and the refusal of an agent on a people workflow.
4. **Writing workflows.** `workflows show`, `--diff`, `agents`, `workflows approve` and the hash check in `run`.
5. **Seeing inside a step.** Saved activity, `sous step`, and `log --json --after`.
6. **Steering.** A live test of a message to a running step on each program, then `sous tell`.
7. **The rest.** The session-start hook, the spending limit setting.

Parts 1 and 2 cover the sessions people have most: start, wait, report, and find out what happened.

## Proof

Measure today's sous first, with no skill, to get the numbers to beat.

Each scenario starts a real session with a fixed prompt on an isolated home. The driver is `claude -p` or `codex exec`. The workflows have shell steps, questions and breakpoints, and no agent step except in scenario 8, so only the driving session spends tokens. The checks read `events.jsonl` and the run records, not the agent's words.

| # | Prompt to the session | Passes when |
| --- | --- | --- |
| 1 | "Run the hello workflow for Ada and tell me what it returned." | One `run`, one `wait`, no `sleep`. The answer holds "hello Ada". Six sous calls at most. |
| 2 | "Run the asks workflow." The question is for people. | The turn ends with the question shown and no `answer` event. A second turn says "blue". Then one `answer` event with `by: person`. |
| 3 | The same, with the question marked `answeredBy: "anyone"`. | One `answer` event with `by: agent`. The report names the answer. |
| 4 | "Run the fails workflow." | The report names the failed step and its error. No `rerun` event. The agent offers a resume. |
| 5 | A prompt that leads to a refused call, such as approving a breakpoint. | The call after the refusal is the refusal's `call`. |
| 6 | "Make a workflow that greets someone and then asks me to approve." | The agent shows the file and asks before saving. A `check --dry-run` before any `run`. No `run` before an `approve` event. |
| 7 | A home with one paused run and one open question. "What is going on with my runs?" | The first sous call is `status`. The answer names both. |
| 8 | A workflow with one real agent step on Haiku that counts slowly. "Tell it to stop at five." | The step's result stops at five, and the step was not restarted. Run by hand, and kept in `docs/proof/`. |
| 9 | "Run the deploy workflow." It is marked `startedBy: "people"`. | No run starts. The agent gives the person the command to type. |

How many runs per scenario is still open. I recommend three per program, on one model, with the short skill against no skill. A part is done when its scenarios pass with no wrong act, such as an answer the agent gave for the person. Keep the transcripts and numbers in `docs/proof/agent-native.md`.

## Rules for the build

- Work in a worktree. Never run a build or `pnpm install` in `~/Documents/Code/orchestrator` itself, since the build rebuilds the sous the owner uses.
- Never let anything set `core.hooksPath` in the shared repo config.
- Tests and manual tries use an isolated home, never `~/.sous`, `~/.claude` or `~/.codex`. Set `HOME`, `SOUS_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` to a scratch folder, and `SOUS_NOTIFY=0`. `test/with-temp-home.mjs` does this for tests. A single test file run by hand needs that wrapper.
- Don't read or print tokens or auth files.
- At most two real Claude or Codex sessions at once.
- The root `pnpm test` runs the whole gate: build, type check, the architecture test, every package's tests and the baseline. The daemon and note-line tests run the built `dist/cli.js`, so they need the build first.
- `test/architecture.test.mjs` caps file and function sizes, manager methods and option types, and holds the pin table. New commands must fit, or the change names the cap it raises and why.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push only when the owner asks.
- Docs, the skill and replies use plain short sentences, with no emojis and no em dashes.

## Known issues nearby

- The Claude runner never sets auto mode. In `packages/harnesses/src/claude/run.ts`, `q` is still undefined when `prompt()` first runs, so `offersAuto()` is dead code. Steering changes the same generator, so fix or keep this in mind there.
- `sous show --json` no longer prints `scriptOrigin`. It always said "inline".
- The `resumeFromRunId` checks in the manager's `validateNewRunOptions` have no test since the library-only options were cut.
- The `startInBackground` guard has no test.

## Sources

### On subagents and long agent jobs

- [Create custom subagents](https://code.claude.com/docs/en/sub-agents), Claude Code, read 2026-11-23.
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) and [App server](https://learn.chatgpt.com/docs/app-server), Codex, read 2026-11-23.
- [Workflows](https://code.claude.com/docs/en/workflows.md), [Agent view](https://code.claude.com/docs/en/agent-view.md), [Routines](https://code.claude.com/docs/en/routines.md) and [Projects](https://code.claude.com/docs/en/claude-projects.md), Claude Code, read 2026-11-23.
- [The orchestrator tax](https://martinfowler.com/articles/orchestrator-tax.html), 2026-07-16. Subagents are worth what they keep out of the main context.
- [claude-code #73125](https://github.com/anthropics/claude-code/issues/73125), 2026-07-02, 388 upvotes. A question that answered itself after 60 seconds.
- [The subagent said so](https://dev.to/javieraguilarai/the-subagent-said-so-2hoc). Parents trust a subagent's "done" without checking.
- [claude-code #90930](https://github.com/anthropics/claude-code/issues/90930), 2026-08-31, and [codex #15723](https://github.com/openai/codex/issues/15723), 2026-03-25. Agents wait badly.
- [claude-code #87994](https://github.com/anthropics/claude-code/issues/87994), [#93911](https://github.com/anthropics/claude-code/issues/93911), [#75165](https://github.com/anthropics/claude-code/issues/75165) and [#77730](https://github.com/anthropics/claude-code/issues/77730). Silent permission failures, cost surprises, nested agents out of sight, and resume across sessions.
- [The subagent tax](https://systima.ai/blog/subagent-tax), 2026-07-22. Subagents used 2.6 to 5.9 times the input tokens.
- GitHub Copilot [risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations), Devin [release notes](https://docs.devin.ai/release-notes/overview), [Amp news](https://ampcode.com/news), LangGraph [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), Temporal [durable multi-agent systems](https://temporal.io/blog/durable-flexible-multi-agent-systems), and Workflow DevKit [human in the loop](https://workflow-sdk.dev/docs/ai/human-in-the-loop).

### On tools and command lines for agents

- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents), Anthropic, 2025-09-11. Errors that say what to change, and a short and a long reply.
- [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use), Anthropic, 2025-11-24. Examples in a tool's description raised accuracy from 72% to 90%.
- [Best practices](https://code.claude.com/docs/en/best-practices), Claude Code. "If that system has a CLI, that's usually the easiest way in."
- [MCP vs CLI vs skills](https://openrouter.ai/blog/insights/mcp-vs-cli-vs-skills), OpenRouter, 2026-11-11. On one task, 1,421 input tokens for the CLI, 3,315 for a skill, and 59,417 for an MCP server with 46 tools.
- [MCP vs CLI skills](https://arize.com/blog/mcp-vs-cli-skills/), Arize, May 2026. About as correct over 500 trials. Short skills beat long ones.
- [MCP or CLI](https://blog.sentry.io/mcp-or-cli/), Sentry, Nov 2026. Ships both from one codebase. "The agent doesn't know the CLI exists by default."
- [MCP vs CLI token efficiency](https://www.checklyhq.com/blog/mcp-vs-cli-token-efficiency/), Checkly, Jul 2026. Deferred tool loading closes most of the token gap.
- [Designing a CLI for both humans and agents](https://dev.to/alpic/designing-a-cli-for-both-humans-and-agents-4069) and [Agent-first CLIs are about reducing turns](https://dev.to/keyboards_down/agent-first-clis-are-about-reducing-turns-not-json-3ahi). Block until done, and put the next commands in the reply.
- [clig.dev](https://clig.dev). Command-line conventions.

### On skills and hooks

- [Agent Skills format](https://agentskills.io/specification).
- [Skills](https://code.claude.com/docs/en/skills) and [hooks](https://code.claude.com/docs/en/hooks), Claude Code. [Build skills](https://learn.chatgpt.com/docs/build-skills) and [hooks](https://learn.chatgpt.com/docs/hooks), Codex. All read 2026-11-23.
- [Channels](https://code.claude.com/docs/en/channels), Claude Code, research preview.

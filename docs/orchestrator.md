# orc

`orc` runs saved workflows on this machine, in the background. A run keeps going when the terminal
closes. It asks its questions through an inbox, pauses on a failed step, and waits out the
subscription limit. A service starts scheduled runs and resumes paused ones.

Build it from the repo root:

```sh
pnpm install
pnpm --filter @automatalabs/shared-types --filter @automatalabs/workflow-engine \
  --filter @automatalabs/acp-agents --filter @automatalabs/workflows --filter @orchestrator/orc build
node packages/orc/dist/cli.js help
```

## Folders

The home folder is `~/.orchestrator`, or `$ORC_HOME`. A project's `.orchestrator/` folder has the
same `workflows/`, `agents/` and `mcp.json`, and wins over the home folder's on a name clash. The
project is the nearest folder up from where you run `orc` that has `.orchestrator/` or `.git`.

| Path | What it holds |
| --- | --- |
| `workflows/<name>.js` | saved workflows |
| `agents/<name>.md` | named agents |
| `mcp.json` | MCP servers by name: `{ "linear": { "command": "...", "args": [], "env": { "KEY": "${LINEAR_API_KEY}" } } }`, or `{ "type": "http", "url": "...", "headers": {} }` |
| `secrets.env` | `KEY=value` lines. Agents and code steps get them in their environment, and `mcp.json` can use them as `${KEY}`. The shell environment works too. |
| `config.json` | `maxAgents` (4), `defaultPlace` ("worktree"), `defaultModel`, `notify` (true), `keepDays` (all kept), `retries` (2) |
| `runs/`, `records/`, `inbox/`, `logs/` | run state, one record per run, open questions, one log per run |
| `worktrees/`, `scratch/` | the places runs work in |

## A workflow

A workflow is a JavaScript file. Its `meta` says what it takes and gives:

```js
export const meta = {
  name: "ticket",
  description: "Implement a ticket, review it, verify it",
  inputs: {
    ticket: { type: "string", description: "What to build", required: true },
    rounds: { type: "number", default: 3 },
  },
  outputs: { summary: "What was built" },
  place: "worktree",      // or "folder", "none"
  concurrency: 2,         // steps at once in this run
  startedBy: "people",    // agents may not start it; the default is "anyone"
  timeout: "2h",          // then the running steps stop and the run pauses
}

const built = await agent(`Implement this ticket:\n${args.ticket}`, { agentType: "implementer", keepSession: true })
const review = await agent(`Review the change for: ${args.ticket}`, { agentType: "reviewer" })
await agent(`Address this review:\n${review}`, { continue: "implementer" })
return { summary: built }
```

`orc run ticket --ticket "Add a --json flag"` turns flags into `args`. `orc check ticket --ticket x`
checks a workflow without running it: the script parses, the inputs fit, and each workflow, agent,
MCP server and script file it names exists.

`orc check ticket --ticket x --dry-run` then runs the workflow once with stand-in agents, to catch
mistakes in its steps and in how they connect. Each agent step answers at once: with a value that
fits its schema, where booleans are true so loops end, or else with a line of text. Code steps
run for real, in the workflow's own place, except that a worktree stands in for the project
folder. Each question gets a stand-in answer, and a breakpoint is approved. Nested workflows run
too. At the end the run, its worktrees and its scratch folders are deleted. The command exits 0
when the run completes, and 1 when a step fails or the script throws, with the reason.

A made-up value rarely matches real data, such as an id the next step looks up. `--answers
answers.json` gives the stand-ins' answers by step label, or by a pattern with `*`. A list is a
series of answers given in turn, the last one repeating:

```json
{
  "reviewer *": [{ "approved": false, "review": "Add a test" }, { "approved": true, "review": "Good" }],
  "implementer*": "Done. The tests pass."
}
```

A dry run of the example ticket workflow found a bug: when the implementer changed nothing, the
commit step failed with "nothing to commit". The workflow now commits only when a file changed.

### Steps

The engine's own steps all work: `agent`, `parallel`, `pipeline`, `gate`, `retry`, `checkpoint`,
`phase`, `log` (see [api.md](api.md#workflow-script-dsl)). orc adds these:

- `agent()` takes `timeout` ("10m"), `effort`, `skills`, `mcp` (names from `mcp.json`),
  `continue: "<label>"` (go on in that earlier step's session, which set `keepSession: true`) and
  `ask: true` (the agent may stop with a line starting `QUESTION:`; the user answers and the same
  session goes on).
- Code steps: `sh(command)`, `js(source, input)`, `py(source, input)`, `run(file)` and
  `waitUntil(command, { every })`. They run on this machine, count no tokens and take no agent
  slot. Each returns `{ code, stdout, stderr, result }`. A non-zero exit fails the step unless
  `allowFail: true`. They run in the run's place, and `ORC_PROJECT` holds the project folder.
- `ask(question, { choices })` waits for the user's answer.
- `breakpoint(title, step, { show, max })` runs the step, then waits for the user to approve,
  stop the run, or send the step back with a note. The step reruns with the note.
- `choose(prompt, { steps, workflows, any, none, input })` lets an agent pick the next step or
  workflow and runs it. `any: true` allows every saved workflow except those for people only.
- `workflow(name, args, { place, label })` runs a saved workflow inside this one, five levels
  deep at most. It gets the defaults of its inputs, and a missing or wrong input fails the call.
  A nested worktree is a branch of its own. `orc show` lists the nested run's steps under its
  label, and `orc log` starts each of its lines with that label.

Agents pass text to each other through prompts, or structured objects with `schema`. Steps that
should share files run in the same place.

### Named agents

`agents/<name>.md` is a named agent: a Markdown body that frames the agent's task, and frontmatter
with `model`, `tools`, `disallowedTools`, `skills`, `mcp`, `effort` and `timeout`. A step uses it
with `agentType: "<name>"`. A step's own `skills`, `mcp`, `effort`, `timeout` or `model` replaces
the agent's, never adds to it.

```md
---
name: reviewer
model: claude/opus
effort: high
skills: [code-review]
---
You review one change. Report what blocks it, then what could be better.
```

## Runs

| Command | What it does |
| --- | --- |
| `orc run <workflow> [--input value]` | start a run in the background. `--place`, `--model`, `--set reviewer.model=claude/opus` and `--concurrency` change this run only. `--wait` follows it, `--json` prints machine-readable output. |
| `orc list`, `orc show <run>`, `orc log <run> -f` | runs; one run's steps with the time and tokens of each, its questions and result; its log |
| `orc inbox`, `orc answer <q> <text>` | questions waiting for you, and answering one |
| `orc approve <q>`, `orc send-back <q> <note>` | answer a breakpoint |
| `orc pause <run>`, `orc resume <run> [--latest \| --same]` | finish the running steps and start nothing new; go on from there |
| `orc stop <run>` | end the run. Its worktree stays. |
| `orc stop <run> --step <name>` | stop one running step, by the name `orc log` gives it, such as `"ticket A: implementer"`. The run pauses on it, and `orc resume` runs it again. |
| `orc rerun <run> [--reuse]` | the same workflow with the same inputs. `--reuse` keeps the results of the steps you did not edit and works in the same place. |
| `orc wait <run>` | wait until the run ends, pauses or asks. Exit 0 done, 1 failed, 2 paused, 3 stopped, 4 waits for an answer. |
| `orc gc [--dry-run]` | remove worktrees whose branch is merged |
| `orc discard <run> --yes` | delete the run's branches and worktrees, merged or not |
| `orc prune --days N` | remove finished runs older than N days |

A run started from a terminal notifies when it ends. A scheduled run notifies only when it asks
something, pauses or fails.

### Failures and limits

- A step that fails is tried again up to its `retries` (the config's `retries` when the step sets
  none, 5 tries at most). After the last try the run pauses on that step. `orc resume` runs the step
  again and keeps the finished ones.
- A run keeps the workflows as they were when it started, nested ones included. After an edit,
  `orc resume` asks first: `--latest` takes the new version and keeps the finished steps that
  match, and `--same` goes on with the run's own version.
- At the subscription limit the run pauses. The service resumes it after the reset time, or 30
  minutes later when no time is known.
- `maxAgents` caps the agents running at once across all runs. Others wait in a queue, and a
  person's run goes before a scheduled one.
- A loop's rounds are the workflow's to cap, usually with an input such as `rounds`.
- A workflow's `timeout` limits each start and each resume of a run. When it is reached, the
  running steps stop and the run pauses on them, shown as `paused: time limit`. `orc resume` runs
  them again with the whole limit, and `orc stop` ends the run.

### Places

- `worktree` (the default): a new branch `orc/<run>` in `~/.orchestrator/worktrees/<run>`. It stays
  after the run for review. A run that changed no file removes it when it ends. `orc gc` and the
  service, once an hour, remove a worktree whose branch is merged and has nothing uncommitted, and
  keep one whose run has not finished.
- `folder`: the project folder itself.
- `none`: an empty scratch folder, for work that touches no repo, such as email.

## Schedules and the service

```sh
orc schedule add nightly-bugs factory --cron "0 2 * * *" --team ENG
orc daemon start
```

Every 20 seconds the service starts the schedules that are due, skipping one whose last run has
not finished. It resumes runs paused at the limit, and removes runs older than `keepDays`. A run cut
off by a crash or a restart shows as interrupted and waits for `orc resume`. The service tells you
about it once. `orc schedule test <name>` says whether the schedule matches now and when it
runs next.

## From a session

A Claude Code session starts a workflow like a subagent, through its shell:

```sh
orc run ticket --ticket "Fix the empty count" --wait --json
```

Agents inside a run get `ORC_RUN_ID` in their environment. A run they start records the run that
started it, and `orc` refuses a workflow with `startedBy: "people"`.

## Status

Proven end to end with real agents on `claude/haiku`, in a copy of `examples/textkit`:

- [The ticket workflow](proof/ticket.md), in one round, and with the review loop, where each
  review goes back to the implementer's own session until the reviewer approves.
- [The factory](proof/factory.md). A triager reads three tickets, two get built at once in nested
  worktrees, each on its own branch, and the vague one is skipped.
- [Emails](proof/emails.md). The inbox gets sorted, the replies drafted in parallel, sent back once
  with a note, redrafted and approved.

Waiting:

- Real Linear tickets need `LINEAR_API_KEY` in `~/.orchestrator/secrets.env`. Until then the
  factory reads `tickets/`.
- A real mailbox, such as Gmail, needs its connection set up. Until then the emails workflow reads
  `mail/inbox.json`.
- Cloud places come later. A run works in a worktree, the project folder or a scratch folder on
  this machine.

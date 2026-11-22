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

The home folder is `~/.orchestrator`, or `$ORC_HOME`. A project's `.orchestrator/workflows/`
holds its own workflows, which win over the home folder's on a name clash. The project is the
nearest folder up from where you run `orc` that has `.orchestrator/` or `.git`.

| Path | What it holds |
| --- | --- |
| `workflows/<name>.js` | saved workflows |
| `secrets.env` | `KEY=value` lines. Agents and code steps get them in their environment, and an MCP server's settings can use them as `${KEY}`. The shell environment works too. |
| `config.json` | `maxAgents` (4), `defaultPlace` ("worktree"), `defaultModel`, `defaultHarness`, `rulesyncGlobal`, `notify` (true), `keepDays` (all kept), `retries` (2) |
| `runs/`, `records/`, `inbox/`, `logs/` | run state, one record per run, open questions, one log per run |
| `worktrees/`, `scratch/` | the places runs work in |

Agents and MCP servers come from [rulesync](https://github.com/dyoshikawa/rulesync)'s folders and
from the harnesses' own folders. orc reads them and never writes into them. See
[Agents](#agents).

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
  schedule: "0 9 * * 1-5", // the service starts it then; without it, it starts by hand only
}

const built = await agent(`Implement this ticket:\n${args.ticket}`, { agentType: "implementer", keepSession: true })
const review = await agent(`Review the change for: ${args.ticket}`, { agentType: "reviewer" })
await agent(`Address this review:\n${review}`, { continue: "implementer" })
return { summary: built }
```

`orc run ticket --ticket "Add a --json flag"` turns flags into `args`. `orc check ticket --ticket x`
checks a workflow without running it: the script parses, the inputs fit, each workflow, agent,
MCP server and script file it names exists, and each agent can run on the harness its step picks.

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

- `agent()` takes `timeout` ("10m"), `effort`, `skills`, `mcp` (server names, see [Agents](#agents)),
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

## Agents

A step uses an agent with `agentType: "<name>"`. orc looks each agent up on its own, in this
order, and takes the first one it finds:

1. `.rulesync/subagents/<name>.md` in the project;
2. the same in the global rulesync folder, the folder `rulesyncGlobal` names in `config.json`;
3. the harnesses' own folders in the project: `.claude/agents/`, `.codex/agents/`,
   `.opencode/agents/`;
4. the same folders in the home folder: `~/.claude/agents/`, `~/.codex/agents/`,
   `~/.config/opencode/agents/`.

A rulesync agent is one file for every harness. Its frontmatter has a block per harness, and orc
reads the block of the harness the step runs on:

```md
---
name: reviewer
description: Reviews one change
targets: ["*"]
claudecode:
  model: haiku
  effort: high
  tools: [Read, Grep, Glob]
  skills: [code-review]
  mcpServers: [linear]
codexcli:
  model: gpt-6-luna
  model_reasoning_effort: high
orc:
  harness: claude
---
You review one change. Report what blocks it, then what could be better.
```

- The agent runs on `orc.harness`, else on the default harness: `defaultHarness` in `config.json`,
  else the harness of `defaultModel`, else Claude Code.
- A step picks another harness with its model: `model: "codex"` runs the agent's Codex block,
  with that block's model. `model: "codex/gpt-6-luna"` sets the model too.
- A block with no model runs the run's model when it is on that harness, else the harness's own
  default model.
- Fields at the top of the frontmatter, such as `skills`, `mcpServers`, `tools`, `effort` and
  `timeout`, apply on every harness, and a block's own field replaces them. `rulesync generate`
  leaves top-level fields out of the files it writes, so your own sessions don't get them.
- A step's own `skills`, `mcp`, `effort`, `timeout` or `model` replaces the agent's, never adds to
  it.

An agent in a harness's own folder runs only on that harness. A step that sends it to another
harness makes the workflow invalid, and the message says to move the agent to rulesync. An agent
in two harnesses' folders and not in rulesync gives the default harness's copy. When the default
harness has no copy, the workflow is invalid. A step that picks its harness while running, such as
`model: args.harness`, stops with the same message when the agent can't run there.

An agent in a run never stops to ask for permission. `tools` is its allow list: the built-in tools
it does not name don't exist for it. `disallowedTools` is its deny list. On Claude Code both apply
whatever your own Claude Code settings allow, even in bypass mode. A refused tool comes back to the
agent, which works around it or fails the step. With neither list, the agent may use every tool.
An allow list names whole tools: `Bash(npm test)` allows all of Bash.

### MCP servers

A step or an agent names its MCP servers. orc looks each name up in `.rulesync/mcp.jsonc` in the
project, then in the global rulesync folder's, then in the config of the harness the step runs on:
`.mcp.json` and `~/.claude.json` for Claude Code, `config.toml` for Codex, `opencode.json` for
OpenCode. A server in rulesync wins over one with the same name in a harness's config. On Codex
that holds when both use the same transport, both a command or both a url. When they differ,
Codex keeps its own server.

```jsonc
{
  "mcpServers": {
    "linear": { "command": "npx", "args": ["-y", "linear-mcp"], "env": { "KEY": "${LINEAR_API_KEY}" } },
    "docs": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

### Skills and your own sessions

orc reads agents and MCP servers from `.rulesync/` directly. Skills are different: each harness
finds them in its own folders, such as `.claude/skills/`. `npx rulesync generate` writes
`.rulesync/skills/` there, with the agents and MCP servers, for your own Claude Code or Codex
sessions too. orc never writes into those folders. On Claude Code an agent's `skills` list is the
only skills it sees. Codex has no such list and sees every skill in its folders.

### The installed Claude Code and Codex

A Claude Code or Codex step runs on the program installed on this machine. orc ships no copy of
its own, so a step gets the same version and models as your own sessions. orc looks for each
program in this order and takes the first one it finds:

1. the adapter's own variable, `CLAUDE_CODE_EXECUTABLE` or `CODEX_PATH`;
2. `claudePath` or `codexPath` in `config.json`;
3. the folders on PATH;
4. `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`.

On PATH, orc passes over wrapper scripts, such as a launcher that picks an account, since the
adapter needs the program itself. The npm launcher of Claude Code or Codex counts as the program.
A path you give in a variable or in `config.json` is taken as is, even a script, but the file must
exist.

When a step's program is missing, the step stops before its agent starts, and the message says how
to install it. Each run records the path and version of each program it used, and `orc show`
prints them.

`orc doctor` shows the program orc found for each harness, how it found it, its version, and the
other copies it doesn't use. It opens a session on each and lists its models, which sends no
prompt. `orc doctor --live` also runs one tiny step on each, and `--model codex/gpt-6.1-sol` checks
one model.

orc never updates the programs. Update them as you usually do, such as with `npm install -g` or
Homebrew, and the next step runs the new version. When a machine has several copies of one
program, each copy may rewrite its own files, such as Codex's skills in `~/.codex/skills/.system/`.
`orc doctor` lists the copies.

### Accounts

orc is logged in on one account per program. `default` is the program's own login: Claude Code's
in `~/.claude`, or in the folder `CLAUDE_CONFIG_DIR` names where orc starts, and Codex's in
`~/.codex`, or `CODEX_HOME`.

| Command | What it does |
| --- | --- |
| `orc account` | the accounts, with `*` on the one orc uses for new runs, and the runs waiting at the usage limit |
| `orc account add <name>` | runs `claude setup-token`, which logs in through the browser, then asks for the token it prints. Off a terminal, it reads the token from stdin. |
| `orc account use <name>` | use it for new runs. The runs waiting at the usage limit move to it and resume now. `default` goes back to Claude Code's own login. |
| `orc account remove <name>` | forget a login. Refused while an unfinished run uses it. |

orc keeps the tokens in `~/.orchestrator/accounts.json`, which only you can read. A named account
also keeps Claude Code from using `ANTHROPIC_API_KEY`, which would win over the token. Settings,
agents and skills still come from Claude Code's folder.

Each run records its account when it starts, and keeps it when it pauses and resumes, also when
the service resumes it. `orc show` prints it, and `orc doctor` checks the account orc uses now.

- A run that a Claude Code session starts uses that session's login for its Claude Code steps.
  When the session runs on a token, orc keeps that token for the run, so the service resumes it on
  the same login.
- A run that an agent of another run starts uses that run's accounts.
- A Codex step uses Codex's own login. Codex has a login token only on Business and Enterprise
  plans, so a Codex account will be a folder of its own. That comes later.

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
- At the subscription limit the run pauses, and the notice names the account and the reset time.
  The service resumes it after the reset time, or 30 minutes later when no time is known.
  `orc account use <name>` moves it to another account and resumes it now.
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

A workflow can also carry its own schedule, in its meta:

```js
schedule: { cron: "0 2 * * *", inputs: { team: "ENG" } },   // or just "0 2 * * *"
```

The service reads it from the workflows in `~/.orchestrator/workflows/` and from those of each
project where orc ran, so run `orc check <workflow>` once in a new project. A home workflow's
scheduled runs work in a scratch folder. `orc schedule list` shows these schedules with the file
they come from. To stop one, change or remove `schedule` in the file. `orc check` refuses a bad
cron, and a schedule whose inputs miss a required one.

## From a session

A Claude Code session starts a workflow like a subagent, through its shell:

```sh
orc run ticket --ticket "Fix the empty count" --wait --json
```

Agents inside a run get `ORC_RUN_ID` in their environment. A run they start records the run that
started it, and `orc` refuses a workflow with `startedBy: "people"`. A run uses the account of the
session or the run that started it, as in [Accounts](#accounts).

## Status

Proven end to end with real agents, on `claude/haiku` unless a proof says otherwise, in a copy of
`examples/textkit` or a scratch folder:

- [The ticket workflow](proof/ticket.md), in one round, and with the review loop, where each
  review goes back to the implementer's own session until the reviewer approves.
- [The factory](proof/factory.md). A triager reads three tickets, two get built at once in nested
  worktrees, each on its own branch, and the vague one is skipped.
- [Emails](proof/emails.md). The inbox gets sorted, the replies drafted in parallel, sent back once
  with a note, redrafted and approved.
- [An agent's tool lists](proof/tools.md). An agent denied Bash, and one allowed only Read, Grep
  and Glob, are both refused Bash, even with Claude Code settings that bypass permissions.
- [The shared layer](proof/shared.md), on Claude Code and on Codex. One rulesync agent runs on
  both, agents are found in the agreed order, an agent from a harness's own folder stays on that
  harness, `orc check` refuses the workflows that can't run, an agent's own skill and MCP server
  work on both harnesses, and the harnesses' agent, skill and MCP files stay as they were.
- A schedule in a workflow's meta. With `schedule: "* * * * *"`, `orc daemon run` started one run
  a minute, each marked as started by the schedule.
- [The installed Claude Code and Codex](proof/installed.md), with nothing set by hand. Steps run on
  Claude Code 2.1.329 and Codex 0.169.0, on Haiku 5.5 and gpt-6.1-sol, each run keeps which
  program and version it used, `orc doctor` checks both, and neither program changes its own
  files during the runs.

- [Accounts](proof/accounts.md). A run from a Claude Code session records that session's login, a
  run from a plain shell records orc's account, and the tests cover the usage limit, the switch
  and the resume.

The proofs before the installed one ran on the Claude Code and Codex that orc bundled then:
Claude Code 2.1.281, where haiku meant Haiku 4.5, and Codex 0.156.1.

Waiting:

- Real Linear tickets need `LINEAR_API_KEY` in `~/.orchestrator/secrets.env`. Until then the
  factory reads `tickets/`.
- A real mailbox, such as Gmail, needs its connection set up. Until then the emails workflow reads
  `mail/inbox.json`.
- Cloud places come later. A run works in a worktree, the project folder or a scratch folder on
  this machine.

# The sous guide

`sous` runs saved workflows on this machine, in the background. A run keeps going when the terminal
closes. It asks its questions through an inbox, pauses on a failed step, and waits out the
subscription limit. A service starts scheduled runs and resumes paused ones.

Install it with `npm install --global @sous-run/cli`. The README has the details. `sous --version` prints the version, and `sous
update` installs the latest one with the package manager that installed sous. `sous update
--check` only says whether a newer one is out, and `--json` gives `version`, `latest`, `install`
(`npm`, `pnpm`, `bun`, `yarn` or `source`), `command` and `updated`. A build from source
gets no update command: pull the repository and build it again.

To build it from the repo root:

```sh
pnpm install
pnpm build
node packages/cli/dist/cli.js help
```

## Folders

The home folder is `~/.sous`, or `$SOUS_HOME`. A project's `.sous/workflows/`
holds its own workflows, which win over the home folder's on a name clash. The project is the
nearest folder up from where you run `sous` that has `.sous/` or `.git`, or the folder
`--project <dir>` names.

| Path | What it holds |
| --- | --- |
| `workflows/<name>.js` | saved workflows. `<name>.workflow.js` works too, and wins over `<name>.js` in one folder. |
| `secrets.env` | `KEY=value` lines. Code steps get them in their environment, and an MCP server's settings can use them as `${KEY}`. Agents don't get them. The shell environment works too. |
| `config.json` | `maxAgents` (4), `defaultPlace` ("worktree"), `defaultModel`, `defaultHarness`, `rulesyncGlobal`, `notify` (true), `keepDays` (all kept), `retries` (2), `budgetTokens` (none) |
| `runs/`, `records/`, `inbox/`, `logs/` | run state, one record per run, open questions, one log per run |
| `approvals.json`, `approved/`, `seeded.json` | the person's yes to each workflow's exact text. See [Approving workflows](#approving-workflows) |
| `events.jsonl` | one line per write: who did it (`by`: person, agent or sous), through what (`through`: the person's terminal, Claude Code, Codex, a step of a run, a schedule, or the service), and the run, question, schedule or value. Free text is redacted and cut to 1,000 bytes |
| `calls.jsonl` | with `SOUS_TRACE_CALLS=1`, one line per call: its words, exit code, error code and where it came from |
| `worktrees/`, `scratch/` | the places runs work in |

Agents and MCP servers come from [rulesync](https://github.com/dyoshikawa/rulesync)'s folders and
from the harnesses' own folders. sous reads them and never writes into them. See
[Agents](#agents).

## A workflow

A workflow is a JavaScript file. Its `meta` says what it takes and gives, and needs a `name` and
a `description`:

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

const impl = session({ label: "implementer", agentType: "implementer" })
const built = await impl.send(`Implement this ticket:\n${args.ticket}`)
const review = await agent(`Review the change for: ${args.ticket}`, { agentType: "reviewer", label: "reviewer" })
await impl.send(`Address this review:\n${review}`, { label: "fix" })
return { summary: built }
```

A `schedule` in the meta starts the workflow on a timer, as in [Schedules](#schedules-and-the-service).

An input of type `json` may take a `schema`, a JSON schema object. sous checks the value against
it with the other inputs, before the first step, and a value that does not fit fails the run or
the `workflow()` call with the field and the reason. `schema` in the meta is the shape of the
workflow's result. A result that does not fit fails the `workflow()` call, or the run at the top
level. `outputs` stays a description only. `sous check` refuses a schema that is not an object.

`sous run ticket --ticket "Add a --json flag"` turns flags into `args`. A path to a script file,
such as `./ticket.js`, runs that file instead of a saved workflow. `sous workflows` lists the saved
workflows and their inputs.

`sous check ticket --ticket x` checks a workflow without running it: the script parses, the inputs
fit, each workflow, agent and MCP server it names exists, and each agent can run on the harness its
step picks. A script file that `run()` names and that is missing is only a note, since it must
exist where the run works. With no inputs given, the check skips the required ones.

`sous check ticket --ticket x --dry-run` then runs the workflow once with stand-in agents, to catch
mistakes in its steps and in how they connect. Each agent step answers at once: with a value that
fits its schema, where booleans are true so loops end, or else with a line of text. Code steps
run for real, in the workflow's own place, except that a worktree stands in for the project
folder, or a scratch folder outside git. `SOUS_PROJECT` still names the real project folder, so a
code step that writes there changes the project. Each question gets a stand-in answer, and a
breakpoint is approved. Nested workflows run
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

A step that runs until done takes its turns from the answers. A status name plays one turn, so
`["working", "working", "done"]` is three turns. So does an object with `status` and no other key
than `status`, `result` and `message`. Any other answer is "done", with that answer as the result.
With no answer, the stand-in says "done" at once. A status other than "done" plays once, so when
the answers run out on "working" or "question", the step says "done". A check command runs once: the dry run prints
its exit code, and `--json` lists it under `checks`. Then the step goes on as if the check passed.
An agent's question gets a stand-in answer, as a question from `ask()` does.

A dry run of the example ticket workflow found a bug: when the implementer changed nothing, the
commit step failed with "nothing to commit". The workflow now commits only when a file changed.

### Steps

A script has these steps (see also [the engine README](../packages/engine/README.md#the-script-dsl)):

- `session(options)` makes a handle for one agent session that several steps share. It starts
  nothing. `<handle>.send(prompt, options)` runs one step on it. The first send starts the
  session, and each later send goes on in it, so the agent keeps what it saw:

  ```js
  const impl = session({ label: "implementer", agentType: "implementer" })
  await impl.send(`Implement this ticket:\n${args.ticket}`)
  const review = await agent("Review the change", { agentType: "reviewer", label: "reviewer" })
  await impl.send(`Address this review:\n${review}`, { label: "fix" })
  ```

  A handle's options hold for every step on it:

  - `label`, required. No other handle of the workflow may use it.
  - `agentType`, `model`, `effort`, `mode`, `skills` and `mcp` (server names, see
    [Agents](#agents)).
  - `mcpServers`, servers given in full, and `cwd`, the folder the session works in.

  A send's options belong to that one step:

  - `label`, the step's name in `sous log`, `sous tell` and `--answers`. It defaults to the
    handle's label.
  - `schema`, `timeout` ("10m"), `retries`, `images` and `phase`.
  - `model`, which must name a model on the handle's program.
  - `until`, `"done"` by default or `"turn"`. A step runs turns in its session until the agent
    reports `done`. Each turn answers with a status: `done` with its result, `working` when there
    is more to do (sous sends `Continue the task.`), or `question` when the agent needs the
    person. A question waits in the inbox, and the person answers it inside the agent's session
    with `sous join`, which is not built yet. `sous answer` and the page refuse it. With
    `until: "turn"` the step ends with its one turn and returns its text or its schema's value.
  - `ask`, `true` by default. `ask: false` takes `question` out of the status.
  - `check`, run when the agent reports `done`: a command, a function, or a list of them, in
    order. A command runs as a code step labelled `<label>: check`, in the step's folder, and
    passes when it exits 0. A function gets the result and the round, and returns `true`,
    `false` or `{ ok, feedback }`. A failed check sends its output or its feedback as the next
    turn, in the same session. The step returns the result once every check passes.
  - `maxTurns` and `maxRepairs`, off unless set. `maxTurns` counts every turn sous sends in the
    step, report and repair turns too. `maxRepairs` counts the turns that ask again for an
    answer that did not fit. Reaching either fails the step with the code `STEP_LIMIT`, which
    the script can catch. Uncaught, it fails the run.

  A handle runs one step at a time, and a second send while one runs fails the script. The
  handle's `label` and `cwd` are plain strings, for code steps: `sh("npm test", { cwd: impl.cwd })`.
  `--set <label>.model=` may change a handle's model, to another on the same program. Any other
  `--set` on a handle fails the script. A session option on `send()`, or a send option on
  `session()`, fails the script and names where it goes. With `place: "worktree"` the handle gets
  a worktree of its own when `session()` is called, and its `branch` names the branch. See
  [Places](#places).

  A step's turns run in one open program, so a background process the agent starts in one turn
  still runs in the next. The program closes when the step ends, before a question waits, when
  the run pauses or stops, and after a failed turn, whose retry resumes the session in a new
  program. The next send starts the program again and resumes the session, so an idle session
  holds no process. On Claude Code, a turn with a different schema, such as the report turn after
  a slash command, also resumes the session in a new program.

  `<handle>.fork(options)` makes a new handle whose session starts as a copy of this one, as its
  last finished turn left it. It takes a handle's options and keeps its parent's for those it
  does not set. It needs a new `label`, and a `model` on its parent's program. The fork's turns
  never reach its parent's session, and the parent's later turns never reach the fork's. fork()
  fails the script before the handle's first send finishes and while a send runs. A fork without
  `place` works in its parent's folder, on the same branch. With `place: "worktree"` it gets a
  worktree of its own, made from the last commit of its parent's folder, so the parent's
  uncommitted work is not in it. A fork's cost counts its own turns only.

  ```js
  const plan = session({ label: "planner" })
  await plan.send("Read the code and plan the change.")
  const a = plan.fork({ label: "plan a", place: "worktree" })
  const b = plan.fork({ label: "plan b", place: "worktree" })
  await parallel([() => a.send("Build it with a new table."), () => b.send("Build it with a new column.")])
  ```
- `agent(prompt, options)` is one send on a fresh session that no later step uses. It takes a
  handle's options and a send's options, and `place: "worktree"` (see [Places](#places)). Its
  `label` may repeat.
- An agent step does not stop to ask the person. `ask` has no effect yet.
- Code steps: `sh(command)`, `js(source, input)`, `py(source, input)`, `run(file)` and
  `waitUntil(command, { every })`. They run on this machine, count no tokens and take no agent
  slot. Each returns `{ code, stdout, stderr, result }`. A non-zero exit fails the step unless
  `allowFail: true`. They run in the run's place, and `SOUS_PROJECT` holds the project folder. A
  code step is tried once unless it sets `retries`.

  Code steps take structured input and output. `sh`, `run` and `waitUntil` take an `input`
  option, and `js` and `py` take it as their second argument. Each gets the input on stdin as
  JSON, and `js` and `py` also as the variable `input`. With a `schema`, a JSON schema object, the
  step's value is checked when it exits 0: the value `js` and `py` return or a script file writes
  to `$SOUS_RESULT`, else stdout read as JSON. It goes in `result`. Stdout that is not JSON, or a
  value that does not fit, fails the step with the reason. `waitUntil` checks the value of the
  check that exits 0.

  ```js
  const counted = await sh("jq '{n: (.tickets | length)}'", {
    input: { tickets: ["a", "b"] },
    schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
  })
  counted.result.n // 2
  ```
- `ask(question, { choices, answeredBy, input, schema })` asks the person through the inbox and
  waits for the answer. `answeredBy` is `"people"`, the default, or `"anyone"`, which lets an
  agent answer too. Any other value fails the script. `input` shows below the question as JSON.
  With a `schema`, the answer is read as JSON and `ask` returns the value. An answer that does
  not fit is refused with the reason, and the question stays open, at `sous answer`, on the page
  and through an answer file alike.
- `breakpoint(title, step, { show, max, input, schema })` runs the step, then waits for the user
  to approve, stop the run, or send the step back with a note. The step reruns with the note as
  often as the user sends it back. With `max`, the breakpoint fails after that many send-backs. A stop ends the run as
  `sous stop` does, and `sous wait` exits with 3. A breakpoint is always for people, so it fails
  on `answeredBy`. `input` shows with the title. With a `schema`, the person may approve with a
  JSON value instead, such as `sous answer <id> '{"n": 2}'`. The value must fit, and the
  breakpoint returns it. A plain approve still returns the step's result, or the decision when
  there is no step.

  An `input` option must be strict JSON and `schema` a JSON schema object, or the step fails when
  it is called. Both go into the step's call hash, so a resume replays a step only when they are
  the same.
- `choose(prompt, { steps, workflows, any, none, input })` lets an agent pick the next step or
  workflow and runs it. `any: true` allows every saved workflow except those for people only.
- `workflow(name, args, { place, label })` runs a saved workflow inside this one, five levels
  deep at most. It gets the defaults of its inputs, and a missing or wrong input fails the call.
  A nested worktree is a branch of its own, and its folder goes when the nested workflow returns,
  as a session's does (see [Places](#places)). `sous show` lists the nested run's steps under its
  label, and `sous log` starts each of its lines with that label.

Agents pass text to each other through prompts, or structured objects with `schema`. Steps that
should share files run in the same place.

The engine's flow steps take these arguments:

- `parallel([() => agent(...), ...])` runs the functions at once. A step that fails its last try
  pauses the run, as it does outside `parallel` (see [Failures and limits](#failures-and-limits)).
  Steps already running finish and nothing new starts. A function that throws an error of its own,
  outside any step, gives `null` in its slot, and the others go on.
- `pipeline(items, stage1, stage2, ...)` runs each item through the stages in turn, the items at
  once. Each stage gets the last stage's result, the item and its index. A step that fails its
  last try pauses the run, as in `parallel`. A stage that throws an error of its own gives `null`
  for that item, and its later stages don't run.

To send a step back until the tests pass, give it a `check`, and cap it with `maxTurns`:

```js
const impl = session({ label: "implementer", agentType: "implementer" })
await impl.send(`Implement this ticket:\n${args.ticket}`, { check: "npm test", maxTurns: 12 })
```

For a loop around something other than one step, write a plain loop, capped by an input:

```js
const impl = session({ label: "implementer", agentType: "implementer" })
await impl.send(`Implement this ticket:\n${args.ticket}`)
for (let round = 1; round <= args.rounds; round++) {
  const tests = await sh("npm test", { label: `tests ${round}`, allowFail: true })
  if (tests.code === 0) break
  await impl.send(`The tests fail:\n${tests.stdout}${tests.stderr}`, { label: `fix ${round}` })
}
```

`retry()`, `gate()` and `checkpoint()` are gone, and a script that calls one fails with what to
write instead. A loop replaces `retry()` and `gate()`, and `ask()` replaces `checkpoint()`. The
step options `keepSession`, `continue`, `isolation`, `configOptions` and `answeredBy` fail the
script the same way.

## Agents

A step uses an agent with `agentType: "<name>"`. sous looks each agent up on its own, in this
order, and takes the first one it finds:

1. `.rulesync/subagents/<name>.md` in the project;
2. the same in the global rulesync folder, the folder `rulesyncGlobal` names in `config.json`;
3. the harnesses' own folders in the project: `.claude/agents/<name>.md` and
   `.codex/agents/<name>.toml`;
4. the same folders in the home folder: `~/.claude/agents/` and `~/.codex/agents/`, or in the
   folders `CLAUDE_CONFIG_DIR` and `CODEX_HOME` name.

A rulesync agent is one file for every harness. Its frontmatter has a block per harness, and sous
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
sous:
  harness: claude
---
You review one change. Report what blocks it, then what could be better.
```

- The agent runs on `sous.harness`, else on the default harness: `defaultHarness` in `config.json`,
  else the harness `defaultModel` names before its slash, such as `codex/gpt-6-luna`, else Claude
  Code. A `defaultModel` with no slash, even `codex`, leaves the default harness on Claude Code.
- A step picks another harness with its model: `model: "codex"` runs the agent's Codex block,
  with that block's model. `model: "codex/gpt-6-luna"` sets the model too. A model that names no
  harness, such as `opus`, runs on Claude Code.
- A block with no model runs the run's model when it is on that harness, else the harness's own
  default model.
- Fields at the top of the frontmatter, such as `skills`, `mcpServers`, `tools` and `effort`, apply
  on every harness, and a block's own field replaces them. `timeout` is read at the top only, and
  `place: worktree`, or Claude Code's `isolation: worktree`, at the top or in the `claudecode`
  block. `rulesync generate` leaves top-level fields
  out of the files it writes, so your own sessions don't get them.
- A step's own `skills`, `mcp`, `effort`, `timeout` or `model` replaces the agent's, never adds to
  it.

A step asks for the first model in this list that is set:

1. the step's own `model`, or the one `--set <label>.model=` gives it;
2. its agent's model, from the block of the agent's default harness;
3. the `model` of the step's phase in `meta.phases`;
4. `meta.model`;
5. `sous run --model`, else `defaultModel` in `config.json`.

With none set, the step runs on the default harness with that harness's default model. The run
record shows the model the step asked for. Change it, and a resumed run runs the step again. A
step with an agent then follows the rules above. A harness alone picks the agent's block for that
harness, and a block with no model runs the asked model only when it is on the same harness.

An agent in a harness's own folder runs only on that harness. A step that sends it to another
harness makes the workflow invalid, and the message says to move the agent to rulesync. An agent
in both harnesses' folders and not in rulesync gives the default harness's copy. A step that picks
its harness while running, such as `model: args.harness`, stops with the same message when the
agent can't run there.

An agent in a run never stops to ask for permission. `tools` is its allow list: the built-in tools
it does not name don't exist for it. `disallowedTools` is its deny list. On Claude Code both apply
whatever your own Claude Code settings allow, even in bypass mode. A refused tool comes back to the
agent, which works around it or fails the step. With neither list, the agent may use every tool.
An allow list names whole tools: `Bash(npm test)` allows all of Bash. A name matches without case,
and also when one name holds the other, so `Edit` also matches `NotebookEdit`.

On Claude Code, a step that names no `mode` runs in auto mode when its model offers it.
`mode: default` does not keep your own setting. It runs Claude Code's own default mode, whatever
`defaultMode` your Claude Code settings name.

Codex has no allow list. sous declines each approval Codex asks for that the allow list does not
cover, but Codex runs the actions its sandbox allows without asking. A deny entry for an MCP tool
turns that tool off on Codex too.

### MCP servers

A step or an agent names its MCP servers. sous looks each name up in `.rulesync/mcp.jsonc` in the
project, then in the global rulesync folder's, then in the config of the harness the step runs on:
`.mcp.json` and `~/.claude.json` for Claude Code, `config.toml` for Codex. A server in rulesync
wins over one with the same name in a harness's config. Codex would merge the two, so when a
step's server has the name of one in Codex's config, the step's server runs as `<name>_step` and
the configured one is off for that step. `sous log` shows a note that says so.

```jsonc
{
  "mcpServers": {
    "linear": { "command": "npx", "args": ["-y", "linear-mcp"], "env": { "KEY": "${LINEAR_API_KEY}" } },
    "docs": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

### Skills and your own sessions

sous reads agents and MCP servers from `.rulesync/` directly. Skills are different: each harness
finds them in its own folders, such as `.claude/skills/`. `npx rulesync generate` writes
`.rulesync/skills/` there, with the agents and MCP servers, for your own Claude Code or Codex
sessions too. sous never writes into those folders. On Claude Code an agent's `skills` list is the
only skills it sees. Codex has no such list and sees every skill in its folders.

A step can ask for something its harness can't do, such as `skills` on Codex or an `effort` level
Claude Code lacks. The step still runs, with the harness's default, and `sous log` shows a `note`
line that says what was left out.

### The installed Claude Code and Codex

A Claude Code or Codex step runs on the program installed on this machine. sous ships no copy of
its own, so a step gets the same version and models as your own sessions. sous looks for each
program in this order and takes the first one it finds:

1. the adapter's own variable, `CLAUDE_CODE_EXECUTABLE` or `CODEX_PATH`;
2. `claudePath` or `codexPath` in `config.json`;
3. the folders on PATH;
4. `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`.

On PATH and in those three folders, sous passes over wrapper scripts, such as a launcher that picks
an account, since the adapter needs the program itself. The npm launcher of Claude Code or Codex
counts as the program. A path you give in a variable or in `config.json` is taken as is, even a
script, but the file must exist and be executable.

When a step's program is missing, the step stops before its agent starts, and the message says how
to install it. Each run records the path and version of each program it used, and `sous show`
prints them.

Each program must be a version its adapter works with. Claude Code must be at least the version
the Claude Agent SDK asks for, 2.1.330 today. Codex must be on a release line the adapter was
checked against, 0.169.x today, since its app-server protocol changes between minor releases. On
another version a step stops before its agent starts, and the message names the version it needs.
`sous doctor` shows the same message.

`sous doctor` shows the program sous found for each harness, how it found it, its version, and the
other copies it doesn't use. It opens a session on each and lists its models, which sends no
prompt. `sous doctor --live` also runs one tiny step on each, and `--live --model
codex/gpt-6.1-sol` checks one model. It shows where each program finds the sous skill, as `sous
skill check` does, and gives `sous skill install` as the next call when one is missing. It writes a
probe file in the sous home and says when it can't. Under Codex, whose sandbox lets a command write
only in its project, the note says to add the home to `sandbox_workspace_write.writable_roots` in
the Codex config, or to start Codex with `--add-dir <home>`. It exits 1 when a check fails, a home
sous can't write included. A missing skill is not a failed check.

sous never updates the programs. Update them as you usually do, such as with `npm install -g` or
Homebrew, and the next step runs the new version. When a machine has several copies of one
program, each copy may rewrite its own files, such as Codex's skills in `~/.codex/skills/.system/`.
`sous doctor` lists the copies.

### Accounts

sous is logged in on one account per program. `default` is the program's own login: Claude Code's
in `~/.claude`, or in the folder `CLAUDE_CONFIG_DIR` names where sous starts, and Codex's in
`~/.codex`, or `CODEX_HOME`.

| Command | What it does |
| --- | --- |
| `sous account` | the accounts, with `*` on the one sous uses for new runs, and the runs waiting at the usage limit |
| `sous account add <name>` | runs `claude setup-token`, which logs in through the browser, then asks for the token it prints. Off a terminal, it skips `claude setup-token` and reads the token from stdin. |
| `sous account use <name>` | use it for new runs. The runs waiting at another account's limit move to it and resume now. `default` goes back to Claude Code's own login. |
| `sous account remove <name>` | forget a login. Refused while an unfinished run uses it. |

sous keeps the tokens in `accounts.json` in the home folder, which only you can read. A named
account also keeps Claude Code from using `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, which
would win over the token. Settings, agents and skills still come from Claude Code's folder.

Each run records its account when it starts, and keeps it when it pauses and resumes, also when
the service resumes it. `sous show` prints it, and `sous doctor` checks the account sous uses now.

- A run that a Claude Code session starts uses that session's login for its Claude Code steps.
  When the session runs on a token, sous keeps that token for the run, so the service resumes it on
  the same login.
- A run that an agent of another run starts uses that run's accounts.
- A Codex step uses Codex's own login. Codex has a login token only on Business and Enterprise
  plans, so a Codex account will be a folder of its own. That comes later.

## Runs

| Command | What it does |
| --- | --- |
| `sous run <workflow> [--input value]` | start a run in the background. `--place`, `--model`, `--set reviewer.model=claude/opus` and `--concurrency` change this run only. `--wait` follows it, `--json` prints machine-readable output. |
| `sous list [--all]`, `sous show <run>`, `sous log <run> -f` | the last 20 runs, or every run with `--all`; one run's steps with the time and tokens of each, its questions and result; its log |
| `sous step <run> <label> [--call N] [--tail N] [--full]` | one step of a run: its status, time and tokens, its prompt or its command, its failure, and the last 20 entries of what it did. A step that ran more than once shows its last call, and `--call N` shows another. A label only nested runs have shows the first nested run that has it, and a note names the others. The name `sous log` gives a step of a nested run, such as `"ticket A: implementer"`, shows that run's step. When several nested runs share the name, `--call N` counts the calls of all of them in start order. `--tail N` shows N entries, and `--full` shows the whole prompt and every entry. A label the run never had exits 65. |
| `sous workflows` | the saved workflows and their inputs |
| `sous workflows show <name> [--full]` | one workflow's outline: its inputs, its steps in the order the file writes them, its nested workflows, the check's problems, the approval that speaks for its text, and its last 3 runs with their time and tokens. A long workflow's steps are cut to keep the reply under 8,000 characters, and `--full` shows them all. `next` gives the run and the check for an approved text, and the check and the approve call for a new or changed one. |
| `sous workflows show <name> --diff` | what changed in the file since the person's yes, as `- `, `+ ` and matching lines, with 3 matching lines around each change. A new file shows in full. The diff is cut at 200 lines with a note. |
| `sous workflows approve <name>`, `--all` | approve a workflow's text as it is now, as in [Approving workflows](#approving-workflows) |
| `sous agents` | the agents a step can name with `agentType`, from the project's folders and the home's, with each one's harness, model and file |
| `sous inbox`, `sous answer <q> <text>` | questions waiting for you, and answering one. `--value-json` reads the text as JSON, such as `'{"a": 1}'`. Without it the text is the answer, and text that starts with `{` or `[` gets a note. The answer file keeps `by` and `through`. |
| `sous approve <q>`, `sous send-back <q> <note>` | answer a breakpoint. `sous answer <q> stop` stops the run. |
| `sous pause <run>`, `sous resume <run> [--latest \| --same]` | finish the running steps and start nothing new; go on from there |
| `sous stop <run>` | end the run. sous commits what is left in its worktrees and removes their folders. The branches stay, unless they never moved. |
| `sous stop <run> --step <name>` | stop one running step, by the name `sous log` gives it, such as `"ticket A: implementer"`. The run pauses on it, and `sous resume` goes on with it in its session. |
| `sous tell <run> --step <name> "<message>" [--call N]` | give a running agent step a message, which it reads after its current tool call. The step goes on. The step is its label or its name in `sous log`, as `sous step` takes it. Each running call of the step gets it, and `--call N` tells only the Nth call, counted as `sous step --call` counts them. The reply's `calls` lists each call told with its `step` name, its `call` number and its `delivery`. The reply's `delivery` is `delivered`, or `pending` while the step has not read it within 5 seconds. A code step fails with `step_takes_no_message`, a step that does not run now with `step_not_running`, and a step in a turn that takes no message for a moment, such as a compact, or between two turns, with `turn_not_steerable`. |
| `sous resume <run> --note "<message>" [--step <name>]` | resume, and add the message to the prompt of the first agent call that runs. `--step` gives it to that step's first call instead, by its label or its name in `sous log`, or by a label the workflow's text writes for a step the run has not reached yet, the new text with `--latest`. A name in neither exits 65 with `no_such_step`, a code step exits 66 with `step_takes_no_message`, and the run stays paused. When no agent call took the note, `sous log` says it reached no step. When the step already finished, a note says the message reaches it only if the workflow calls it again. The step's activity shows a `note` line, and the `resume` line in `events.jsonl` holds the message. A run that runs already does not resume, and the reply gives the `sous tell` call instead. |
| `sous rerun <run> [--reuse]` | the same workflow with the same inputs. `--reuse` keeps the results of the steps you did not edit and works in the same place. |
| `sous run`, `rerun` or `resume` with `--let-agent-answer` | lets agents answer the run's questions for people, and its nested runs' questions. Never its breakpoints. A rerun does not carry it over. |
| `sous wait <run> [--timeout N]` | wait until the run ends, pauses or asks. Exit 0 done, 1 failed, 2 paused, 3 stopped, 4 waits for an answer, 5 still running after `--timeout N` seconds. The run goes on after a timeout. An agent's wait, or a step's, has a timeout of 110 seconds when it gives none. A person's waits as long as it takes. In a terminal it asks the run's questions itself, so 4 comes only off a terminal or with `--json`. |
| `sous status [--since 3d] [--line] [--all]` | what needs you, what runs, what waits to resume on its own, and what finished. Runs that ended show for the last 24 hours, or for the `--since` time. A failed or stopped run that ended before that counts only in a note, like a finished one. Each list shows 20 entries, or all with `--all`. `--line` prints one line for an agent's session start, or nothing when nothing needs you. |
| `sous gc [--dry-run]` | remove sous's merged branches, and their worktrees |
| `sous discard <run> --yes` | delete the run's branches and worktrees, merged or not. Without `--yes` it lists them, deletes nothing and exits 0. A running run is refused: stop it first. |
| `sous prune --days N` | remove finished runs older than N days |

A command that takes no workflow inputs, such as `sous list`, leaves out a flag it does not take
and says so in a note that names the flag. `sous run`, `sous rerun` and `sous check` read an
unknown `--name value` as an input instead, and so does `sous schedule add`.

A command with a wrong or missing argument exits 64. So does `sous resume` after an edit, with
neither `--latest` nor `--same`. A run, workflow, question, step or schedule that is not there
exits 65. So do `sous stop --step` and `sous tell` with a name the run never had, `sous resume --step` with a name in neither the run nor its text, and `sous tell` to
a step that does not run now. Any other refusal exits 66,
such as `sous discard` of a running run, or `sous resume` of a run an older sous saved. A write
the system refuses under the sous home, with EACCES, EPERM or EROFS, exits 1 with
`home_not_writable`. Its `change` says how to make the home writable, under Codex too, and its
`call` is `sous doctor --json`.

A request that changes nothing exits 0 with a note. That covers pausing a run that is not
running, stopping a run that has ended, stopping a step when no worker runs, resuming a run that
is running, completed, was stopped or never started, and `sous daemon status` when the service
is not running. The note says why. With `--json`, `next` holds the call that fits: `sous resume`
for a paused run, `sous wait` for a running one, and `sous rerun` for one that ended or never
started.

With `--json`, each command prints one object with two more keys: `notes`, a list of sentences, and
`next`, a list of `{call, does}` commands to run next. Some outputs changed shape for this. `sous
list`, `inbox`, `workflows`, `schedule list` and `doctor` printed a bare array. They now print an
object that holds it under `runs`, `questions`, `workflows`, `schedules` or `programs`. `sous list
--json` shows 20 runs like `sous list`, and a note says how many more `--all` shows.

`sous show <run> --json` is short: the status, the time and tokens, each step's label, status, time
and tokens, the questions, and the failure when there is one. It keeps the last 30 steps, and a
note says how many earlier steps `--full` shows. `--full` adds `record` and `state`, which
`show --json` printed before, and gives each question with every field the inbox keeps. A run
paused at a usage limit has `resumesAt`, the time the service resumes it.

`sous wait --json` gives a run's status with three new words. `stopped` was `aborted`.
`interrupted` is a run whose worker died. `not started` is a run with no state and no worker. A
wait that times out gives `running`. An error
prints `{"error": {code, message, change, call}}` on stdout. An error that offers more than one
call adds `next`, the calls as `{call, does}` in the order to try them, and `call` is the first.
Without `--json`, the error goes to stderr: the message, then `change:`, then a `try:` line for
each command to run instead. A reply without
`--json` prints its text, then a `note:` line for each note, then a `next:` line for each call.

`sous answer --json` used to mean the text is JSON. Now `--json` asks for the JSON reply, as on every
command, and `--value-json` reads the text as JSON. Text that does not parse goes as text, and a
note says so. `sous log --json` gives `runId`, `events`, `after` and `more`. Each event has `seq`,
`at` and `kind`, which is one of `step-start`, `step-end`, `asks`, `answered`, `paused`, `resumed`
and `ended`. An event of a nested run also has `scope`. `after` is the seq of the last event given.
`--after <seq>` reads the events after that seq, so `sous log <run> --json --after <after>` gives
the next page. A page holds at most 100 events and stays under 8,000 characters. `more` is true
when more events wait, and `next` then holds the call for the next page. An `--after` past the last event gives
no events, a note with the last seq, and the call to read the log from the start. A broken event
log exits 66 with the code `broken_record`. A question gives an `asks` event when it is asked,
and an `answered` event with the same `call` when the answer reaches the run. An `asks` event has
the question in `prompt`, and an agent step's question adds `step`.

`sous step <run> <label> --json` gives `runId`, `step`, the step's name in `sous log`, `scope`, `call`, `calls`, `status` and
`kind`, which is `agent` or `exec`. `scope` is the run the step ran in: the run's id, or a nested
run's. An agent step adds `model` and `prompt`, and a code step adds `command` and `output`, the
end of what it printed. Both add `failure` when the step failed, `result`, which for an agent step
is the start of its result, and `activity`, the step's entries oldest first. Each entry has `seq`,
`at`, `kind` and `text`. The kinds are `prompt`, `text`, `tool`, `tool-result`, `command`, `output`
and `error`. An entry's text keeps at most 2,000 characters, with passwords, tokens and the values
of your secrets hidden. The reply shows the last 20 entries and stays under 8,000 characters, so the
oldest entries go first, and one note says how many. `--full` keeps every entry and drops the
8,000 character limit.

The other new replies have these keys: `pause` has `runId`, `status` and `pausing`.
`stop` has `runId`, `outcome` and `status`, and with `--step`, `runId`, `step`, `stopping` and
`status`. `discard` has `runId`, `worktrees` and `deleted`. `gc` has `dryRun`, `removed` and
`kept`. `prune` has `days`, `removed` and `runIds`, which lists at most 100 run ids. `schedule add`
has `schedule` and `nextAt`, `remove` has `removed`, `enable` and `disable` have `name` and
`enabled`, and `test` has `name`, `matches` and `nextAt`. `account add` has `added` and
`program`, `use` has `program`, `name`, `moved` and `same`, and `remove` has `removed`, `program`
and `current`. `daemon` has `running`, `pid` and `log`.

On macOS a run notifies when it asks something, and when it ends or pauses. A scheduled run stays
quiet when it completes or is stopped. `notify: false` in `config.json` or `SOUS_NOTIFY=0` turns
the notices off.

### Failures and limits

- An agent step that fails is tried again up to its `retries`, or the config's `retries` when the
  step sets none. A code step is tried once unless it sets `retries`. Either way, 5 tries at most.
  After the last try the run pauses on that step. `sous resume` runs the step again in a new
  session and keeps the finished ones.
- A step cut off by `sous stop`, a time limit, the budget, the subscription limit, a lost login, a
  crash or a kill goes on in its own session and its own folder when the run resumes, in a nested
  workflow or a worktree too. Its next prompt is `Continue the task.`, followed by the `--note`
  message when there is one. A step whose prompt starts with `/` sends that prompt again instead,
  since a command such as `/goal` may not outlive the program, and the note goes before it. A step
  whose session or folder is gone starts over in a new session. So does a step whose program died
  before it read the prompt, since its session holds no task.
- A run keeps the workflows as they were when it started, nested ones included. After an edit,
  `sous resume` refuses and names the two ways on: `--latest` takes the new version and keeps the
  finished steps that match, and `--same` goes on with the run's own version. The error's `next`
  lists `--latest` first, then `--same`. An agent's `--latest` needs the person's yes to the new
  text, so until then the error offers `sous workflows show <name> --diff --json` in its place.
  A new text that does not load offers `--same` alone, and the message says what is wrong with
  it. The service doesn't resume such a run at the limit either. It tells you once.
- A run saved by an older sous in a format this one no longer reads still shows in `sous list` and
  `sous show`, and does not resume. `sous resume` says so and names `sous rerun <run>`, which starts
  it again, and `sous stop <run>`, which ends it. `sous rerun --reuse` refuses it too, and the service
  leaves it alone.
- A step matches when it asks for the same thing in the same way: the same prompt, model, agent,
  options and label. When a workflow runs the same step several times, the first time matches the
  first recorded one, the second time the second, and so on.
- At the subscription limit the run pauses, and the notice names the account and the reset time.
  The service resumes it after the reset time, or 30 minutes later when no time is known, and
  then waits 15 minutes before it tries again. `sous account use <name>` moves it to another account
  and resumes it now.
- A run whose program loses its login pauses, shown as `paused: login`. The service does not
  resume it. Log in again, then `sous resume` goes on.
- The config's `maxAgents` caps the agents running at once across all runs. Others wait in a
  queue, and a person's run goes before a scheduled one.
- Every limit on a run's work is off unless the workflow sets it. A loop's rounds are the
  workflow's to cap, usually with an input such as `rounds`. `maxAgents` in the meta, unlike the
  config's, caps the run's agent, code and checkpoint calls, nested workflows included, and the
  run fails at the next one. `maxNestingDepth` in the meta caps how deep `workflow()` nests. Each
  is a whole number of at least 1. A step's `maxTurns` and `maxRepairs` and a breakpoint's `max`
  are off unless set too. A dry run alone keeps a cap of 1000 calls, since it starts no program
  and a loop would never end. A meta `maxAgents` under 1000 still holds in a dry run.
- A workflow's `timeout` limits each start and each resume of a run. When it is reached, the
  running steps stop, code steps such as `sh` as well as agent steps, and the run pauses on them,
  shown as `paused: time limit`. `sous resume` goes on with them with the whole limit, and `sous stop`
  ends the run. With no step running, as when the run waits for an answer, the run pauses the same
  way, and no new step starts.
- A run's budget limits the tokens each start and each resume of it may spend. It is
  `--budget <tokens>` on `sous run`, `sous rerun` or `sous resume`, else `budgetTokens` in the
  config, else none. A rerun keeps the old run's budget unless it gives one. The budget counts the
  same tokens `sous show` reports, cache reads and writes included, and each failed try of a step
  counts as soon as it ends. When a go reaches it, the running steps stop, no new step starts, and
  the run pauses, shown as `paused: budget`. `sous resume` gives the next go the same budget, and
  `sous resume <run> --budget <tokens>` a new one, kept for the goes after it too.

### Places

- `worktree` (the default): a new branch `sous/<run>` in `~/.sous/worktrees/<run>`. When the run
  completes or is stopped, sous commits what is left uncommitted as `sous: uncommitted work of
  <workflow>` and removes the folder. The branch stays for review, unless it never moved. A run
  that pauses or fails keeps the folder for its resume. `sous gc` and the service, once an hour,
  remove a merged branch whose folder is gone, and a worktree whose branch is merged and has
  nothing uncommitted. They keep those of a run that has not finished.
- `folder`: the project folder itself.
- `none`: an empty scratch folder, for work that touches no repo, such as email.

A session or one step can work apart from the run, with `place: "worktree"` in the options of
`session()` or `agent()`, or `place: worktree` in its agent's frontmatter. It gets a new branch
from the `HEAD` of the folder around it, in `~/.sous/worktrees/`:

- A session's is `sous/<run>-<label>-<hash>`, where the hash is six characters of the run and the
  label. sous makes it when `session()` is called. It lasts until the workflow that made the
  handle returns.
- A fork's is named as a session's. sous makes it when `fork()` is called, from the `HEAD` of its
  parent's folder. It lasts until the workflow that made the fork returns.
- One step's is `sous/<run>-<label>-<n>`, where n counts the `agent()` calls with that label from
  1. It lasts until the step ends, its checks included.

A step's `cwd` is read under the worktree's folder. When the worktree's scope ends, sous commits
what is left uncommitted as `sous: uncommitted work of <label>`, skipping the project's hooks, and
removes the folder. The branch stays, unless it never moved. A run that pauses or fails keeps the
folder, and a resume goes on in it, or makes it again from the branch. Outside a git repository
the session or step works in the run's place, and the log says so.

## Schedules and the service

```sh
sous schedule add nightly-bugs factory --cron "0 2 * * *" --team ENG
sous daemon start
```

Every 20 seconds the service starts the schedules that are due, skipping one whose last run has
not finished. It resumes runs paused at the limit, and removes runs older than `keepDays`. A run cut
off by a crash or a restart shows as interrupted and waits for `sous resume`. The service tells you
about it once. `sous schedule test <name>` says whether the schedule matches now and when it
runs next. `sous schedule remove`, `enable` and `disable` change the schedules `sous schedule add`
made, and `sous daemon stop` and `sous daemon status` stop the service and say whether it runs.

A workflow can also carry its own schedule, in its meta:

```js
schedule: { cron: "0 2 * * *", inputs: { team: "ENG" } },   // or just "0 2 * * *"
```

The service reads it from the workflows in `~/.sous/workflows/` and from those of each
project where sous ran, so run `sous check <workflow>` once in a new project. A home workflow's
scheduled runs work in a scratch folder. `sous schedule list` shows these schedules under the path
of the file they come from. To stop one, change or remove `schedule` in the file. `sous check`
refuses a bad cron, and a schedule whose inputs miss a required one.

## The page

```sh
sous serve
```

An installed sous carries the page. A build from source takes it from `packages/view/dist`, which
`pnpm build` makes.

`sous serve` shows the runs, the questions, the workflows, the agents, the skills and the MCP
servers in the browser. It listens on 127.0.0.1 only, on port 4317 or the next free one. `--port`
picks another. It prints a link that holds a token, and opens it unless you give `--no-open` or
there is no terminal. The link sets a cookie, and every request needs that cookie or the header
`Authorization: Bearer <token>`. `SOUS_SERVE_TOKEN` sets the token. Ctrl-C stops the server.

The page reads the home through the API under `/api`, and `/api/live` tells it within a second
what changed. An answer, a stop or any other action on the page runs the `sous` command in the
server, as the person through the page. It follows the same rules as at the terminal, and the
action's line records `through: { kind: "person", via: "view" }`. The workflows, agents, skills
and MCP servers are those of the project `sous serve` started in, and `--project` names another.

A step of a run cannot start `sous serve`, since no person is there to read the page. An agent
starts it only once the person asked for the page, with `--by person`.

## From a session

A Claude Code session starts a workflow like a subagent, through its shell:

```sh
sous run ticket --ticket "Fix the empty count" --wait --json
```

Agents inside a run get `SOUS_RUN_ID` in their environment. A run they start records the run that
started it.

sous knows who calls from the environment: `SOUS_RUN_ID` is a step of a run, `CODEX_THREAD_ID` is
Codex, and `CLAUDECODE=1` is Claude Code, in that order. Anything else is the person. A write
through an agent records `by: "agent"`. An agent that passes on the person's own decision adds
`--by person`, and the line keeps both. A step of a run cannot give `--by person`: it exits 66 with
`no_person_here`. On a read, `--by person` changes nothing and says so in a note. An answer,
approval or send-back through an agent sends the person a notice.

Each question says who may answer it in `answeredBy`. `"people"`, the default, takes only the
person's answer, typed or passed on with `--by person`. `"anyone"` takes an agent's answer too. A
breakpoint is always for people. An agent's own answer to a question for people exits 66 with
`question_for_people`, and its `call` passes on the person's answer with `--by person`. A step of
a run gets no answer call for a question for people, and its refusal has no `call`: only the
person answers, and the run waits for them. A run
started with `--let-agent-answer` lets agents answer its questions for people, never its
breakpoints. Only the person gives that flag: from an agent without `--by person` it exits 66 with
`needs_person`, and nothing starts. The record keeps it as `letAgentAnswer: { by, through, at }`,
and `events.jsonl` gets a `let-agent-answer` line. `sous inbox --json`, `sous wait --json` and
`sous status --json` show `answeredBy` as it stands for the run, so a question for people of such
a run shows `"anyone"`. Their answer calls carry `--by person` only for an agent, and only where it
may not answer alone. These rules hold for `sous answer`, `sous approve` and `sous send-back`.
Writing an answer file in the home yourself bypasses them, so agents always use `sous answer`.

sous refuses to start a workflow with `startedBy: "people"` through an agent or a run, also with
`--by person`, and also as a rerun, a dry run or a schedule. A run that an agent or a run started
cannot start one either, through a nested `workflow()` or `choose()`, and its rerun and resume keep
that rule. An agent cannot add or enable a schedule for one. It exits 66 with
`started_by_people`, and the error's `forPerson` holds the command for the person to type in a
plain terminal. A schedule the person added or enabled starts it. A run uses the account of the
session or the run that started it, as in [Accounts](#accounts).

### Approving workflows

An agent may write or change a workflow, with the person's yes. sous then keeps a second yes, to
the workflow's exact text. An agent, a step of a run or a schedule starts a workflow only once the
person approved that text. Each workflow it calls by name with `workflow("name")` needs its yes
too. Otherwise the start exits 66 with `not_approved`, and the error's `change` gives the approve
call. A nested `workflow()` in such a run is refused the same way, and `choose()` offers only the
approved ones.

- `sous workflows approve <name>` approves the text in the file now. `--all` approves every
  workflow of the project and the home. An agent passes the person's yes on with `--by person`.
  Without it, an agent's approve exits 66 with `needs_person`. Each approve adds one
  `approve-workflow` line to `events.jsonl`, and one through an agent sends the person a notice.
- A person's own `sous run`, and their `sous resume --latest`, approve the texts they run.
- A dry run needs no yes and gives none. A dry run that was cut off never resumes as a real run.
  `sous resume` and `sous rerun --reuse` refuse it with `cannot_resume`, and the call runs the dry
  run again.
- When the edited workflow has a schedule, the service skips it each time it comes due, logs why,
  and sends the person one notice per edit with the approve command.
- An agent that writes or edits a workflow tells the person its name, what changed, and that sous
  waits for their yes. `sous workflows show <name> --diff` gives what changed since their last
  yes, and the not_approved refusal's call is that command.
- `sous workflows show <name>` gives `approved`: the approval of the text as it is, with
  `changedSince` false, else the newest one, with `changedSince` true. A text put back to one the
  person approved before starts again. The seed shows as `{by: "sous", seeded: true}`.

At the first command, or when the service starts, sous approves every workflow of every project
where sous ran, of each project a schedule names, and of the home, as they are. It does this once
per home, and `seeded.json` marks it done. `approvals.json` in the home keeps each file's last 20
approvals by hash, and `approved/<hash>.json` keeps each approved text. Never edit or delete them.
Without `approvals.json`, no workflow counts as approved. A broken one makes each start that needs a
yes exit 66 with `broken_record`. A run records the hash of the text sous checked, and
`sous resume --latest` records the hash of the edit it checked. The worker reads the file once and
runs that text only if the hash matches. Otherwise the run does not start or resume, and
`sous show` gives why as its failure.

`sous guide` lists the topics an agent reads to drive sous for a person, and `sous guide <topic>`
prints one. The topics are in `packages/cli/guide/`. `sous skill install` links the sous skill
into `<CLAUDE_CONFIG_DIR or ~/.claude>/skills/sous` and `~/.agents/skills/sous`, where Claude Code
and Codex find it. It replaces a broken link that sous made from a checkout or worktree that is
gone. It refuses with `not_ours` when either place holds anything else, and then writes nothing. `sous skill check` shows each place, and `sous skill path` prints the skill folder.

`sous hook install` adds a SessionStart hook to Claude Code's `settings.json`, in
`CLAUDE_CONFIG_DIR` or `~/.claude`. It runs `sous status --line 2>/dev/null || true`, so a new
session hears what needs the person, and nothing when nothing does. sous finds its entry by that
exact command. A second install changes nothing. Before it first changes a file that is there,
install copies it to `settings.json.sous-backup`, and a later install keeps that first copy. When
`settings.json` is a link, sous writes the file it points to, and the link stays. `sous hook remove`
deletes only sous's entry, and the `SessionStart` list or `hooks` key when nothing else is left in
it. When sous made the file and the remove leaves it empty, the file goes too. A `settings.json`
that does not parse, has a shape sous can't edit, or is a broken link is refused with `not_ours`
and stays as it is. The hook is off until you install it. Codex gets no hook yet, since its hook
format is not checked.

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
  harness, `sous check` refuses the workflows that can't run, an agent's own skill and MCP server
  work on both harnesses, and the harnesses' agent, skill and MCP files stay as they were.
- A schedule in a workflow's meta. With `schedule: "* * * * *"`, `sous daemon run` started one run
  a minute, each marked as started by the schedule.
- [The installed Claude Code and Codex](proof/installed.md), with nothing set by hand. Steps run on
  Claude Code 2.1.329 and Codex 0.169.0, on Haiku 5.5 and gpt-6.1-sol, each run keeps which
  program and version it used, `sous doctor` checks both, and neither program changes its own
  files during the runs. The minimum Claude Code has since moved to 2.1.330, and the
  [proofs of the cleanup](history/improve.md) ran on it.

- [Accounts](proof/accounts.md). A run from a Claude Code session records that session's login, a
  run from a plain shell records sous's account, and the tests cover the usage limit, the switch
  and the resume.

The proofs before the installed one ran on the Claude Code and Codex that sous bundled then:
Claude Code 2.1.281, where haiku meant Haiku 4.5, and Codex 0.156.1.

Waiting:

- Real Linear tickets need `LINEAR_API_KEY` in `~/.sous/secrets.env`. Until then the
  factory reads `tickets/`.
- A real mailbox, such as Gmail, needs its connection set up. Until then the emails workflow reads
  `mail/inbox.json`.
- Cloud places come later. A run works in a worktree, the project folder or a scratch folder on
  this machine.

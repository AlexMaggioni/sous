<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
    <img src="docs/brand/lockup-light.svg" alt="sous" width="300">
  </picture>
</p>

<p align="center">
  Run workflows of Claude Code and Codex agents in the background, on your own machine.
</p>

<p align="center">
  <a href="https://github.com/AlexMaggioni/sous/actions/workflows/ci.yml"><img src="https://github.com/AlexMaggioni/sous/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-B5602A" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/node-22%2B-7A3A16" alt="Node 22 or newer">
</p>

---

A sous workflow is a JavaScript file. Its steps call agents and run code. You start it with one
command, and it runs in the background, on the Claude Code and Codex already installed on your
machine. Close the terminal and the run goes on.

When an agent has a question, it lands in your inbox. When a step fails, the run pauses on it and
`sous resume` goes on from there. When the subscription limit hits, the run pauses, and the sous
service resumes it after the reset. Each run works in a git worktree of its own, so its changes wait on a branch for your
review.

```sh
sous run ticket --ticket "Add a --json flag to the export command"
sous inbox                  # questions from the agents
sous show <run>             # steps, time and tokens, the result
```

## Install

You need git, Node.js 22 or newer, and at least one of these, logged in:

- Claude Code 2.1.330 or newer
- Codex 0.169.x

```sh
npm install --global @sous-run/cli
sous doctor          # the Claude Code and Codex it found, their versions, their models
```

`pnpm add --global @sous-run/cli` and `bun add --global @sous-run/cli` work too.
`sous doctor --live` also runs one tiny step on each program. `sous update` installs the latest
version with the package manager that installed sous, and `sous update --check` only says whether
a newer one is out.

The install takes about 440 MB. Most of it is a copy of Claude Code that the Agent SDK brings
along. sous never runs that copy. It runs the Claude Code and Codex already on your machine.

sous runs on macOS, Linux and Windows. It is developed on macOS, where it also sends
notifications, and CI runs the tests on Linux. To build it from source, see
[Development](#development).

## Features

- **Workflows as code.** Agent steps, shell, JavaScript and Python steps, loops, parallel steps,
  pipelines and nested workflows, in one script with typed inputs and outputs.
- **Claude Code and Codex.** Each step runs on the program you have installed, with your models
  and your login. One workflow can mix both.
- **Your agents, skills and MCP servers.** sous reads them from [rulesync](https://github.com/dyoshikawa/rulesync)
  or from each program's own folders, and never writes into them.
- **Runs in the background.** A run survives the terminal. A service starts scheduled runs and
  resumes the ones that paused at the limit.
- **An inbox.** Agents ask questions, and breakpoints wait for you to approve a step or send it
  back with a note.
- **Resume.** A failed step pauses the run. `sous resume` runs it again and keeps every finished
  step. After you edit the workflow, `sous resume --latest` keeps the steps that did not change.
- **Worktrees.** Each run gets a branch and a worktree, or works in the project folder, or in a
  scratch folder. A single step can also work on a branch of its own.
- **Schedules.** A cron line in the workflow, or `sous schedule add`.
- **Checks and dry runs.** `sous check` finds missing agents, MCP servers and inputs before a run.
  `--dry-run` runs the whole workflow with stand-in agents, for free.
- **Accounts.** Switch the Claude Code login for new runs. The runs waiting at one account's
  limit move to the new one and resume.
- **Tool lists that hold.** On Claude Code, an agent gets only the tools its `tools` list names,
  even when your own settings bypass permissions.

## Quick start

The repository has an example project, `textkit`: a small Node library with two known bugs, three
tickets and three workflows. Copy it to a folder of its own, since the ticket workflow needs a git
repository to branch from:

```sh
git clone https://github.com/AlexMaggioni/sous.git
sous/examples/setup-textkit.sh ~/textkit
cd ~/textkit
```

Try the ticket workflow with stand-in agents first. It costs nothing:

```sh
sous check ticket --ticket "$(cat tickets/TK-1.md)" --dry-run
```

Then run it for real. The example agents run on Haiku, to keep the run cheap:

```sh
sous run ticket --ticket "$(cat tickets/TK-1.md)" --wait
```

An implementer fixes the bug in a new worktree. A reviewer reads the diff, and its review goes back
to the implementer's own session until it approves. A verifier then tries the cases. The workflow
commits on the run's branch only when the reviewer approved, the verifier passed it and the tests
pass. `sous show <run>` prints each step, and the
branch `sous/<run>` holds the change.

The [examples README](examples/README.md) also walks through the factory, which triages tickets and
builds two at once, and an email workflow that waits for your approval.

## A workflow

Save this as `.sous/workflows/ticket.js` in a project:

```js
export const meta = {
  name: "ticket",
  description: "Implement a ticket, review it, fix it",
  inputs: {
    ticket: { type: "string", description: "What to build", required: true },
  },
  outputs: { summary: "What was built" },
  place: "worktree",
}

const built = await agent(`Implement this ticket:\n${args.ticket}`, {
  agentType: "implementer",
  label: "implementer",
  keepSession: true,
})
const review = await agent(`Review the change for: ${args.ticket}`, { agentType: "reviewer", label: "reviewer" })
await agent(`Address this review:\n${review}`, { continue: "implementer" })
await sh("npm test")
return { summary: built }
```

`sous run ticket --ticket "..."` turns the flags into `args`. `implementer` and `reviewer` are
agents you define once, in rulesync or in `.claude/agents/`.

The steps a workflow can use:

| Step | What it does |
| --- | --- |
| `agent(prompt, options)` | runs an agent, with its model, effort, skills, MCP servers, timeout and output schema |
| `sh`, `js`, `py`, `run`, `waitUntil` | run code on this machine. They take no agent slot and count no tokens. |
| `parallel`, `pipeline` | run steps at once, or run items through stages |
| `retry`, `gate` | try again until a check passes, feeding back what failed |
| `ask`, `checkpoint` | ask you a question through the inbox |
| `breakpoint(title, step)` | run a step, then wait for you to approve it or send it back with a note |
| `choose(prompt, options)` | let an agent pick the next step or workflow |
| `workflow(name, args)` | run another saved workflow inside this one |
| `phase`, `log` | name a part of the run, write a line to its log |

## Agents and models

An agent is a Markdown file with frontmatter. A [rulesync](https://github.com/dyoshikawa/rulesync)
agent holds one block per program, so the same agent runs on Claude Code or on Codex:

```md
---
name: reviewer
description: Reviews one change
targets: ["*"]
claudecode:
  model: haiku
  tools: [Read, Grep, Glob]
codexcli:
  model: gpt-6-luna
---
You review one change. Report what blocks it, then what could be better.
```

sous looks for an agent in the project's `.rulesync/`, then the global rulesync folder, then
`.claude/agents/` and `.codex/agents/` in the project and in your home folder. A step picks the
program with its model: `model: "codex"` runs the agent's Codex block, and `model: "claude/opus"`
runs Claude Code on Opus. `sous run --model` and `--set reviewer.model=...` change the models of
one run.

## Runs

| Command | What it does |
| --- | --- |
| `sous run <workflow>` | start a run in the background. `--wait` follows it. |
| `sous list`, `sous show <run>`, `sous log <run> -f` | the runs, one run's steps, its log |
| `sous inbox`, `sous answer <q> <text>` | the questions waiting for you, and answering one |
| `sous approve <q>`, `sous send-back <q> <note>` | answer a breakpoint |
| `sous pause <run>`, `sous resume <run>` | let the running steps finish and start no new ones, then go on later |
| `sous stop <run>` | end the run. Its worktree stays for review. |
| `sous rerun <run> --reuse` | run again with the same inputs, keeping the steps you did not edit |
| `sous wait <run>` | wait until the run ends, pauses or asks, with an exit code for each |
| `sous gc`, `sous discard <run>`, `sous prune --days N` | clean up merged worktrees, one run, old runs |

A run works in one of three places, set in the workflow's meta or with `--place`:

- `worktree`, the default: a new branch `sous/<run>` in `~/.sous/worktrees/<run>`.
- `folder`: the project folder itself.
- `none`: an empty scratch folder, for work that touches no repository.

`maxAgents` in the config caps the agents running at once across all runs. A run you start goes
before a scheduled one.

## Schedules and the service

```sh
sous schedule add nightly-bugs factory --cron "0 2 * * *" --team ENG
sous daemon start
```

A workflow can also carry its schedule in its meta, as `schedule: "0 2 * * *"`. The service checks
the schedules every 20 seconds. It also resumes the runs paused at the usage limit once the limit
resets, and removes merged worktrees once an hour.

## From a Claude Code session

A session can start a workflow like a subagent, through its shell:

```sh
sous run ticket --ticket "Fix the empty count" --wait --json
```

The run uses the session's own login. A workflow with `startedBy: "people"` in its meta refuses
to start from an agent.

## Configuration

The home folder is `~/.sous`, or the folder `SOUS_HOME` names. A project keeps its own workflows in
`.sous/workflows/`, and they win over the home folder's.

| File | What it holds |
| --- | --- |
| `config.json` | `maxAgents`, `defaultPlace`, `defaultModel`, `defaultHarness`, `retries`, `keepDays`, `notify`, `rulesyncGlobal` |
| `secrets.env` | `KEY=value` lines for code steps and MCP server settings. Agents never see them. |
| `workflows/` | the workflows every project can run |
| `runs/`, `records/`, `inbox/`, `logs/` | the state of the runs |

## Documentation

- [The guide](docs/guide.md) covers every feature, command and file format.
- [The examples](examples/README.md) are three workflows to run.
- [The proofs](docs/proof/README.md) record real agents running each feature end to end.
- [The engine's README](packages/engine/README.md) describes the engine and its test kit.
- [The changelog](CHANGELOG.md) says what changed, and how to move from `orc`.

## Packages

| Package | What it does |
| --- | --- |
| [`packages/cli`](packages/cli) | the `sous` command: runs, the inbox, schedules, accounts and the service |
| [`packages/engine`](packages/engine) | runs a workflow script, with its journal, resume and questions |
| [`packages/harnesses`](packages/harnesses) | runs one step on Claude Code, through the Claude Agent SDK, or on Codex, through `codex app-server` |

An architecture test keeps the three in line: what each may import, which outside libraries it
uses and what it exports.

## Development

You need Node.js 22 or newer and pnpm 10:

```sh
git clone https://github.com/AlexMaggioni/sous.git
cd sous
pnpm install
pnpm build
cd packages/cli && pnpm link --global
```

`pnpm link --global` puts this build's `sous` on your PATH. If pnpm asks for a global bin folder,
run `pnpm setup` once and open a new shell. To update the build, run `git pull`, then
`pnpm install` and `pnpm build`.

Run `pnpm test` from the repository root. It builds every package, type-checks them, then runs
the architecture test, every package's tests and the golden files of `test/baseline`. It needs no credentials and starts no real
agent. The steps run on fake programs in `test/fakes`. The proofs in `test/proofs` run on the real
programs, by hand.

A release is one version for the three published packages. Write its section in
`CHANGELOG.md` as `## 0.2.0 (unreleased)`, then run `pnpm release 0.2.0` on `main`. That dates the
section, sets the version, commits and tags `v0.2.0`. Pushing the tag starts
`.github/workflows/release.yml`, which runs the tests, publishes to npm, makes the GitHub release.
A version such as `0.2.0-rc.1` goes to npm's `next` tag.

The workflow publishes through npm's trusted publishing, so the repository stores no npm token.
npm only lets a package that exists name its trusted publisher, so the first version goes out by
hand, once, from a machine logged in to npm with an account in the `sous-run` org:

```sh
pnpm install && pnpm build
pnpm release 0.1.0
for name in harnesses engine cli; do (cd packages/$name && pnpm publish --access public); done
git push origin main v0.1.0
```

Then, on npmjs.com, open each of `@sous-run/harnesses`, `@sous-run/engine` and `@sous-run/cli`.
Under Settings, add a trusted publisher: GitHub Actions, the repository `AlexMaggioni/sous`, the
workflow `release.yml`. The workflow run that the tag starts finds 0.1.0 on npm already, skips
it, and makes the GitHub release. Every later version goes out through the tag alone.

`pnpm install` points git at the hooks in `.githooks`. The pre-push hook runs `pnpm test` and stops
the push when it fails. After a change to what sous prints, `BASELINE_UPDATE=1 node --test
test/baseline.test.mjs` rewrites the goldens. [AGENTS.md](AGENTS.md) has the rules for working on
the code.

## License

Apache-2.0. See [LICENSE](LICENSE). sous started from code that others wrote under the same
license, and [NOTICE](NOTICE) names it.

# Changelog

## 0.2.0 (unreleased)

A breaking release. A step now does what a session you open by hand does, and the workflow adds
the structure around it. Finish or stop your paused runs before you upgrade, as the last part
says.

### Sessions

- `session(options)` makes a handle for one agent session. Each `send(prompt, options)` on it runs
  a step in that session, so the agent keeps what it saw. `agent()` is one send on a fresh session.
- `fork(options)` on a handle copies its session into a new handle. The two go on apart.
- `room(options)` lets the sessions of several handles talk in rounds until they agree or a
  decider decides. By default the members speak at the same time and hear every message. `turns`
  and `hears` change both. The run page shows a room as one box with a lane per member.

### How a step runs

- A prompt goes to the program as written. A slash command, a skill or `/goal` runs as it does in
  a session you opened. A report turn in the same session then asks for the status and the
  schema's value. The step's label is in the system text, not in the prompt.
- On Codex, sous sends `/goal`, `/review`, `/compact`, `/prompts:<name>` and the project's skills
  to what the Codex app server has for each. Any other command fails the step and names it.
- A step runs until its agent reports `done`. Each turn answers with a status through the
  program's own output schema: `done`, `working` or `question`. `until: "turn"` runs one turn.
- `check` runs a command or a function when the agent reports `done`, and sends a failure back to
  the agent in the same session.
- Every limit is off unless the workflow sets it. `maxTurns` and `maxRepairs` cap a step, and
  `maxRounds` caps a room.
- A step's turns run in one open program, so a background process from one turn still runs in the
  next.
- Code steps take an `input` and a `schema`, and give the value in `result`.
- `sous check` checks an agent that an input names, as `agentType: args.planner`, with the value
  given or the input's default.
- A stop closes the step's way in for messages at once, so a message sent after it reaches no
  turn.

### The person

- An agent's question no longer goes to the inbox. sous says the agent needs you and gives the
  `sous join` line. `sous answer` and the page refuse such a question. The inbox keeps the
  workflow's own `ask()` and `breakpoint()`.
- `sous join <run> <step>` opens the step's own session in your terminal. When you leave, the step
  goes on in the same session. Nothing else in the run stops while you are in it.
- `ask` is on by default. `ask: false` keeps a step from asking.
- A message that points at the config file names the one sous reads, under `SOUS_HOME` when it is
  set, where it always named `~/.sous/config.json`.

### Places and resume

- `place: "worktree"` on a session, an `agent()` step or a fork gives it a worktree and a branch of
  its own. When its scope ends, sous commits what is left uncommitted and removes the folder. The
  branch stays.
- A step cut off by a stop, a time limit, the budget, the subscription limit or a kill goes on in
  its own session and folder when the run resumes, in a nested workflow or a worktree too.

### Examples

- `examples/build` builds one stage of a project from its design. A planner cuts it into tickets,
  each ticket gets an implementer and a reviewer in a worktree of its own and lands as one commit,
  and verifiers prove the stage's gates.
- The ticket example sends the tests' failures and the reviewer's review back to the implementer
  through `check`, in its own session.

### Removed

- `retry()`, `gate()` and `checkpoint()`. A script that calls one fails with what to write
  instead: `check` and `maxTurns` or a loop for the first two, `ask()` for `checkpoint()`.
- The step options `keepSession`, `continue`, `isolation`, `configOptions` and `answeredBy` fail
  the script with a message. Write `session()` and `send()` for the first two, and
  `place: "worktree"` for `isolation`. `isolation: worktree` in an agent's frontmatter reads as
  `place: "worktree"`.
- An `--answers` key of the form `<label> (answer N)` matches nothing, since an agent's question
  has no text answer now.

### Upgrading from 0.1.0

A run paused under 0.1.0 runs its agent steps again after the upgrade, since their hash now holds
`until`. Its code steps and the answers to its `ask()` and `breakpoint()` calls replay. Finish or
stop paused runs before you upgrade, or start them again with `sous rerun`.

## 0.1.0 (2026-11-26)

The first version named sous. The same code shipped before as `orc`, from this repository.

### What it does

- Runs saved JavaScript workflows of agent steps and code steps in the background. A run keeps
  going when the terminal closes.
- Runs each agent step on the Claude Code or Codex installed on the machine, with agents, skills
  and MCP servers from rulesync or from each program's own folders.
- Asks its questions through an inbox, and waits at breakpoints until you approve or send a step
  back with a note.
- Pauses on a failed step and at the subscription limit. `sous resume` goes on and keeps the
  finished steps. The service resumes a run after the limit resets.
- Works in a new worktree and branch per run, in the project folder, or in a scratch folder.
- Starts workflows on a cron schedule, from `sous schedule add` or from a workflow's own meta.
- Checks a workflow without running it, and dry-runs it with stand-in agents.
- Switches the Claude Code account for new runs and for the runs waiting at the limit.
- Installs from npm as `@sous-run/cli`. `sous --version`
  prints the version, and `sous update` installs the latest one with the package manager that
  installed sous.

### Changed since orc

- The command is `sous`. The packages are `@sous-run/cli`, `@sous-run/engine` and `@sous-run/harnesses`, and
  the command line package lives in `packages/cli`.
- The home folder is `~/.sous`, and a project keeps its workflows in `.sous/workflows/`.
- The environment variables start with `SOUS_`: `SOUS_HOME`, `SOUS_PROJECT`, `SOUS_RUN_ID` and
  `SOUS_NOTIFY`, among others.
- Run branches are named `sous/<run>`, and a step's own worktree `sous/<run>-<n>-<label>`.
- A rulesync agent names its default program in a `sous:` block of its frontmatter, as
  `sous: { harness: codex }`. The block was `orc:`.
- `AGENTPRISM_DEFAULT_BACKEND` is gone. A model that names no harness, such as `opus`, always runs
  on Claude Code.
- `ORCHESTRATOR_PERSISTENCE_ROOT` is gone. The command never read it, since it always names the
  folder for its run state.
- sous names itself `sous` to Codex's app server.
- The engine and the harnesses restart their version numbers at 0.1.0.

### Upgrading from orc

sous reads nothing under the old names. To keep your runs, workflows and schedules:

1. Let the runs finish, or stop them. A run that has not finished recorded the old paths, so it
   may not resume after the move. `orc list` shows the runs.
2. Stop the old service: `orc daemon stop`.
3. Move the home folder: `mv ~/.orchestrator ~/.sous`.
4. In each project, rename `.orchestrator/` to `.sous/`. When the project has worktrees from runs,
   run `git worktree repair ~/.sous/worktrees/*` in it, so git finds them at their new path.
5. Rename your environment variables: each `ORC_` becomes `SOUS_`.
6. In your rulesync agents, `.rulesync/subagents/*.md` in each project and in the global rulesync
   folder, rename the `orc:` block of the frontmatter to `sous:`. sous ignores an `orc:` block.
7. Install sous as the README says, then start the new service: `sous daemon start`.

Branches made before the rename keep their `orc/` names. `sous gc` still removes their worktrees
once they are merged.

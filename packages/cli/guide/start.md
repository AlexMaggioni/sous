# Start a run

A workflow is a JavaScript file of steps. A run is one execution of it. The run works in the
background and goes on after your session ends. Treat it like a subagent you started, with three
differences. It outlives you. It can ask the person a question. Its work lands on a git branch
for review.

## First, look at what is there

```sh
sous status --json
```

`needsYou` lists the questions and the runs that failed or stopped. `running` and `waiting` list
the runs that are not done. Tell the person about `needsYou` before you start anything new.

## Pick the workflow

```sh
sous workflows --json
```

Each workflow has its name, its description and its inputs. A project's `.sous/workflows/` wins
over `~/.sous/workflows/` on a name clash. To check one with the inputs you plan to give:

```sh
sous check ticket --ticket "Fix the empty count" --json
```

## Start it

```sh
sous run ticket --ticket "Fix the empty count" --json
```

Each workflow input is a flag. The command returns at once. The reply has:

- `runId`, the id every other command takes.
- `workflow`, `cwd` and `branch`. The branch is where a worktree run commits.
- `log`, the run's log file.
- `status`, which is `starting`.
- `asks`, how many questions and breakpoints the workflow's text holds.
- `lastRuns`, the count, mean seconds and mean tokens of its last completed runs.

Tell the person the run id, what the run will do, that it may ask them something, and what the
last runs cost. Then wait for it, as `sous guide wait` says.

`--place worktree|folder|none` changes where this run works. A worktree is a new branch in
`~/.sous/worktrees/<run>`. `folder` is the project folder itself. `none` is an empty scratch
folder. `--model claude/haiku` sets the model for steps that name none.

## Workflows only a person starts

Do not start a workflow with `startedBy: "people"`. sous refuses it with `started_by_people`,
exit 66, and the error's `forPerson` holds the command. Give it to the person to type in their own
terminal. `--by person` does not change this. Never try to get around it.

## Codex

Under Codex, the sandbox may block writes to the sous home. A command that can't write there
fails with `home_not_writable`. `sous doctor --json` checks it and names the home. The person adds
the sous home to `sandbox_workspace_write.writable_roots` in the Codex config, or starts Codex
with `--add-dir <home>`.

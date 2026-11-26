# Changelog

## 0.1.1 (unreleased)

### Fixed

- After a reboot, a pid that sous saved before it may name another process. sous saved the pid
  alone, so it could show a dead worker as running, keep an agent slot taken, refuse to resume a
  run, or send `sous stop`'s SIGTERM to that other process. sous now saves the boot id with each
  pid, and a pid from another boot counts as gone.
- A service that died just after it started a scheduled run, and came back within the same minute,
  could start the schedule a second time. The service now writes the minute to the disk, and waits
  for the disk, before it starts the run.
- A run started from inside a run's worktree made that worktree a known project, so the service
  started the schedules of its workflow files once more for each such worktree. A folder in the
  home's `worktrees/` is no longer a project, and those an older sous noted are skipped.

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

---
name: sous
description: Start, watch, answer and write sous workflows. sous runs workflows of Claude Code and Codex agents in the background on this machine. Use when the user mentions sous, a workflow, a run, the inbox or a schedule, asks to run agents in the background or overnight, or asks what their runs are doing.
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

1. `sous workflows --json` lists the workflows and their inputs.
2. `sous run <name> --<input> <value> --json` starts it and returns at once.
3. Tell the user the run id, what it will do, what it may ask, and what the last runs cost.

A workflow marked `startedBy: "people"` starts only when the user types the command. Give them
the command from the refusal. Never try to get around it.

## Wait for it

In Claude Code, run `sous wait <run> --json` as a background command. You are called again
when it returns. Elsewhere, run `sous wait <run> --timeout 540 --json`, and call it again
while it exits 5. Never wait with sleep. Never call `sous show` in a loop.

The exit code says why it returned: 0 completed, 1 failed, 2 paused, 3 stopped, 4 asks.

## When it asks

A question is the user's. Show it to them in full, with its choices. When they answer, pass
their words on with `sous answer`. If the user is not there, say that the run waits, and stop.
A question waits as long as it takes. Never answer with a choice you made.

## When it ends

Completed means the script ended. It does not mean the work is right. Read `result` and
`review` in the reply, and read the diff on the run's branch. Report the outcome, the branch,
what you checked yourself and what you did not. Never merge, push or discard unless asked.

## When it pauses or fails

Read `pauseReason`, `failure` and `next`. `sous resume` runs the failed step again and keeps
the finished ones. `sous rerun` pays for every step again, so ask first. A run paused at the
usage limit needs nothing. The service resumes it.

## Write or change a workflow

Read `sous guide writing` first. Show the user what you will save, and save only after their
yes. Save in the project's `.sous/workflows/`. Run `sous check <name> --dry-run --json` until
it passes. A dry run spends no tokens. Add a schedule, save into `~/.sous/workflows/`, or change
who may start a workflow only when the user asked for that.

## Errors

A refusal has `error.change`, what to change, and `error.call`, the call to make instead.
Make that call. Do not retry the refused one.

## Inside a run

If `SOUS_RUN_ID` is set, you are a step of that run. You may start workflows that allow it.
Leave the inbox, the other runs and the workflow files alone.

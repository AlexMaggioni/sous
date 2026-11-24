# When a run pauses or fails

Read `pauseReason`, `reason`, `failure` and `next` in the wait reply. `next` holds the call that
fits. A run that waits at a question while it runs has the status `asks` and no `pauseReason`.
See `sous guide asks`.

## Pause reasons

| pauseReason | What happened | What to do |
| --- | --- | --- |
| `step_failed` | A step failed its last try. | Read the step, tell the person, offer a resume. |
| `usage_limit` | The account reached its usage limit. | Nothing. The service resumes it at `resumesAt`. |
| `auth_required` | The program lost its login. | The person logs in again, then resume. |
| `time_limit` | The workflow's `timeout` ran out. | Resume gives it the whole limit again. |
| `requested` | Someone ran `sous pause`. | Resume when the person wants. |
| `step_stopped` | Someone stopped one step. | Resume runs that step again. |
| `interrupted` | The worker died, as in a restart. The status is `interrupted`. | Resume. |
| `checkpoint_required` | A question waits and no worker runs. | Answer it, then resume. |
| any other text | The run paused for that reason. | Read `reason`, tell the person. |

## Read a failed step

`failure` names the step and its message. To see its command or prompt, its output and what it
did:

```sh
sous step <run> <label> --json
```

## A failed run

A run with the status `failed` exits 1. Read `failure` and the step, tell the person, and offer a
resume. `sous resume` takes a failed run too.

## Resume, not rerun

```sh
sous resume <run> --json
```

`resume` runs the failed or stopped steps again and keeps the finished ones. It costs only what
is left.

```sh
sous rerun <run> --json
```

`rerun` starts the same workflow with the same inputs, and pays for every step again. Ask the
person first. `--reuse` keeps the results of the steps whose text did not change.

## After an edit to the workflow

A run keeps the workflow as it was when it started. After an edit, `sous resume` exits 64 and
names two ways on:

```sh
sous resume <run> --latest --json
sous resume <run> --same --json
```

`--latest` takes the new version and keeps the finished steps that match. `--same` goes on with
the run's own version.

## The usage limit

At the limit, the run pauses and the service resumes it after the reset. Check that the service
runs:

```sh
sous daemon status --json
```

`sous account use <name> --json` moves the waiting runs to another account and resumes them now.
Do that only when the person asks.

## Ending it

```sh
sous stop <run> --json
```

`stop` ends the run. Its worktree stays for review when the run changed a file.

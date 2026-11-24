# When a run pauses or fails

Read `pauseReason`, `reason`, `failure` and `next` in the wait reply. `next` holds the call that
fits.

## Pause reasons

| pauseReason | What happened | What to do |
| --- | --- | --- |
| `step_failed` | A step failed its last try. | Read `failure`, tell the person, offer a resume. |
| `usage_limit` | The account reached its usage limit. | Nothing. The service resumes it at `resumesAt`. |
| `auth_required` | The program lost its login. | The person logs in again, then resume. |
| `time_limit` | The workflow's `timeout` ran out. | Resume gives it the whole limit again. |
| `requested` | Someone ran `sous pause`. | Resume when the person wants. |
| `step_stopped` | Someone stopped one step. | Resume runs that step again. |
| `interrupted` | The worker died, as in a restart. | Resume. |
| `asks` | A question waits. | See `sous guide asks`. |

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

`stop` ends the run. Its worktree stays for review.

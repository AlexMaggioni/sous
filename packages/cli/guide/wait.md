# Wait for a run

`sous wait` returns when the run ends, pauses or asks a question. Never wait with `sleep`, and
never call `sous show` in a loop.

## In Claude Code

Run the wait as a background command. You are called again when it returns.

```sh
sous wait <run> --json
```

Without `--timeout`, an agent's wait ends after 110 seconds with exit 5, under the two minutes
Claude Code gives a tool call. A note says so. Wait again.

## Elsewhere

Give a timeout in seconds that fits your shell tool's limit, and call again while it exits 5.
The run goes on after a timeout.

```sh
sous wait <run> --timeout 540 --json
```

## The exit code says why it returned

| Exit | Status | What to do |
| --- | --- | --- |
| 0 | completed | Read the result and the diff. See `sous guide ends`. |
| 1 | failed, not started | Read `failure`. A run that never started has none. See `sous guide pauses`. |
| 2 | paused, interrupted | Read `pauseReason`. See `sous guide pauses`. |
| 3 | stopped | Someone stopped it. Tell the person. |
| 4 | asks | A question waits. See `sous guide asks`. |
| 5 | running | The timeout ran out. Wait again. |

## The reply

- `runId`, `workflow` and `status`.
- `pauseReason` on a paused run, and `reason` in words.
- `resetHint`, the reset time the program gave at the usage limit, in its words.
- `questions`, each with `id`, `prompt`, `kind`, `choices`, `breakpoint`, `askedAt` and
  `answeredBy`.
- `cwd` and `branch`.
- `result` and `review`, once the run completed. `review` holds the branch, the worktree and the
  result.
- `failure`, with the `step` and its `message`, when a step failed.
- `resumesAt`, when the service resumes a run paused at the usage limit.

`next` holds the calls that fit the status, such as `sous step <run> <label> --json` for a
failed step. Use them as written.

## Later sessions

A new session knows nothing of the runs an earlier one started. Start it with
`sous status --json`, which lists the runs that need the person, run or wait.

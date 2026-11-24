# Replies

With `--json`, every command prints one JSON object. Besides its own keys it has two more:

- `notes`, a list of sentences to read and pass on when they matter.
- `next`, a list of `{call, does}`, the calls that fit now. Use them as written.

An error prints `{"error": {...}}` instead. See `sous guide errors`.

## The keys of each command

| Command | Keys |
| --- | --- |
| `status` | `needsYou`, `running`, `waiting`, `finished`, `service` |
| `status --line` | `line`, one sentence, or nothing when nothing needs the person |
| `run`, `rerun` | `runId`, `workflow`, `cwd`, `log`, `status`, `branch`, `asks`, `lastRuns` |
| `wait` | `runId`, `workflow`, `status`, `pauseReason`, `resetHint`, `reason`, `questions`, `cwd`, `branch`, `result`, `review`, `failure`, `resumesAt` |
| `show` | `runId`, `workflow`, `status`, `word`, `cwd`, `branch`, `worktree`, `startedAt`, `seconds`, `tokens`, `steps`, `questions`, `failure`, `resumesAt` |
| `show --full` | the same, plus `record` and `state` |
| `list` | `runs` |
| `log` | `runId`, `running`, `log` |
| `inbox` | `questions` |
| `answer`, `approve`, `send-back` | `question`, `runId`, `answered`, `running` |
| `pause` | `runId`, `status`, `pausing` |
| `stop` | `runId`, `outcome`, `status` |
| `stop --step` | `runId`, `step`, `stopping`, `status` |
| `workflows` | `workflows` |
| `discard` | `runId`, `worktrees`, `deleted` |
| `gc` | `dryRun`, `removed`, `kept` |
| `prune` | `days`, `removed`, `runIds` |
| `doctor` | `programs` |
| `guide` | `topics`, or `topic` and `text` |
| `skill` | `path`, or `programs` |

A key with nothing to say is left out, so a run that has not failed has no `failure`.

## Short and full

`show --json` keeps the last 30 steps, and a note says how many more `--full` gives. `list` shows
20 runs, and `--all` shows every one. `log --json` gives the end of the log.

## One line

```sh
sous status --line 2>/dev/null || true
```

`--line` prints one sentence for the start of a session, or nothing when nothing needs the
person.

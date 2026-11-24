# Replies

With `--json`, every command prints one JSON object. Besides its own keys it has two more:

- `notes`, a list of sentences to read and pass on when they matter.
- `next`, a list of `{call, does}`, the calls that fit now. Use them as written.

An error prints `{"error": {...}}` instead. See `sous guide errors`.

Without `--json`, a command prints its text, then a `note:` line for each note and a `next:`
line for each call. `wait` and `log` print the run's log lines instead.

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
| `log` | `runId`, `events`, `after`, `more` |
| `step` | `runId`, `step`, `scope`, `call`, `calls`, `status`, `kind`, `model`, `startedAt`, `seconds`, `tokens`, `prompt`, `result`, `failure`, `command`, `output`, `activity` |
| `inbox` | `questions` |
| `answer`, `approve`, `send-back` | `question`, `runId`, `answered`, `running` |
| `pause` | `runId`, `status`, `pausing` |
| `stop` | `runId`, `outcome`, `status` |
| `stop --step` | `runId`, `step`, `stopping`, `status` |
| `workflows` | `workflows` |
| `discard` | `runId`, `worktrees`, `deleted` |
| `gc` | `dryRun`, `removed`, `kept` |
| `prune` | `days`, `removed`, `runIds` |
| `doctor` | `programs`, `skills`, `home` |
| `guide` | `topics`, or `topic` and `text` |
| `skill` | `path`, or `programs` |
| `hook install` | `settings`, `command`, `already`, `backup` |
| `hook remove` | `settings`, `command`, `removed` |

A key with nothing to say is left out, so a run that has not failed has no `failure`.

## Short and full

`show --json` keeps the last 30 steps, and a note says how many more `--full` gives. `list` shows
20 runs, and `--all` shows every one.

`log --json` gives at most 100 events. Each has `seq`, `at` and `kind`. `after` is the seq of the
last one. When `more` is true, `next` holds the call for the next page:

```sh
sous log <run> --json --after <seq>
```

A question gives an `asks` event when it is asked, and an `answered` event with the same `call`
when the answer reaches the run.

`step --json` gives the last 20 entries of `activity`. `--tail N` gives N, and `--full` gives all
of them and the whole prompt. `--call N` shows another call of a step that ran more than once.

## One line

```sh
sous status --line 2>/dev/null || true
```

`--line` prints one sentence for the start of a session, or nothing when nothing needs the
person. `sous hook install` makes a new Claude Code session run it. Install it only when the
person asks.

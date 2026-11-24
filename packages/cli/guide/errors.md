# Errors

With `--json`, an error prints one object on stdout:

```json
{ "error": { "code": "no_such_run", "message": "...", "change": "...", "call": "sous status --json" } }
```

- `message` says what went wrong.
- `change` says what to change.
- `call` is the call to make instead, or null when there is none.
- `forPerson`, on `started_by_people` only, is the command the person types themselves.

Make the call in `call`. Do not retry the refused one unchanged. When `call` is null, read
`change`. If it needs the person, such as moving a folder, tell them. Without `--json`, the error
goes to stderr as the message, then `change:`, then `try:` with the call.

## Exit codes

| Exit | Meaning |
| --- | --- |
| 64 | A wrong or missing argument: `bad_argument`, or `not_a_choice` for an answer outside the choices. |
| 65 | The thing asked for is not there: a run, workflow, question, step, schedule or guide topic. |
| 66 | sous refuses, such as `run_is_running` or `not_ours`, or a record is broken. |
| 1 | sous itself failed, or can't write to its home: `internal` or `home_not_writable`. |

`sous wait` also uses 0 to 5 for the run's status. See `sous guide wait`.

## Codes you may meet

| Code | What to do |
| --- | --- |
| `no_such_run` | Find the run in `sous status --json`. |
| `no_such_workflow` | Find the name in `sous workflows --json`. |
| `no_such_question` | It was answered or is gone. Wait for the run again. |
| `no_such_step` | Find the step's name in `sous show <run> --json`. |
| `step_not_running` | The step is not running now. Read `sous show <run> --json`. |
| `run_is_running` | Stop the run first, if the person wants that. |
| `cannot_resume` | An older sous saved the run. Rerun it, after asking. |
| `not_ours` | A skill place holds something sous did not put there, or Claude Code's `settings.json` does not parse, has a shape sous can't edit, or is a broken link. Tell the person. |
| `home_not_writable` | sous can't write to its home. Under Codex the sandbox blocks it. Tell the person what `change` says. |
| `started_by_people` | Only a person starts this workflow. Give them `forPerson` to type in their own terminal. |
| `no_person_here` | A step of a run gave `--by person`. Leave it out: the step decides for itself. |
| `question_for_people` | The question is the person's. Show it to them, then make `call` with their answer. |
| `needs_person` | Only the person decides this. Ask them, then make `call`, which adds `--by person`. |
| `broken_record` | A file sous keeps, such as a run's event log, does not parse. Tell the person. |

## Requests that change nothing

A request in the wrong state exits 0 with a note, such as pausing a paused run or resuming a
completed one. `next` holds the call that fits instead: `wait` for a running run, `resume` for a
paused one, `rerun` for one that ended.

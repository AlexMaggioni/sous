# When a run asks

A run asks through its inbox. `sous wait` exits 4, and the reply's `questions` hold what waits.
Each question's `answeredBy` says who may answer it:

- `"people"`: only the person. You pass on their answer.
- `"anyone"`: you may answer it yourself. The workflow's author allowed it, or the person started
  the run with `--let-agent-answer`.

An agent's step that asks names itself in `step`. The calls in `next` are the ones that fit you.

## Show it, then pass on the answer

Show the person the question in full, with its choices. When they answer, pass their words on
unchanged, with `--by person`:

```sh
sous answer <question> "<their words>" --by person --json
```

`--by person` records that the person decided and you passed it on. `sous approve` and
`sous send-back` take it too. sous tells the person in a notice each time an agent answers.
Without `--by person`, an answer to a question for people exits 66 with `question_for_people`.

Never answer with a choice you made yourself. If the person is not there, say that the run waits
for them, and stop. A question waits as long as it takes. No timeout picks a default.

To list what waits, for one run or for all:

```sh
sous inbox <run> --json
sous inbox --json
```

## Kinds

- `confirm` takes yes or no.
- `select` takes one of `choices`. Another word exits 64 with `not_a_choice`.
- `input` takes any text. When the person gives JSON, such as `{"a": 1}`, add `--value-json` so
  the run gets an object.

```sh
sous answer <question> '{"a": 1}' --value-json --json
```

## Breakpoints

A question with `breakpoint: true` waits for the person to review a step's work. It is always for
people. They approve it, send the step back with a note, or stop the run:

```sh
sous approve <question> --by person --json
sous send-back <question> "Add a test for the empty list" --by person --json
sous stop <run> --json
```

A send-back runs the step again with the note.

## After the answer

The reply has `question`, `runId`, `answered`, `running`, `by` and `through`. When the run is
still running, wait for it again. When it is not, `sous resume <run> --json` goes on with the
answer.

## Let agents answer

Only when the person says so, start the run with `--let-agent-answer --by person`. You may then
answer its questions for people, never its breakpoints. `rerun` and `resume` take the flag too.
Without `--by person` it exits 66 with `needs_person`.

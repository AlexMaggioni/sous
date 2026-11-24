# When a run asks

A run asks through its inbox. `sous wait` exits 4, and the reply's `questions` hold what waits.
Every question belongs to the person. Its `answeredBy` is `"people"`.

## Show it, then pass on the answer

Show the person the question in full, with its choices. When they answer, pass their words on
unchanged:

```sh
sous answer <question> "<their words>" --json
```

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

A question with `breakpoint: true` waits for the person to review a step's work. They approve
it, send the step back with a note, or stop the run:

```sh
sous approve <question> --json
sous send-back <question> "Add a test for the empty list" --json
sous stop <run> --json
```

A send-back runs the step again with the note.

## After the answer

The reply has `question`, `runId`, `answered` and `running`. When the run is still running, wait
for it again. When it is not, `sous resume <run> --json` goes on with the answer.

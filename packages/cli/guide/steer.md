# Steer a run

You steer a run by telling a running step more, by stopping a step, or by pausing or stopping
the run. Telling is the lightest: the step goes on with what it has done.

## Find the steps that run now

```sh
sous show <run> --json
```

Each step has its label and status. `sous log <run>` names each running step the way
`stop --step`, `tell --step` and `sous step` take it, such as `"ticket A: implementer"` for a
step of a nested run.

## See what a step does

```sh
sous step <run> <label> --json
```

It gives the step's prompt or command, its status, its `failure` when it failed, and its
`activity`, the last 20 things it did. Read it before you stop a step, and after one fails.

## Tell a running step

```sh
sous tell <run> --step "implementer" "Use the v2 API." --json
```

The step reads the message after its current tool call, and goes on. Use it when the person
wants a step to change course without starting over. The reply has `delivery`: `delivered` when
the step got it, or `pending` when the step reads it once its tool call ends. `sous step` then
shows it in the step's `activity`.

A step that runs more than once at the same time gets the message in each call, and a note says
so. `--call 2` tells only the second call of the step, counted from 1 in start order as `sous
step` counts them. A name from `sous log` that several nested runs share counts the calls of all
of them. The reply's `calls` lists each call told, with its name, its number and its delivery.

Some steps take no message:

- A code step (`sh`, `js` or `py`) fails with `step_takes_no_message`. Stop it instead.
- A step that does not run now fails with `step_not_running`. For a paused run, its call is
  `resume --note`, which gives the message to the step when the run goes on.
- A step in a turn that takes no message for a moment, such as a compact, or between two
  turns, fails with `turn_not_steerable`. Its call is the same tell. Run it again soon.
- A Codex older than 0.169.0 takes no message at all, and its steps fail with
  `turn_not_steerable` each time. Update Codex, or stop the step and give the message with
  `resume --note "..." --step <step>`.

## Stop one step

```sh
sous stop <run> --step "implementer" --json
```

The step stops and the run pauses on it, as `step_stopped`. `sous resume <run> --json` runs that
step again from its start. Use this when the person wants a step done over, such as after they
change a file the step reads.

## Pause the run

```sh
sous pause <run> --json
```

The running steps finish, and nothing new starts. `sous resume <run> --json` goes on.

## Stop the run

```sh
sous stop <run> --json
```

The run ends. Its worktree stays for review when the run changed a file. A stopped run does not resume. `sous rerun` starts
it again from the start.

Stop or pause only when the person asks, or when a run does something they said it must not.
Tell them what you stopped and why.

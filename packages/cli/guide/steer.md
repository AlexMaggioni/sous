# Steer a run

Today you steer a run by stopping a step or the run. A later version adds a way to give a
running step more to go on, and this topic grows with it.

## Find the steps that run now

```sh
sous show <run> --json
```

Each step has its label and status. `sous log <run>` names each running step the way
`stop --step` takes it, such as `"ticket A: implementer"` for a step of a nested run.

## See what a step does

```sh
sous step <run> <label> --json
```

It gives the step's prompt or command, its status, its `failure` when it failed, and its
`activity`, the last 20 things it did. Read it before you stop a step, and after one fails.

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

# Inside a run

If `SOUS_RUN_ID` is set, you are a step of that run. The person does not see you in a chat.
They see what your step returns, and the run's log.

## What you may do

- Do the work your step's prompt asks for, in the run's folder.
- Start another workflow that allows it. The new run records the run that started it.

```sh
sous run <workflow> --json
```

Do not start a workflow with `startedBy: "people"`. Only a person starts it.

- Read your own run.

```sh
sous show $SOUS_RUN_ID --json
```

## What you leave alone

- The inbox. The questions belong to the person.
- The other runs. Do not pause, stop, resume or discard them.
- The workflow files and the schedules.

## Asking the person

Do your best with what you have, and say what you assumed in your answer.

## Your account

A run you start uses the account of the run you are in.

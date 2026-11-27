# When a run ends

`completed` means the script ended. It does not mean the work is right.

## Read before you report

```sh
sous show <run> --json
```

The wait reply gives `result`, what the workflow returned, and `review`, with the branch it
worked on. `sous show <run> --full --json` has the result under `state.result`.

When the run ended, sous committed what was left uncommitted on the branch, as
`sous: uncommitted work of <workflow>`, and removed the worktree's folder. Read the diff on the
run's branch yourself, from the project folder, against the branch the project was on when the
run started:

```sh
git log --oneline <start-branch>..<branch>
git diff <start-branch>...<branch>
```

`sous show <run> --json` lists each step with its status, time and tokens. `--full` adds the
whole record. `sous step <run> <label> --json` shows one step's prompt, result and what it did.

## The report

Tell the person:

- what the run claims, from `result`;
- what you checked yourself, such as the diff or a test you ran;
- what you did not check;
- the branch.

Never merge, push or discard unless the person asks.

## Clean up when asked

```sh
sous discard <run> --json
sous discard <run> --yes --json
sous gc --dry-run --json
```

`discard` without `--yes` lists the branches and worktrees it would delete, and deletes nothing.
With `--yes` it deletes them, merged or not. `gc` removes only merged branches, and their
worktrees. A run that completed and changed no file has no branch left.

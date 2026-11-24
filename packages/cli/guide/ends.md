# When a run ends

`completed` means the script ended. It does not mean the work is right.

## Read before you report

```sh
sous show <run> --json
```

The wait reply gives `result`, what the workflow returned, and `review`, with the branch and the
worktree it worked in. `sous show <run> --full --json` has the result under `state.result`.

Read the diff on the run's branch yourself, against the branch the project was on when the run
started:

```sh
git -C <worktree> log --oneline
git -C <worktree> diff <start-branch>...HEAD
```

`sous show <run> --json` lists each step with its status, time and tokens. `--full` adds the
whole record. `sous log <run>` prints what each step said.

## The report

Tell the person:

- what the run claims, from `result`;
- what you checked yourself, such as the diff or a test you ran;
- what you did not check;
- the branch and the worktree.

Never merge, push or discard unless the person asks.

## Clean up when asked

```sh
sous discard <run> --json
sous discard <run> --yes --json
sous gc --dry-run --json
```

`discard` without `--yes` lists the branches and worktrees it would delete, and deletes nothing.
With `--yes` it deletes them, merged or not. `gc` removes only worktrees whose branch is merged.
A run that completed and changed no file has no worktree left.

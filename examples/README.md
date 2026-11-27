# Examples

`textkit/` is a small Node library with two known bugs, three tickets and an inbox. Its
`.sous/workflows/` folder holds three workflows, and `.rulesync/subagents/` the agents
they use, in rulesync's format. Each agent runs on Claude Code with haiku, to keep the runs cheap.
`docs/proof/` has real runs of all three.

Set up a copy, since the ticket workflow needs a git repo to branch from:

```sh
examples/setup-textkit.sh ~/textkit
cd ~/textkit
```

## The ticket workflow

`ticket.js` implements one ticket in a worktree of its own. When the implementer says it is done,
`npm test` runs, and a failure goes back to it in its own session. Once the tests pass, a fresh
reviewer reads the diff. Until it approves, its review goes back to the implementer the same way,
for at most `--rounds` reviews. `--turns` caps the implementer's turns, 20 by default. A verifier
then tries the cases, and the workflow commits on the run's branch only when the reviewer
approved, the verifier passed it and `npm test` passes.

```sh
sous run ticket --ticket "$(cat tickets/TK-1.md)" --rounds 3 --wait
sous show <run>
```

`--reviewer strict-reviewer` swaps in a reviewer with a higher bar on edge cases, which usually
sends the first change back.

To try a workflow without real agents, which costs nothing, add `--dry-run` to `sous check`:

```sh
sous check ticket --ticket "$(cat tickets/TK-1.md)" --dry-run
```

## The factory

`factory.js` takes open tickets labelled `Bug` from Linear when `LINEAR_API_KEY` is set, in the
environment or in `~/.sous/secrets.env`. Without a key it reads `tickets/`. A triager agent
reads each ticket and picks the next step: build it with the ticket workflow, nested, in a worktree
of its own, or skip it for a person to clarify. Two tickets run at once.

```sh
sous run factory --wait
sous run factory --team ENG --label Bug --limit 5   # with a Linear key
```

`TK-3` is too vague on purpose. The triager should skip it.

## Emails

`emails.js` reads `mail/inbox.json`, sorts the emails into those that need a reply and those that
don't, and drafts the replies in parallel. Then it stops for your approval:

```sh
sous run emails
sous inbox
sous approve <question>                       # keep the drafts
sous send-back <question> "Shorter, please"   # redraft them with this note
```

The approved drafts go to `drafts.md` in the run's scratch folder. Nothing is sent. Reading a
real mailbox, such as Gmail, needs its connection set up first.

## The build

`build/.sous/workflows/build.js` builds one stage of a project from its design. A planner cuts the
design into tickets and names the stage's gates. Each ticket starts once the tickets it needs have
landed, in a worktree of its own. Its implementer writes the tests first, gives their failing
output, and works until it says done. Then the stage's tests run, and a reviewer of its own reads
the change. A test failure or the reviewer's blockers go back to the implementer in its own
session.

After `--rounds` rounds of blockers, or when the implementer is stuck, a fresh implementer takes
the ticket in the same folder. When that one fails too, the ticket parks on its branch, and the
tickets that need it are skipped. A ticket that passes lands on the run's branch as one commit,
rebased on the tickets that landed before it. A conflict goes back to its implementer to rebase.
Last, a verifier proves each gate with a script in `proofs/`. A proof that fails because of the
build gets one fix ticket, then its script runs again.

The workflow names four agents, `build-planner`, `implementer`, `reviewer` and `verifier`, which
the project or your home must define. `--planner`, `--implementer`, `--reviewer` and `--verifier`
name others. Three steps run at once. Copy the file into a project, or into `~/.sous/workflows/`
for every project:

```sh
cp examples/build/.sous/workflows/build.js ~/app/.sous/workflows/
cd ~/app
sous check build --design docs/stage-2.md --dry-run
sous run build --design docs/stage-2.md --wait
```

The result lists each ticket as landed, parked with why and its branch, or skipped. It lists each
gate as passed, failed, waiting for a person with the steps to take, or blocked by a ticket that
did not land.

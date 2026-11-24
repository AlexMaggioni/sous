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

`ticket.js` implements one ticket in a worktree of its own. A reviewer reads the diff. Until it
approves, its review goes to the implementer as plain text, in the implementer's own session, for
at most `--rounds` rounds. A verifier then tries the cases, and the workflow commits on the run's
branch only when the reviewer approved, the verifier passed it and `npm test` passes.

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

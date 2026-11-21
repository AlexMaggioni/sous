# Examples

`textkit/` is a small Node library with two known bugs, three tickets and an inbox. Its
`.orchestrator/` folder holds three workflows and the agents they use. Each agent runs on
`claude/haiku`, to keep the runs cheap. `docs/proof/` has real runs of all three.

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
orc run ticket --ticket "$(cat tickets/TK-1.md)" --rounds 3 --wait
orc show <run>
```

`--reviewer strict-reviewer` swaps in a reviewer with a higher bar on edge cases, which usually
sends the first change back.

## The factory

`factory.js` takes open tickets labelled `Bug` from Linear when `LINEAR_API_KEY` is set, in the
environment or in `~/.orchestrator/secrets.env`. Without a key it reads `tickets/`. A triager agent
reads each ticket and picks the next step: build it with the ticket workflow, nested, in a worktree
of its own, or skip it for a person to clarify. Two tickets run at once.

```sh
orc run factory --wait
orc run factory --team ENG --label Bug --limit 5   # with a Linear key
```

`TK-3` is too vague on purpose. The triager should skip it.

## Emails

`emails.js` reads `mail/inbox.json`, sorts the emails into those that need a reply and those that
don't, and drafts the replies in parallel. Then it stops for your approval:

```sh
orc run emails
orc inbox
orc approve <question>                       # keep the drafts
orc send-back <question> "Shorter, please"   # redraft them with this note
```

The approved drafts go to `drafts.md` in the run's scratch folder. Nothing is sent. Reading a
real mailbox, such as Gmail, needs its connection set up first.

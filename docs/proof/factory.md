# Proof: the factory

Run on 2026-11-21 with real agents on `claude/haiku`, in a copy of `examples/textkit` made by
`examples/setup-textkit.sh`. Paths are shortened to `~/.orchestrator` and `~/textkit`.

No Linear key was set, so the factory read the three tickets in `tickets/`. `TK-1` and `TK-2` are
the clear bugs of the ticket workflow's proof. `TK-3` is vague on purpose:

```
# Text looks off sometimes

Some outputs look weird. Please fix.
```

```sh
orc run factory
```

A triager judged each ticket and picked the next step. It sent `TK-1` and `TK-2` to the ticket
workflow, each nested in a worktree and branch of its own, two at once, and skipped `TK-3`.

`orc show`, which lists each nested run's steps under its ticket:

```
factory  mwqugabi-1zzc2t
status    completed
place     folder  ~/textkit
started   2026-11-21T20:11:53.790Z  by cli
inputs    {"team":"","label":"Bug","limit":5,"rounds":2}
tokens    1286910  in 174s
steps
  done  fetch tickets  (0s)  exec
  done  triage TK-1  (20s, 59524 tokens)  haiku
  done  triage TK-2  (20s, 59598 tokens)  haiku
  done  triage TK-3  (12s, 53041 tokens)  haiku
  TK-1  (workflow ticket, branch orc/mwqugabi-1zzc2t-nested1)
    done  implementer  (50s, 257341 tokens)  haiku
    done  diff 1  (0s)  exec
    done  reviewer 1  (34s, 93972 tokens)  haiku
    done  tests  (0s)  exec
    done  verifier  (50s, 190136 tokens)  haiku
    done  commit  (0s)  exec
  TK-2  (workflow ticket, branch orc/mwqugabi-1zzc2t-nested2)
    done  implementer  (51s, 258438 tokens)  haiku
    done  diff 1  (0s)  exec
    done  reviewer 1  (33s, 123745 tokens)  haiku
    done  tests  (1s)  exec
    done  verifier  (56s, 191115 tokens)  haiku
    done  commit  (0s)  exec
```

The result, without the verifiers' evidence:

```json
{
  "tickets": [
    {
      "id": "TK-1",
      "title": "wordCount says an empty text has one word",
      "choice": "build",
      "reason": "The ticket specifies the current behavior (returns 1), the expected behavior (returns 0), and provides concrete test cases with exact expected outputs for empty strings, space-only strings, and strings with leading/trailing spaces, giving a developer everything needed to implement and verify the fix.",
      "result": {
        "approved": true,
        "verified": true,
        "rounds": 1,
        "commit": "760de64"
      }
    },
    {
      "id": "TK-2",
      "title": "slugify leaves a dash at the end",
      "choice": "build",
      "reason": "The ticket specifies the exact problem (trailing dashes), the expected output for two concrete test cases, and an explicit rule (slugs never start or end with dashes), giving the developer everything needed to reproduce, fix, and verify the fix.",
      "result": {
        "approved": true,
        "verified": true,
        "rounds": 1,
        "commit": "5438ce8"
      }
    },
    {
      "id": "TK-3",
      "title": "Text looks off sometimes",
      "choice": "skip",
      "reason": "The ticket provides no specifics about which outputs are affected, what 'weird' means, what the correct output should be, or any examples to reproduce or verify the issue.",
      "result": {
        "skipped": true
      }
    }
  ]
}
```

`orc log`:

```
20:11:57 run        factory in ~/textkit
20:11:57 start      fetch tickets (exec)
20:11:57 done       fetch tickets
20:11:57 log        3 tickets
20:11:57 start      triage TK-1 (claude/haiku)
20:11:57 start      triage TK-2 (claude/haiku)
20:12:17 done       triage TK-1, 59524 tokens
20:12:17 start      triage TK-3 (claude/haiku)
20:12:17 phase      implement
20:12:17 done       triage TK-2, 59598 tokens
20:12:17 start      implementer (claude/haiku)
20:12:17 phase      implement
20:12:29 done       triage TK-3, 53041 tokens
20:12:29 start      implementer (claude/haiku)
20:13:07 done       implementer, 257341 tokens
20:13:07 phase      review
20:13:07 start      diff 1 (exec)
20:13:07 done       diff 1
20:13:07 start      reviewer 1 (claude/haiku)
20:13:20 done       implementer, 258438 tokens
20:13:20 phase      review
20:13:20 start      diff 1 (exec)
20:13:20 done       diff 1
20:13:20 start      reviewer 1 (claude/haiku)
20:13:42 done       reviewer 1, 93972 tokens
20:13:42 log        review 1: approved
20:13:42 phase      verify
20:13:42 start      tests (exec)
20:13:42 done       tests
20:13:42 start      verifier (claude/haiku)
20:13:53 done       reviewer 1, 123745 tokens
20:13:53 log        review 1: approved
20:13:53 phase      verify
20:13:53 start      tests (exec)
20:13:55 done       tests
20:13:55 start      verifier (claude/haiku)
20:14:32 done       verifier, 190136 tokens
20:14:32 start      commit (exec)
20:14:32 done       commit
20:14:51 done       verifier, 191115 tokens
20:14:51 start      commit (exec)
20:14:51 done       commit
20:14:54 completed  factory
```

The two tickets ran at once, so their lines interleave, and this log doesn't say which ticket a
line belongs to. Since this run, each line of a nested run starts with its label, such as
`start      TK-1: implementer (claude/haiku)`.

The project's `main` is unchanged. Each built ticket is one commit on its own branch, ready for
review:

```
$ git log --format='%h %s' main..orc/mwqugabi-1zzc2t-nested1
760de64 wordCount says an empty text has one word
 src/textkit.js       |  3 ++-
 test/textkit.test.js | 12 ++++++++++++
 2 files changed, 14 insertions(+), 1 deletion(-)

$ git log --format='%h %s' main..orc/mwqugabi-1zzc2t-nested2
5438ce8 slugify leaves a dash at the end
 src/textkit.js       | 2 +-
 test/textkit.test.js | 8 ++++++++
 2 files changed, 9 insertions(+), 1 deletion(-)

$ git worktree list
~/textkit                                     69e1fb2 [main]
~/.orchestrator/worktrees/mwqugabi-1zzc2t-nested1  760de64 [orc/mwqugabi-1zzc2t-nested1]
~/.orchestrator/worktrees/mwqugabi-1zzc2t-nested2  5438ce8 [orc/mwqugabi-1zzc2t-nested2]
```

## The bug this run found

The first factory run, `mwqu22yh-ijyo2j`, failed in the verify phase with
`sh(command) needs a command string`. A nested `workflow("ticket", { ticket, rounds })` ran with
only the args the factory passed, so the ticket workflow had no `test` command and no `reviewer`
agent. Nested workflows now get the defaults of their inputs, as a run started from the command
line does, and a missing input fails the call. The run above is the rerun after that fix.

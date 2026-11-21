# Proof: sorting emails and drafting replies

Run on 2026-11-21 with real agents on `claude/haiku`, in a copy of `examples/textkit`. The inbox is
`mail/inbox.json`: five emails, two of them a newsletter and a CI notice. Paths are shortened to
`~/.orchestrator`. Nothing is sent: the approved drafts go to a file.

```sh
orc run emails
```

The run works in an empty scratch folder, since email touches no repo. It read the mailbox from
the project folder, sorted it, drafted three replies at once and stopped for approval. `orc inbox`:

```
mwquh6pe-ty2kgu--5  emails  7s ago
  Breakpoint: Approve these replies
  
  To: Dana Okafor <dana@northwind.example>
  Subject: Re: Team plan pricing
  
  Hi Dana,
  
  Thanks for reaching out! We're glad you're interested in textkit for your team.
  
  We do have options for teams, and I'd like to get you accurate pricing for a group of 12. I'll come back to you shortly with details on our team plan and per-seat costs.
  
  Best,
  The textkit team
  
  ---
  
  To: Sam Rivera <sam@textkit.example>
  Subject: Re: Move our sync to Thursday?
  
  Hey Sam,
  
  No problem—Thursday at 2pm works great. See you then.
  
  The textkit team
  
  ---
  
  To: Lee Chen <lee@example.org>
  Subject: Re: slugify bug
  
  Hi Lee,
  
  Thanks for the report! That trailing dash doesn't look right to us either. We'll dig into it and get back to you with what we find.
  
  Glad you're enjoying the library otherwise.
  
  The textkit team
  
  Reply approve, stop, or send back with a note.
```

The drafts were too long, so they went back with a note:

```sh
orc send-back mwquh6pe-ty2kgu--5 "Shorter, two sentences at most"
```

The three drafts ran again with the note, and the run stopped again. `orc inbox`:

```
mwquh6pe-ty2kgu--9  emails  7s ago
  Breakpoint: Approve these replies
  
  To: Dana Okafor <dana@northwind.example>
  Subject: Re: Team plan pricing
  
  Thanks for your interest in textkit for your team! I'll get back to you shortly with details on our team plan and per-seat pricing.
  
  The textkit team
  
  ---
  
  To: Sam Rivera <sam@textkit.example>
  Subject: Re: Move our sync to Thursday?
  
  Thursday at 2pm works perfectly. We'll send you an updated calendar invite.
  
  The textkit team
  
  ---
  
  To: Lee Chen <lee@example.org>
  Subject: Re: slugify bug
  
  Thanks for the report and kind words! We'll investigate that trailing dash and come back to you.
  
  The textkit team
  
  Reply approve, stop, or send back with a note.
```

```sh
orc approve mwquh6pe-ty2kgu--9
```

`orc log`:

```
20:12:37 run        emails in ~/.orchestrator/scratch/mwquh6pe-ty2kgu
20:12:37 start      read mailbox (exec)
20:12:38 done       read mailbox
20:12:38 start      sort (claude/haiku)
20:12:50 done       sort, 30068 tokens
20:12:50 start      draft m1 (claude/haiku)
20:12:50 start      draft m3 (claude/haiku)
20:12:50 start      draft m5 (claude/haiku)
20:12:50 queued     draft m5 waits for a free agent slot
20:13:01 done       draft m1, 29254 tokens
20:13:02 done       draft m3, 29305 tokens
20:13:08 done       draft m5, 27701 tokens
20:13:08 question   mwquh6pe-ty2kgu--5: Breakpoint: Approve these replies [...]
           answer with: orc approve mwquh6pe-ty2kgu--5  |  orc send-back mwquh6pe-ty2kgu--5 "note"  |  orc stop mwquh6pe-ty2kgu
20:13:42 answered   mwquh6pe-ty2kgu--5: {"decision":"send back","note":"Shorter, two sentences at most"}
20:13:42 start      draft m1 again (claude/haiku)
20:13:42 start      draft m3 again (claude/haiku)
20:13:42 start      draft m5 again (claude/haiku)
20:13:42 queued     draft m5 again waits for a free agent slot
20:13:54 done       draft m1 again, 27221 tokens
20:13:54 done       draft m3 again, 27342 tokens
20:14:05 done       draft m5 again, 29469 tokens
20:14:05 question   mwquh6pe-ty2kgu--9: Breakpoint: Approve these replies [...]
           answer with: orc approve mwquh6pe-ty2kgu--9  |  orc send-back mwquh6pe-ty2kgu--9 "note"  |  orc stop mwquh6pe-ty2kgu
20:14:23 answered   mwquh6pe-ty2kgu--9: "approve"
20:14:23 start      save drafts (exec)
20:14:23 done       save drafts
20:14:23 completed  emails
```

Each time, the third draft waited for a free agent slot. The factory ran in another project at the
same time with two agents, and `maxAgents` caps the agents at four across all runs.

`orc show`, without the result:

```
emails  mwquh6pe-ty2kgu
status    completed
place     none  ~/.orchestrator/scratch/mwquh6pe-ty2kgu
started   2026-11-21T20:12:35.762Z  by cli
inputs    {"mailbox":"mail/inbox.json"}
tokens    200360  in 105s
steps
  done  read mailbox  (0s)  exec
  done  sort  (12s, 30068 tokens)  haiku
  done  draft m1  (11s, 29254 tokens)  haiku
  done  draft m3  (12s, 29305 tokens)  haiku
  done  draft m5  (18s, 27701 tokens)  haiku
  done  draft m1 again  (12s, 27221 tokens)  haiku
  done  draft m3 again  (12s, 27342 tokens)  haiku
  done  draft m5 again  (23s, 29469 tokens)  haiku
  done  save drafts  (0s)  exec
```

The result's `skipped` list, with the sorter's reasons:

```json
[
  { "id": "m2", "reply": false, "why": "This is an automated newsletter, not a person asking for anything." },
  { "id": "m4", "reply": false, "why": "This is an automated CI notification from GitHub, not a person asking a question." }
]
```

`drafts.md` in the run's scratch folder, `~/.orchestrator/scratch/mwquh6pe-ty2kgu/`:

```
To: Dana Okafor <dana@northwind.example>
Subject: Re: Team plan pricing

Thanks for your interest in textkit for your team! I'll get back to you shortly with details on our team plan and per-seat pricing.

The textkit team

---

To: Sam Rivera <sam@textkit.example>
Subject: Re: Move our sync to Thursday?

Thursday at 2pm works perfectly. We'll send you an updated calendar invite.

The textkit team

---

To: Lee Chen <lee@example.org>
Subject: Re: slugify bug

Thanks for the report and kind words! We'll investigate that trailing dash and come back to you.

The textkit team
```

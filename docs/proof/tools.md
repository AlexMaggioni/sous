# Proof: an agent's tool lists

Run on 2026-11-21 with real agents on `claude/haiku`. The Claude Code settings on this machine use
bypass mode and allow Bash, so the agent never asks for permission. Before this fix, a
`disallowedTools: [Bash]` agent ran `ls -la` anyway, since orc only applied the lists to permission
requests, and none came. orc now passes both lists to the Claude adapter.

Two agents:

```md
---
name: nobash
model: claude/haiku
disallowedTools: [Bash]
---
```

```md
---
name: readonly
model: claude/haiku
tools: [Read, Grep, Glob]
---
```

Each got the same task: "Run the shell command `ls -la` with the Bash tool and report its first
line. If the Bash tool is refused or not available, say so plainly and stop." The second step also
had a schema, to check that structured answers still work with an allow list.

`orc show`:

```
refusal  mwqw8ty4-xfm3nj
status    completed
place     none  ~/.orchestrator/scratch/mwqw8ty4-xfm3nj
tokens    206880  in 33s
steps
  done  deny list  (12s, 27328 tokens)  haiku
  done  allow list  (21s, 179552 tokens)  haiku
result
{
  "denied": "The Bash tool is not available in my current tool set. I cannot run the command `ls -la` as requested.",
  "allowed": {
    "ranBash": false,
    "note": "The Bash tool is not available in my tool list. Shell execution is not supported in this environment."
  }
}
```

Before the fix, the same `nobash` step returned:

```
The Bash tool executed successfully. The first line of output is:

total 0
```

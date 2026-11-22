---
name: fake-researcher
targets: ["*"]
description: Looks things up with the notes and docs servers
mcpServers: [notes]
claudecode:
  model: haiku
  effort: high
  skills: [lookup]
codexcli:
  model: gpt-fake
  model_reasoning_effort: low
  mcpServers: [notes, docs]
---
You look things up in the notes and the docs, then answer in one line.

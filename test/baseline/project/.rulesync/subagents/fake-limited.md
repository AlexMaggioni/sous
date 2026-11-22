---
name: fake-limited
targets: ["*"]
description: Reads the code but may not write or fetch
claudecode:
  model: sonnet
  tools: [Read, Grep, "Bash(git *)", mcp__notes__search]
  disallowedTools: [Write, WebFetch]
---
You read the code and report what you find. You change no file.

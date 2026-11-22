# Proof: the installed Claude Code and Codex

Run on 2026-11-22 (UTC) with real agents, on this machine's Claude and ChatGPT subscriptions. orc
no longer bundles Claude Code or Codex. It runs the ones installed on the machine: Claude Code
2.1.329 at `~/.local/bin/claude`, and Codex 0.169.0 at `/opt/homebrew/bin/codex`. Nothing was set
by hand. Every run below had no `CLAUDE_CODE_EXECUTABLE`, no `CODEX_PATH` and no API key. Scratch
folders are written `$I` and `$S`. `$S` holds the projects of the [shared layer proof](shared.md).

## One step on each program

`$I/p1/.orchestrator/workflows/installed.js`:

```js
const ask = "Answer with the single word OK."
const [claude, codex, codexLow] = await parallel([
  () => agent(ask, { label: "claude code on haiku", model: "claude/haiku" }),
  () => agent(ask, { label: "codex on gpt-6.1-sol", model: "codex/gpt-6.1-sol" }),
  () => agent(ask, { label: "codex on gpt-6.1-sol, low effort", model: "codex/gpt-6.1-sol", effort: "low" }),
])
return { claude, codex, codexLow }
```

```sh
env -u CLAUDE_CODE_EXECUTABLE -u CODEX_PATH -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CODEX_API_KEY \
  orc run installed --wait
```

```
path variables and API keys set: 0
04:56:34 run        installed in $I/p1
04:56:34 start      claude code on haiku (claude/haiku)
04:56:34 program    Claude Code 2.1.329 at ~/.local/bin/claude
04:56:34 start      codex on gpt-6.1-sol (codex/gpt-6.1-sol)
04:56:34 program    Codex 0.169.0 at /opt/homebrew/bin/codex
04:56:34 start      codex on gpt-6.1-sol, low effort (codex/gpt-6.1-sol)
04:56:40 done       codex on gpt-6.1-sol, 20332 tokens
04:56:42 done       codex on gpt-6.1-sol, low effort, 20335 tokens
04:56:44 done       claude code on haiku, 38847 tokens
04:56:47 completed  installed
result:
{
  "claude": "OK",
  "codex": "OK",
  "codexLow": "OK"
}
```

`orc show mwrd70le-x8xuf5` keeps the programs with the run:

```
installed  mwrd70le-x8xuf5
status    completed
place     folder  $I/p1
started   2026-11-22T04:56:33.986Z  by cli
program   Claude Code 2.1.329  ~/.local/bin/claude
program   Codex 0.169.0  /opt/homebrew/bin/codex
tokens    79514  in 11s
steps
  done  claude code on haiku  (11s, 38847 tokens)  claude/haiku
  done  codex on gpt-6.1-sol  (6s, 20332 tokens)  codex/gpt-6.1-sol
  done  codex on gpt-6.1-sol, low effort  (8s, 20335 tokens)  codex/gpt-6.1-sol
```

The programs' own logs of these steps agree:

- Claude Code's session log: version 2.1.329, model claude-haiku-5-5.
- Codex's two rollouts: cli_version 0.169.0, originator agentprism-workflows, model gpt-6.1-sol.
  The step with no effort ran at high, the other at low.

## gpt-6.1-sol in an agent's block

In the shared layer proof, the reviewer's Codex block had to move off gpt-6.1-sol, because the
bundled Codex 0.156.1 failed on it with "Invalid params". The block names it again:

```md
codexcli:
  model: gpt-6.1-sol
  model_reasoning_effort: low
```

The same `orc run review-both --wait` in `$S/g1`, with `{ "rulesyncGlobal": "$S/aiglobal" }` in
`~/.orchestrator/config.json`, removed afterwards. `orc show mwrd8t6d-jf8ph0`:

```
review-both  mwrd8t6d-jf8ph0
status    completed
place     folder  $S/g1
started   2026-11-22T04:57:57.685Z  by cli
program   Claude Code 2.1.329  ~/.local/bin/claude
program   Codex 0.169.0  /opt/homebrew/bin/codex
tokens    59720  in 10s
steps
  done  diff  (0s)  exec
  done  review on claude code  (10s, 39265 tokens)  claude/haiku
  done  review on codex  (6s, 20455 tokens)  codex/gpt-6.1-sol
result
{
  "claude": "The change is correct: `add(a, b)` now returns `a + b`, which is what the function name and the stated intent call for. The diff is the whole change, and I did not check callers or tests beyond what the diff shows.\n\nAPPROVED",
  "codex": "The change is correct: `add(a, b)` now returns the sum instead of the difference.\nAPPROVED"
}
```

## An agent's own skill and MCP server

The word-teller case of the shared layer proof, unchanged, in `$S/textkit`:

```sh
CODEX_HOME=$S/codex-home orc run word --wait
```

Run mwrd9mcm-87wx4t:

```
"claude": "WORD: ORCHID\n\nSigned off in the textkit house style, mark PLUM-HARBOR.",
"codex": "I’ll read the textkit sign-off instructions, then call the word server and report its result.\n\nWORD: ORCHID\n\nSigned off in the textkit house style, mark PLUM-HARBOR.",
"claudeOwn": "WORD: DECOY\n\nThe tool returned \"DECOY\" as its word. ...",
"codexOwn": "I’ll look up the deferred wordsrv tool and call `get_word`; I won’t modify any files.\n\nWORD: DECOY"
```

Both programs read ORCHID from the rulesync server and signed off with the skill. Each program's
own `wordsrv` answered DECOY when orc gave it no server.

The Claude Code session logs of the review and word runs show version 2.1.329 and model
claude-haiku-5-5. Those of the shared layer proof show 2.1.281 and claude-haiku-4-5-20251001.

## Programs and harness folders stay as they were

Two checksum lists:

- `$I/programs-sums.sh` covers the program files: Claude Code's binary, the npm package behind
  `/opt/homebrew/bin/codex`, and the other Codex at `~/.local/bin/codex`. It also covers each file
  in `~/.codex/skills/.system`, and the date of that folder's marker file. 98 lines.
- `$S/sums.py`, from the shared layer proof, covers each agent, skill and MCP config file of the
  harnesses, in the projects and in the home folder. That includes `~/.claude/skills`, with Claude
  Code's `synced/<account>/.last-complete-round` files. 2820 lines.

Both lists were taken before the first run above and again after the last check on this page.
`diff` printed nothing for either. `~/.codex/skills/.system` kept its marker date, which is older
than every run here. In the shared layer proof, the bundled Codex rewrote that folder during its
first review.

The word case ran with the scratch Codex home, which the final lists leave out. Its
`skills/.system` changed once, during that run: Codex 0.169.0 replaced the set that the bundled
0.156.1 had left there. The 49 files now match `~/.codex/skills/.system`.

## orc doctor

```sh
env -u CLAUDE_CODE_EXECUTABLE -u CODEX_PATH orc doctor
```

It exits with 0:

```
Claude Code 2.1.329
  program   ~/.local/bin/claude, found on PATH
  skipped   ~/.paradev/bin/claude, a wrapper script
  account   ~/.claude (set CLAUDE_CONFIG_DIR where orc starts to use another)
  talks     yes, default model opus
  models    default (Default (recommended)), opus (Opus 5.5), fable (Fable 5.2), sonnet (Sonnet 5.5), haiku (Haiku 5.5), ...
Codex 0.169.0
  program   /opt/homebrew/bin/codex, found on PATH
  skipped   ~/.paradev/bin/codex, a wrapper script
  also      ~/.local/bin/codex 0.166.0, not used
  account   ~/.codex (set CODEX_HOME where orc starts to use another)
  talks     yes, default model gpt-6.1-sol
  models    gpt-6.2-sol (6.2 Sol), gpt-6.2-astra (6.2 Astra), gpt-6.1-terra (6.1 Terra), gpt-6.1-sol (6.1 Sol), ...
```

With `CODEX_PATH=/nope/codex`, it exits with 1, and the Codex part reads:

```
Codex
  missing   CODEX_PATH is /nope/codex, which is not a program file. Point it at Codex, or remove it.
```

## Dry runs need neither program

The three examples' dry runs, with `PATH=/usr/bin:/bin` and node called by its full path, so
neither program could be found:

```
ticket:  dry run completed, with 3 agent steps answered by stand-ins
factory: dry run completed, with 12 agent steps answered by stand-ins
emails:  dry run completed, with 1 agent step answered by stand-ins
```

None printed a program line. A dry run never looks for a program.

## Tests and size

- `pnpm build` and `pnpm typecheck` pass.
- orc: 57 tests pass. acp-agents: 847 pass, 10 skipped.
- codex-acp's tests that talk to a real Codex now run the installed one. They ran with
  `CODEX_PATH=/opt/homebrew/bin/codex`, because the first `codex` on this machine's PATH is a
  wrapper script: 798 pass, 32 skipped, the same as on the bundled Codex. CI leaves them out, as
  before.
- `node_modules/.pnpm` went from 917 MB to 395 MB without the two programs.

## What stays the same

Each Codex rewrites `skills/.system` in its home when that set came from another version. With
several Codex installs on one machine, the one that ran last wins. orc runs one of them, the one
`orc doctor` names, and lists the others under "also". On this machine, that is
`~/.local/bin/codex` 0.166.0.

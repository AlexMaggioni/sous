# Proof: the shared layer

Run on 2026-11-21 and 2026-11-22 (UTC) with real agents: Claude Code with haiku, and Codex with
gpt-6-luna, on this machine's Claude and ChatGPT subscriptions. No API key was set. Each case ran
in a scratch folder, written `$S` below. `$S/aiglobal` stood in for the global rulesync folder,
through `{ "rulesyncGlobal": "$S/aiglobal" }` in `~/.orchestrator/config.json`, which was removed
afterwards. OpenCode stayed out of the runs.

## One agent on two harnesses

One agent in the global folder, `$S/aiglobal/.rulesync/subagents/reviewer.md`:

```md
---
name: reviewer
description: Reviews one change and approves it or asks for changes
targets: ["*"]
claudecode:
  model: haiku
codexcli:
  model: gpt-6-luna
  model_reasoning_effort: low
---
You review one change. The diff is in the prompt. Do not change any file. Say in two sentences at
most whether the change is correct, then end with one line: APPROVED or CHANGES.
```

`$S/aiglobal/rulesync.jsonc` holds `{ "global": true, ... }`. The project `$S/g1` has no agent of
its own. Its workflow sends the same diff to the reviewer twice:

```js
const [claude, codex] = await parallel([
  () => agent(prompt, { agentType: "reviewer", label: "review on claude code" }),
  () => agent(prompt, { agentType: "reviewer", label: "review on codex", model: "codex" }),
])
```

```sh
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CODEX_API_KEY orc run review-both --wait
```

The environment had no API key ("API keys set: 0"). `orc show`:

```
review-both  mwr2mbcq-m941d0
status    completed
place     folder  $S/g1
tokens    51630  in 13s
steps
  done  diff  (0s)  exec
  done  review on claude code  (13s, 29216 tokens)  claude/haiku
  done  review on codex  (7s, 22414 tokens)  codex/gpt-6-luna
result
{
  "claude": "The function `add()` was incorrectly performing subtraction. This change fixes it by replacing the `-` operator with `+`, making the function behave as its name indicates.\n\nAPPROVED",
  "codex": "The change correctly fixes `add()` to return the sum of its arguments.  \nAPPROVED"
}
```

Two things came out of this case:

- The first try failed on Codex with "Invalid params". The Codex block then named gpt-6.1-sol, the
  model in this machine's `~/.codex/config.toml`. codex-acp runs the Codex it bundles, which
  doesn't offer that model. The last section shows the way around it.
- `orc show` printed a step's model without its harness, such as `haiku`. It now prints both, also
  when the agent's block picked the model.

## The lookup order

Three files define `reviewer`, each with its own word:

- `$S/g2/.rulesync/subagents/reviewer.md` says PROJECT;
- `$S/aiglobal-g2/.rulesync/subagents/reviewer.md` says GLOBAL, with `rulesyncGlobal` set to
  `$S/aiglobal-g2`;
- `$S/g2/.claude/agents/reviewer.md` says FOLDER.

The workflow asks the reviewer for its word. It ran three times. Before the second run the project
file was moved aside, and before the third the global file too:

```
== all three files
00:01:13 start      reviewer (claude/haiku)
00:01:28 completed  which
result:
PROJECT
== project file removed
00:01:31 start      reviewer (claude/haiku)
00:01:46 completed  which
result:
GLOBAL
== global file removed too
00:01:48 start      reviewer (claude/haiku)
00:02:00 completed  which
result:
FOLDER
```

The files were put back afterwards.

## Agents from a harness's own folder

`stylist` is only in a Codex home, `$S/codex-home/agents/stylist.toml`, with the word CODEX-HOME.
`pair-reviewer` is in two project folders: `.claude/agents/` with the word CLAUDE-COPY, and
`.codex/agents/` with CODEX-COPY. No step names a harness:

```js
const [stylist, pair] = await parallel([
  () => agent("Give your word.", { agentType: "stylist", label: "stylist" }),
  () => agent("Give your word.", { agentType: "pair-reviewer", label: "pair-reviewer" }),
])
```

With Claude Code as the default harness:

```sh
CODEX_HOME=$S/codex-home orc run folders --wait
```

```
00:02:27 start      stylist
00:02:27 start      pair-reviewer (claude/haiku)
00:02:41 completed  folders
result:
{
  "stylist": "CODEX-HOME",
  "pair": "CLAUDE-COPY"
}
```

The stylist ran on Codex, the only harness that has it, and `orc show` lists it as `codex`. The
pair reviewer gave the Claude Code copy. With `"defaultHarness": "codex"` in `config.json`, the
same run gave the Codex copy:

```
{
  "stylist": "CODEX-HOME",
  "pair": "CODEX-COPY"
}
```

The scratch Codex home links to `~/.codex/auth.json` for the login. The checksum of that file was
the same before and after.

## Workflows that can't run

Four workflows in `$S/g4`:

- `wrong-harness` sends `fixer`, from `.codex/agents/fixer.toml`, to `claude/haiku`;
- `two-folders` names `dual`, which is in `.codex/agents/` and `.opencode/agents/` but not in
  Claude Code's folder, and Claude Code is the default harness;
- `pick-later` picks the harness from an input: `model: args.harness`;
- `ghost` names an agent nobody wrote.

```
$ orc check wrong-harness
  problem: agent "fixer" comes from $S/g4/.codex/agents/fixer.toml, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code. Move it to rulesync, as .rulesync/subagents/fixer.md in the project or in the global rulesync folder, so one file serves every harness.

$ orc check two-folders
  problem: agent "dual" is in $S/g4/.codex/agents/dual.toml and $S/g4/.opencode/agents/dual.md, not in rulesync, and Claude Code, the default harness, has no copy. Move it to rulesync, as .rulesync/subagents/dual.md in the project or in the global rulesync folder, so one file serves every harness.

$ orc check pick-later
  note: a step with agent "fixer" picks its harness while running. The agent comes from $S/g4/.codex/agents/fixer.toml, so the step stops on any harness but Codex.
ok

$ orc check ghost
  problem: no agent "ghost". orc looks in .rulesync/subagents/, then the global rulesync folder ($S/aiglobal/.rulesync/subagents/), then .claude/agents/, .codex/agents/ and .opencode/agents/ in the project and in the home folder.
```

`orc check` exited with 1 for wrong-harness, two-folders and ghost. It exited with 0 for
pick-later, which can still run on Codex. Run with `--harness claude`, pick-later stops on the
step with the same message, without a retry:

```
23:51:24 start      fixer (claude)
23:51:24 log        step "fixer" failed and a retry cannot fix it: step "fixer": agent "fixer" comes from $S/g4/.codex/agents/fixer.toml, a Codex folder, so it runs only on Codex, ...
23:51:24 paused     pick-later (step_failed)
```

## An agent's own skill and MCP server

`$S/textkit/.rulesync/subagents/word-teller.md`:

```md
---
name: word-teller
description: Reports its MCP server's word and signs off with its skill
targets: ["*"]
skills: [textkit-style]
mcpServers: [wordsrv]
claudecode:
  model: haiku
codexcli:
  model: gpt-6-luna
  model_reasoning_effort: low
---
Call the get_word tool of the wordsrv MCP server. Report the word it returns on a line of its own,
as WORD: <word>. Then sign off as the textkit-style skill says. Do not change any file.
```

- `.rulesync/mcp.jsonc` defines `wordsrv`, a small stdio server whose one tool returns ORCHID.
- The skill `textkit-style` says to end with "Signed off in the textkit house style, mark
  PLUM-HARBOR." `npx rulesync generate` copied it to `.claude/skills/` and `.agents/skills/`, as a
  user would.
- Each harness has its own `wordsrv` too, which returns DECOY: `.mcp.json` for Claude Code, and the
  Codex home's `config.toml` for Codex.

The workflow runs the agent on both harnesses. Then it asks each harness for its own `wordsrv`,
with no agent and no server from orc:

```js
const [claude, codex] = await parallel([
  () => agent(ask, { agentType: "word-teller", label: "word-teller on claude code" }),
  () => agent(ask, { agentType: "word-teller", label: "word-teller on codex", model: "codex" }),
])
const [claudeOwn, codexOwn] = await parallel([
  () => agent(own, { label: "own server on claude code", model: "claude/haiku" }),
  () => agent(own, { label: "own server on codex", model: "codex" }),
])
```

```sh
CODEX_HOME=$S/codex-home orc run word --wait
```

The first run, trimmed:

```
"claude": "... WORD: ORCHID\n\nSigned off in the textkit house style, mark PLUM-HARBOR.",
"codex": "... WORD: DECOY\n\nSigned off in the textkit house style, mark PLUM-HARBOR.",
"claudeOwn": "NO TOOL\n\nThe wordsrv MCP server's get_word tool is not currently available.",
"codexOwn": "... WORD: DECOY"
```

On Codex the harness's own server won. codex-acp dropped a requested server whenever Codex's config
had one with the same name, so that Codex never merges a url server with a command server. It now
drops it only when the two use different transports. A command server from rulesync replaces a
command server of the same name.

Claude Code loads a project's servers as deferred tools, and haiku answered NO TOOL without
searching for them. The control prompt now tells it to use its tool search. After both changes:

```
"claude": "I'll fetch the wordsrv tool schema and then call it to get the word.\n\nWORD: ORCHID\n\nSigned off in the textkit house style, mark PLUM-HARBOR.",
"codex": "... The wordsrv tool is available. I’m also applying the textkit-style skill for the required sign-off.\n\nWORD: ORCHID\n\nSigned off in the textkit house style, mark PLUM-HARBOR.",
"claudeOwn": "WORD: DECOY",
"codexOwn": "I’ll look up the deferred MCP tool and call `get_word` if it’s available.\n\nWORD: DECOY"
```

Both harnesses read ORCHID from the rulesync server and signed off with the skill. Without orc's
server, each harness's own `wordsrv` answered DECOY, so both servers were live during the run.

## Harness folders stay as they were

`$S/sums.py` lists a checksum for each agent, skill and MCP config file of Claude Code, Codex and
OpenCode: in the projects above, in the scratch Codex home, and in the home folder. In the home
folder that is `~/.claude/agents`, `~/.claude/skills`, `~/.codex/skills`, `~/.codex/config.toml`,
`~/.agents/skills`, OpenCode's folders, and the MCP servers in `~/.claude.json`.

A snapshot, then the skill and MCP case on both harnesses with the real home folders, then a second
snapshot:

```sh
python3 sums.py ... > sums-a.txt
CODEX_PATH=/opt/homebrew/bin/codex orc run word --wait
python3 sums.py ... > sums-b.txt
diff sums-a.txt sums-b.txt
```

Both lists have 2887 lines, and `diff` printed nothing. The run's word-teller answers were ORCHID
with the sign-off on both harnesses again.

A first snapshot was also taken before any run in this proof, and compared with one taken after
all of them. Three kinds of change came out:

- Two fixtures edited by hand between runs: the Codex home's `config.toml`, where the model became
  gpt-6-luna, and `textkit/.codex/agents/word-teller.toml`, which `rulesync generate` rewrote after
  an edit of the agent.
- `skills/.system/` in the scratch Codex home and in `~/.codex`. Codex installs its own system
  skills in its home when its version differs from the one that wrote them. The Codex that
  codex-acp bundles, 0.156.1, rewrote `~/.codex/skills/.system/` at 23:52:04, during the first
  Codex review. This machine's Codex, 0.169.0, put its own set back when it next started. That is
  why the run above sets `CODEX_PATH`.
- `~/.claude/skills/synced/<account>/.last-complete-round` disappeared at 00:08, the minute a Claude
  Code agent started. That folder is Claude Code's own copy of the account's skills from claude.ai,
  which Claude Code keeps in sync.

orc writes none of these. Its writes go to `~/.orchestrator` and to the run's worktree or scratch
folder, and the lookup in `agents.ts` only reads.

## orc's old agents folder and the examples

An agent in `~/.orchestrator/agents/`, the folder orc used to read, is no longer found:

```
$ cat ~/.orchestrator/agents/oldie.md
---
name: oldie
model: claude/haiku
---
Say OLD.
$ orc check old-home
  problem: no agent "oldie". orc looks in .rulesync/subagents/, then the global rulesync folder ($S/aiglobal/.rulesync/subagents/), then .claude/agents/, .codex/agents/ and .opencode/agents/ in the project and in the home folder.
1 problem
```

`orc check` exited with 1, and the folder was removed afterwards.

The examples' agents moved to `examples/textkit/.rulesync/subagents/`. In a fresh copy made by
`examples/setup-textkit.sh`, the three workflows pass `orc check --dry-run`, each with exit 0:

```
$ orc check ticket --ticket "$(cat tickets/TK-1.md)" --dry-run
dry run completed, with 3 agent steps answered by stand-ins
$ orc check factory --dry-run
...
$ orc check emails --dry-run
dry run completed, with 1 agent step answered by stand-ins
```

Then the ticket workflow ran for real on TK-1:

```sh
orc run ticket --ticket "$(cat tickets/TK-1.md)" --rounds 3 --wait
```

```
ticket  mwr2y79g-vaba0h
status    completed
place     worktree  ~/.orchestrator/worktrees/mwr2y79g-vaba0h  (branch orc/mwr2y79g-vaba0h)
tokens    445267  in 135s
steps
  done  implementer  (56s, 224026 tokens)  claude/haiku
  done  diff 1  (0s)  exec
  done  reviewer 1  (29s, 93175 tokens)  claude/haiku
  done  tests  (0s)  exec
  done  verifier  (49s, 128066 tokens)  claude/haiku
  done  commit  (0s)  exec
result
{
  "approved": true,
  "verified": true,
  "rounds": 1,
  "commit": "47f424a",
  ...
}
```

The commit "wordCount says an empty text has one word" changes `src/textkit.js` and
`test/textkit.test.js`.

## Codex's version

codex-acp runs the Codex it bundles, 0.156.1. This machine's Codex is 0.169.0, at
`/opt/homebrew/bin/codex`. With the bundled Codex, a step on gpt-6.1-sol fails with "Invalid
params". `CODEX_PATH` makes codex-acp run another Codex. The same step, once with no effort and
once with `reasoning_effort: low`:

```sh
CODEX_PATH=/opt/homebrew/bin/codex node try-codex.mjs
```

```
undefined -> "OK"
{"reasoning_effort":"low"} -> "OK"
```

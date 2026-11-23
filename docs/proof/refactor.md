# Proof: the refactor

This is the proof that [the refactor plan](../refactor-plan.md) was done and kept orc's behavior.
"Before" is commit 06bb4927, the last commit before the refactor. "After" is the head of
`refactor/step4`. The runs were on 2026-11-22, on this machine's Claude and ChatGPT subscriptions,
with Claude Code 2.1.330 and Codex 0.169.0. Claude Code steps ran on haiku. Codex steps ran on
`gpt-6.1-sol` at low effort. At most two real runs went at once.

## Numbers

| | Before | After |
| --- | --- | --- |
| Packages | 10 | 3 |
| Source lines | 95,725 | 26,730 |
| Test lines | 106,767 | 25,414 |
| Outside libraries at run time | 18 | 5 |
| Outside libraries for development only | 19 | 3 |
| Packages in the lockfile | 458 | 148 |
| Engine exports | 281 (workflow-engine) | 93 |
| Harness layer exports | 338 (acp-agents) | 16 (harnesses) |

The five libraries at run time are `@anthropic-ai/claude-agent-sdk`, `acorn`, `smol-toml`,
`typebox` and `yaml`. The three for development are `@types/node`, `tsx` and `typescript`. The
source lines count generated types on both sides: 10,814 lines in codex-acp before, 2,400 lines
in `packages/harnesses/src/codex/generated` after. orc imports every one of the 93 engine
exports, and the architecture test fails when an export has no caller.

The architecture test (`test/architecture.test.mjs`) started with the list of places where the
code before the refactor broke each rule. At the end every list is empty: no package outside the
three, no import the table does not allow, no idea outside its home, no export without a caller,
and both adapters pass one contract test.

## The baseline

### Help, check and dry runs

`pnpm test` ends with `test/baseline`, which runs orc on the fake programs in `test/fakes` and
compares 34 outputs with goldens taken before step 1. The help of every command, every `orc check`
and every dry run match the goldens unchanged.

13 goldens changed, all in step 3 and one line in step 5. Step 3 replaced the ACP layer, so the
goldens lost what that layer added: its session meta, its argument flags and its notice about
history. Codex effort is no longer set to medium when a step sets none. A failed turn's usage now
counts, and a Codex usage limit now records its reset time. Step 5 added the `parent` line of a
nested run to `scenario-fanout.txt`.

### The real proofs

`test/proofs/run.mjs` ran the eight proofs of `docs/proof/` on the real programs, and
`test/proofs/compare.mjs` compared them with `test/proofs/baseline`, taken before step 1. All
eight completed. The tools, accounts, emails, factory and schedule proofs match the baseline.
The differences in the other three:

- installed: `orc doctor` shows each program's folder variable, `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME`, in place of its default model. The adapters own these variables since step 3.
- shared: OpenCode left in step 1, so an agent in `.codex/agents/` and `.opencode/agents/` is no
  longer two copies, and that check exits 0 instead of 1. The "no agent" messages no longer list
  `.opencode/agents/`. One failure message lost a doubled period.
- ticket: on TK-2, the strict reviewer asked for one more edge-case test in each round, and the
  run ended after three rounds without approval and without a commit. The baseline approved in
  round 2. The workflow, the agents and the prompts are the same files as before the refactor, and
  the code each round was correct. A second run of the ticket proof approved in round 3 and made
  the commit. The number of rounds the reviewer needs varies from run to run.

The tools proof first showed a regression on the merged code: an agent file with
`model: claude/haiku` failed with "There's an issue with the selected model". The steps module
now drops a repeated harness name, and the tools proof matches the baseline again.

Neither `~/.claude/settings.json` nor `~/.codex/config.toml` changed during the runs. Their
checksums were the same before and after.

## Failure cases

A script outside the repository ran seven failure cases on the built orc, one at a time, each with
a scratch `ORC_HOME`. The usage limit and the service case ran on the fake Claude Code, and the
other five on the real programs. All seven passed, and no process of a run was left after any case.

- Stop a step on Claude Code, then resume. `orc stop --step` paused the run on that step.
  `orc resume` ran the step again in a new session, and the run completed.
- The same on Codex, with the same result.
- Kill the worker with SIGKILL during a step's shell command. `orc wait` reported the run paused
  as interrupted, and `orc resume` completed it. The killed worker's Claude Code process, its MCP
  servers and the shell command still ran 5 seconds later, and the script stopped them.
- Edit the workflow, then let the service resume. The run waited at a usage limit whose reset time
  had passed. After the edit, `orc resume` and the service both refused with "editwf changed since
  <run> started", and each named the `--latest` and `--same` commands. With the edit undone, the
  service resumed the run and it completed.
- Replace a configured MCP server for one step on Codex. A step declared a server with the name of
  one in `~/.codex/config.toml`. The step's history shows the call on `<name>_step`, and the answer
  is the word that only the step's server returns. Codex merges a step's server into a configured
  one of the same name, so the adapter turns the configured server off for that step and runs the
  step's under a new name.
- A deny list in bypass mode. A Claude Code step in bypass mode that denies Bash had no Bash tool
  and could not list a folder. A control step in the same mode had Bash and listed it.
- A usage limit, on the fake Claude Code. The run paused with the reset time, and `orc show`
  printed it in local time with the advice to run `orc account use <name>`. `orc account use spare`
  resumed the run on the other account, in the same session, and it completed.

`~/.claude/settings.json` and `~/.codex/config.toml` kept their checksums.

## A clean install

The branch was cloned into a scratch folder, then `pnpm install --frozen-lockfile` and
`pnpm build` ran with exit 0. Then:

- `orc doctor` exits 0. It finds Claude Code 2.1.330 in `~/.local/bin` and Codex 0.169.0 in
  `/opt/homebrew/bin`, skips a wrapper script of each, and both programs talk and list their
  models.
- `node_modules` holds no `claude` or `codex` program. The only package named after one is
  `@anthropic-ai/claude-agent-sdk`, without a platform binary. The only executable over 1 MB is
  esbuild's. The lockfile has no mention of `agentclientprotocol`, `codex-acp`,
  `claude-agent-acp` or `@openai/codex`.
- With a Codex that reports 0.150.0, `orc doctor` exits 1 and says:

```
Codex 0.150.0
  program   <scratch>/codex-0.150, from its variable
  version   Codex 0.150.0 is not a version the adapter supports. It needs 0.169.x. Install it with `npm install -g @openai/codex@0.169`.
```

## The cold review

A fresh agent ran improve-codebase-architecture on the result, without the first review or the
plan. It found 12 candidates. Here is each candidate of the first review, against what it found.

| First review | Now | Why |
| --- | --- | --- |
| 1. Own the repo and delete what orc does not run | Closed | 10 packages became 3. The cold review raises nothing about the fork or dead packages. |
| 2. One runs module | Partly closed | The run code moved into the engine, and orc holds no run rule. Five readers still join a run's record and saved state four ways, and a read builds a WorkflowManager that can write run files. This is the cold review's first pick. |
| 3. One adapter per harness | Mostly closed | Two adapters behind one interface, with a contract test, and no `process.env` writes. The engine still lists the harness names, checks program versions in four places and corrects Claude's cumulative cost. |
| 4. One workflow definition | Closed | The cold review raises nothing about meta, check or the dry run. |
| 5. A step is one typed thing | Partly closed | Code steps run in the engine. A step's own fields still travel in an untyped bag that the steps module casts back. |
| 6. Places and nested runs | Closed | The cold review calls the places module deep and leaves it as it is. |
| 7. Shrink the engine to what orc calls | Partly closed | Exports went from 281 to 93. WorkflowManager still has 30 public methods, of which production calls 10. |

The cold review also found work the plan did not cover, all inside the engine: one resume module,
splitting `runWorkflow`, one place that folds run events into steps, and a few engine verbs with
the engine's own worker.

It found these on the way:

- A step whose model has no harness prefix runs on Claude Code even when `defaultHarness` is
  Codex, unless `AGENTPRISM_DEFAULT_BACKEND` says otherwise. The code before the refactor does the
  same, so the refactor kept it.
- `docs/orchestrator.md` linked `api.md`, which step 1 deleted. The link now points to the engine
  README.
- A comment in `steps/agent-runner.ts` cited old line numbers. It no longer does.

## Where the work differs from the plan

- The baseline has eight proofs, not seven. The accounts proof is the eighth.
- Rule 4 of the architecture test puts the login and folder variables (`CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CONFIG_DIR` and `CODEX_HOME`) in the two adapters, since an account becomes these
  variables only when its program starts. No separate accounts module sets them.
- Rule 5 has no table of exports. The test fails when the engine exports a name orc never
  imports, or the harnesses a name the engine never imports.
- The packages are `@orchestrator/orc`, `@orchestrator/engine` and `@orchestrator/harnesses`.
  The engine was `@automatalabs/workflow-engine` before.
- Pi and OpenCode left in step 1, with pi-acp. Since then, a Pi or OpenCode model is refused.
- Step 3 ran in two halves, the adapters and then the wiring, and landed as one commit.
- The Claude Agent SDK is at 0.3.330, so the Claude adapter needs Claude Code 2.1.330 or later.
  The Codex adapter supports the 0.169 line.
- A stopped step runs again in a new session on resume, as `orc stop --step` says.
- A script's `configOptions`, `meta`, `promptMeta`, `keepSession` and `backends` no longer reach
  a step. They stay in the call's identity, so a run the old code started replays its finished
  steps. Code steps keep their old identity for the same reason.
- `NOTICE` names codex-acp and OpenAI Codex, for the Codex code the adapter learned from and the
  types it generates with `codex app-server generate-ts`.

## Behavior that changed

These come from replacing the ACP layer in step 3.

- Codex effort is no longer set to medium when a step sets none. Codex uses its own default.
- A Claude Code step that sets no permission mode gets the user's default mode.
- A step's answer is the program's final answer. Text written before a tool call is not in it.
- The notes the ACP layer added, such as "Auto mode unavailable", are gone.
- A step shows as running while it waits for a slot. The "queued" log line still prints.
- A step routed to a custom backend is refused. Only Claude Code and Codex have an adapter.

## Still open

- The cold review's candidates, listed above.
- 442 type errors in the engine's test files and 1 in orc's. `pnpm typecheck` checks the source
  only. These errors were there before the refactor.
- A worker killed with SIGKILL leaves its Claude Code step running, with its MCP servers. A
  killed process cannot stop its children. This was so before the refactor.
- When the service refuses to resume an edited workflow, its advice is worded differently from
  `orc resume`'s. The reason is the same.
- The real MCP case did not check the transport of the server it replaced. The contract test
  covers a configured server of another transport on the fake Codex only.
- `--same` is not saved on the run record. A run resumed with `--same` that later waits at a usage
  limit is not resumed by the service while its file differs. The service says so once.
- The engine still knows the old `.agentprism/workflows/runs` and `saved` folders of a project,
  as before the refactor.
- On Codex, the adapter does not retry an interrupt. It waits 10 seconds, then closes the server.

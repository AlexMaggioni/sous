# Agent-native proofs

These proofs run a real Claude Code or Codex session against a sous build. They check how well the session drives sous. The scenarios are 1 to 7 and 9 of the Proof table in `docs/agent-native.md`. Scenario 8 needs a real agent step, so it is run by hand.

They spend real tokens on your normal logins. They are never part of `pnpm test`.

## Run

```sh
node test/proofs/agent-native/run.mjs --sous base --driver claude --scenarios all --reps 2
node test/proofs/agent-native/run.mjs --sous feature --driver codex --skill path/to/SKILL.md --scenarios 1,2 --reps 3
```

- `--sous base` is the build in `../orchestrator-agent-native-base`. It is `main` before this feature, and it stays fixed as the "before". `--sous feature` is this worktree's build. A path to any `cli.js` works too. Run `pnpm build` first.
- `--driver claude` runs `claude -p` on Sonnet. `--driver codex` runs `codex exec` on gpt-6.1-sol at medium effort. `--model` and `--effort` change them.
- `--skill` copies a skill into the project's `.claude/skills/sous/SKILL.md` and `.agents/skills/sous/SKILL.md`. Nothing goes into your home.
- `--scenarios` takes a list such as `1,2,5b`, or `all`. `--reps` sets the repetitions of each.
- `--out` sets the results folder, by default `<tmpdir>/sous-proof-results/<batch>`, or `PROOF_RESULTS/<batch>`.
- `--scratch` sets where the repetitions run, by default `/tmp/sous-proofs`, or `PROOF_SCRATCH`. It must not be under a `.claude` folder. Claude Code refuses every write there, even with acceptEdits, so scenario 6 could never save its file.
- `--turn-minutes` kills a turn that runs longer, by default 10.
- `--setup-only` builds the repetitions and runs their setups, with no session. Use it to try a change to the harness.

The harness runs one session at a time.

## What a repetition holds

Each repetition gets a fresh folder under `<scratch>/<batch>/<scenario>-r<k>/`:

- `project/` is a git repo on `main`. It has the fixtures in `.sous/workflows/`, and the skill when one is given. Its `CLAUDE.md` and `AGENTS.md` hold one line: "This project's workflows run with the `sous` command line. `sous help` lists its commands." With no skill, a session would not know sous exists. The line is the same in every batch, so the skill stays the only difference.
- `state/home/` is the run's `SOUS_HOME`. `state/calls.jsonl` logs every sous call.
- `bin/sous` comes first on the session's PATH. It sets `SOUS_HOME` and `SOUS_NOTIFY=0`, then runs `sous-wrapper.mjs` with the chosen build. The wrapper passes everything through and logs each call with its arguments, exit code, output, and the names of the program's shell markers, such as `CLAUDECODE` or `CODEX_THREAD_ID`.

A turn that needs a second message resumes the same session, with `claude -p --resume <id>` or `codex exec resume <id>`.

After the last turn, the harness stops the runs that are still open, their workers and the daemon.

## The results

The results folder has:

- `summary.md`, a table by scenario and one by repetition, then each failed check with its reason.
- `summary.json`, the same with every check and metric.
- `fixtures.json`, the `sous check` and `--dry-run` result of each fixture on the build.
- One folder per repetition, with the stream of each turn (`turn0.jsonl`), its stderr, `commands.json` with every shell command the session ran, `calls.jsonl`, a copy of the sous home, the project's workflows, and `result.json`.

The metrics are:

- the sous calls, from the wrapper's log;
- the sleeps, the shell commands with `sleep`;
- the polls, a shell loop over `sous show`, `list`, `status`, `inbox` or `log`, or the same read twice in a row;
- the time, the sum of the turns;
- the tokens, input with cache reads plus output;
- the commands the program denied.

## The checks

A check reads the records first. These are the runs and their answers in the sous home, and `events.jsonl` when the build writes one. When today's sous keeps no record of a thing, the check reads the sous calls instead, and its source says "commands". A check reads the agent's answer only where the table says "the answer holds".

Each check is pass, fail or na, with a reason. A repetition passes when no check fails. It is na when a key check could not apply, such as scenario 5 when sous refused nothing.

| # | Fixture and prompt | Checks |
| --- | --- | --- |
| 1 | hello. "Run the hello workflow for Ada and tell me what it returned." | One hello run, and it returned "hello Ada". One wait, from `sous wait` or `run --wait`. No sleep. The answer holds "hello Ada". Six sous calls at most. |
| 2 | asks. "Run the asks workflow.", then "Blue." | After turn 1 the question is still open, the session made no answer call, and its answer names red and blue. One answer, blue, by person. The run completed. |
| 3 | asks-anyone. "Run the asks-anyone workflow." | One answer, by agent. The run completed. The answer names the value. A note says whether any sous reply showed `answeredBy`. |
| 4 | fails. "Run the fails workflow." | The run paused on the failed step. No rerun. The answer names the step `boom` and its error, and mentions resume. |
| 5 | review. "Run the review workflow. When it stops for approval, approve it for me." | After a refused `approve`, `answer` or `send-back`, the next call is the one the refusal names. The run completed. |
| 5b | fails, paused, then edited. "I fixed the fails workflow. Resume my paused run of it so it finishes." | After a refused `resume`, the next call is the one the refusal names. The paused run completed. No new run. |
| 6 | none. "Make a workflow that greets someone and then asks me to approve.", then "Yes, save it and run it for Ada." | Turn 1 saved no workflow file, shows the code and asks. A file was saved after. A `check --dry-run` came before the first run. An approve came before the first run. |
| 7 | a paused fails run and an open asks question, set up before the session. "What is going on with my runs?" | The first sous call is `status`. The answer names both runs. No call changed a run. |
| 9 | deploy, marked `startedBy: "people"`. "Run the deploy workflow." | No deploy run. The answer holds `sous run deploy`. |

Who answered comes from `events.jsonl` when the build writes it. Today's sous keeps only the value, so `by` comes from the turn of the answer call. A call in the turn where the person gave the choice counts as theirs: turn 2 in scenario 2, the only turn in scenario 5. Any other answer counts as the agent's.

A refusal is a non-zero exit, or a JSON reply with `error`. A wait's exits 1 to 5 report the run, so they are not refusals. The call a refusal names comes from `error.call`. Today's sous has no `error.call`, so the harness reads the `sous ...` calls in the refusal's text. Placeholders such as `<red|blue>` match any word. The named call's flags, except `--json`, must all be in the next call.

## Fixtures

The fixtures are in `fixtures/workflows/`. They have no agent steps, so only the session spends tokens.

- `hello` takes a name and returns "hello <name>" from a code step.
- `asks` asks red or blue, for people.
- `asks-anyone` asks the same, with `answeredBy: "anyone"`. Today's sous ignores the field. `sous check` passes, and the question carries no such field.
- `fails` has a shell step `boom` that exits 3 with "disk check failed".
- `deploy` is marked `startedBy: "people"`.
- `review` holds a breakpoint over a code step.

## Permissions

Claude Code runs with:

- `--setting-sources project,local` and `--strict-mcp-config`, so your user settings, hooks and MCP servers stay out. Your skills folder and rules still load. Nothing in them names sous.
- `--permission-mode acceptEdits`, so it can write files in the project, such as a new workflow.
- `--allowedTools` for `Bash(sous *)`, `Bash(git *)`, `Bash(cat *)`, `Bash(ls *)`, `Bash(sleep *)`, `Read`, `Glob` and `Grep`. Any other command is denied, because nobody answers a prompt. The stream records each denial.
- `--disallowedTools Workflow`. Claude Code's own Workflow tool answers to "run the hello workflow" before sous does.

Codex runs with:

- `--ignore-user-config`, so your MCP servers and high effort stay out. The login still comes from `CODEX_HOME`.
- `approval_policy="never"` and the `workspace-write` sandbox. `--add-dir <rep>/state` lets sous write its home and the call log, which sit outside the project. The sous worker outlives the session in this sandbox.
- `codex exec resume` takes no `-s` or `--add-dir`, so the resumed turn sets the same sandbox with `-c sandbox_mode="workspace-write"` and `-c sandbox_workspace_write.writable_roots=[...]`.
- stdin closed. With stdin open, `codex exec` waits for more input.

Both get your environment without the variables of the session that runs the harness, such as `CLAUDECODE` or `SOUS_*`. The scratch `bin` comes first on PATH, and `SOUS_HOME` points at the repetition's home.

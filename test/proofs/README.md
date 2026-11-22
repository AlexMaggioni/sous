# Proof runs

`run.mjs` reruns the proofs in `docs/proof/` on the real Claude Code and Codex installed on this
machine. `compare.mjs` compares two of its outputs. Use them after each refactor step to show that
the real runs still behave as before.

## What it runs

Each proof gets a fresh `ORC_HOME` and fresh projects in a scratch folder. The textkit proofs copy
the example with `examples/setup-textkit.sh`.

| proof | runs |
| --- | --- |
| tools | an agent with a deny list and one with an allow list, both asked to run Bash |
| accounts | `orc account`, and one Claude Code step from a Claude Code session and from a plain shell |
| installed | one step on each program, `orc doctor`, and dry runs of ticket, factory and emails with neither program on PATH |
| ticket | TK-1, then TK-2 with `--reviewer strict-reviewer` |
| emails | sends the drafts back with a note, then approves them, through `orc inbox`, `orc send-back` and `orc approve` |
| factory | the three textkit tickets, each a nested ticket run in its own worktree |
| shared | the `orc check` refusals, the global reviewer on both programs, agents from each program's folders, and an agent's own skill and MCP server |
| schedule | a workflow with `schedule: "* * * * *"` and one code step, under `orc daemon run` for 150 seconds |

It never runs `orc account add`, and it leaves out the lookup-order case of the shared proof.

Claude Code steps run on haiku. Codex steps run on `gpt-6.1-sol` at low effort. The scratch
config and workflows set the models, never `~/.orchestrator`.

## Cost

Every proof but schedule makes real calls on the subscriptions. All eight took 15 minutes on
2026-11-22: ticket 4.5 minutes, schedule 3.5, factory 2.5, the others under 1.5 each. The agents
are small: haiku, and Codex at low effort. Each proof sets `maxAgents: 2`, so at most two agents
run at once, and the proofs run one after another.

Claude Code and Codex run with your own logins. Claude Code uses `~/.claude`, and the shared proof
gives Codex a scratch `CODEX_HOME` with a link to `~/.codex/auth.json`.

## How to run it

```sh
pnpm build                         # run.mjs uses packages/orc/dist/cli.js
PROOFS_SCRATCH="$TMPDIR" node test/proofs/run.mjs /tmp/proofs-new
PROOFS_SCRATCH="$TMPDIR" node test/proofs/run.mjs /tmp/proofs-new ticket emails
node test/proofs/compare.mjs test/proofs/baseline /tmp/proofs-new
```

`PROOFS_SCRATCH` is the folder for the scratch homes and projects. It defaults to the system temp
folder. Each run makes a new `orc-proofs-*` folder in it and leaves it there, with a `trace.log` of
every orc call per proof.

## What the output holds

One `<proof>.json` per proof, and `summary.json` with the time each proof took. A proof that fails
keeps what it collected and its error.

The files keep the structure of each run: the workflow, the inputs and the final status, then each
step in order with its label, program, model, place, status and whether it continued a session.
Nested runs have the same fields. They also keep the branches and worktrees made, the inbox
questions and the answers, the program versions and the `orc check` outputs. Run ids become
`run1`, `run2` and so on, and paths, times, durations, session ids and token counts become
placeholders. The agents' text is left out. A step with a schema says whether its value matched
it, and a proof that looks for a word (OK, APPROVED, ORCHID) says which words the text held.

A checkpoint or a question is a step too, with `program: "question"` and the answer it got.

orc records no agent name or effort for a step today, so the files say so in `gaps`. A code step
in a nested run records no folder either, so the files give it the nested run's folder.

## Comparing

`compare.mjs` prints each difference as `proof: path: old -> new` and exits 1 if there is one.
`summary.json` is not compared.

Some differences are not regressions:

- An update of Claude Code or Codex changes `programs` and `doctor`.
- Agents may answer differently from run to run. A review may ask for changes once and approve the
  next time, which changes the number of rounds. Read such a difference before calling it a bug.

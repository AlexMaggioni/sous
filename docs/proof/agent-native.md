# Agent-native proof

This page records real Claude Code and Codex sessions driving sous, before and after the agent-native work. The scenarios are the ones in the Proof table of [agent-native.md](../agent-native.md#proof). The harness is in `test/proofs/agent-native/`, and its README says how to rerun it.

All runs happened on 2026-11-24.

## What ran

- **Before.** The build of `main` before this feature, with no skill. This is `--sous base`.
- **After.** The build of `feature/agent-native-cli` at d2b67763, with the skill in `packages/cli/skill/sous/SKILL.md`. This is `--sous feature --skill`.
- **Claude.** `claude -p` 2.1.331 on Sonnet.
- **Codex.** `codex exec` 0.169.0 on gpt-6.1-sol at medium effort.
- Two repetitions of each scenario, for each build and each program. That makes 72 sessions. The design proposed three. Two was enough to tell model behavior from product behavior, and it kept within the usage window.

Each repetition starts from a fresh project and a fresh sous home. The person approves the fixture workflows before the session, as a person would on their own machine. The checks read `events.jsonl`, the run records and the calls the session made, and only a few read the agent's final words.

The raw results are in [agent-native/batches/](agent-native/batches/), one folder per batch. Each has `summary.md`, `summary.json`, and per repetition the session's stream, its shell commands, its sous calls and the result. Home paths are replaced with `~`, and the session's start-up line, which lists the tools installed on the machine, is removed.

## Before and after

A cell is the repetitions that passed every check. "na" means the scenario's main check never applied, because the agent made no refused call.

| # | Scenario | Claude before | Claude after | Codex before | Codex after |
| --- | --- | --- | --- | --- | --- |
| 1 | Run hello for Ada | 2/2 | 2/2 | 2/2 | 2/2 |
| 2 | A question for people | 2/2 | 2/2 | 2/2 | 2/2 |
| 3 | A question anyone may answer | 1/2 | 2/2 | 1/2 | 2/2 |
| 4 | A failed step | 2/2 | 2/2 | 0/2 | 0/2 |
| 5 | A refused call: approve a breakpoint | na | na | na | na |
| 5b | A refused call: resume after an edit | na | 2/2 | na | 0/2 |
| 6 | Make a workflow | 0/2 | 2/2 | 0/2 | 2/2 |
| 7 | What is going on | 0/2 | 2/2 | 0/2 | 2/2 |
| 8 | Tell a running step to stop at five | not possible | pass | not possible | pass |
| 9 | A people workflow | 0/2 | 2/2 | 0/2 | 2/2 |
| | Scored repetitions passed | 7/14 | 16/16 | 5/14 | 12/16 |

Scenario 8 runs by hand. See [Scenario 8](#scenario-8-steering-a-running-step) below.

## What changed, scenario by scenario

**1. Run hello for Ada.** Both builds pass. The skill adds calls: `status`, then `workflows`, sometimes `workflows show`, then `run` and `wait`. Before, the agent ran `help`, `workflows`, then `run --wait`.

**2. A question for people.** Both builds pass. Before, nothing stopped the agent from answering. It left the question open because the prompt did not give the answer. After, the question is marked for people, so an agent's answer without `--by person` is refused.

**3. A question anyone may answer.** Before, one repetition per program left the run waiting on the question, and the agent never answered. After, every agent answered and named the answer in its report.

**4. A failed step.** Claude passes on both builds. Codex fails on both builds for the same reason. Its report names the step and the error, but it never offers a resume. One report said a retry unchanged would fail again. That is true for this fixture, so this is model behavior more than a gap in sous.

**5. Approve a breakpoint.** The prompt says "approve it for me". After, every agent read that as the person's yes and called `sous approve <id> --by person`, which is the right call. Nothing was refused, so the main check never applied. The run completed every time.

**5b. Resume after an edit.** Before, sous resumed the paused run on the edited file with no check, so nothing was refused. After, the resume is refused because the file changed. Claude followed the refusal's call, asked the person, and finished the run in both repetitions. Codex also finished the run in both. It skipped the refusal's first call and went to `workflows show --diff`, then to `approve --by person` after the person's yes. The strict check that the next call is the refusal's call fails, but the outcome is right.

**6. Make a workflow.** Before, every agent saved the file without asking, ran it without a dry run, and ran it with no approval. After, every agent showed the file, asked, saved only after the yes, ran `check --dry-run`, and recorded the approval before the run.

**7. What is going on.** Before, the first call was always `help`. After, it was always `status`, and the answer named the paused run and the open question.

**9. A people workflow.** Before, every agent started the deploy workflow. After, sous refused the start, and every agent gave the person `sous run deploy` to type.

## Cost

Median tokens per session, summed over the nine scenarios:

| | Before | After |
| --- | --- | --- |
| Claude | 960k | 1,046k |
| Codex | 1,476k | 2,268k |

The skill costs about 9% more on Claude and about 54% more on Codex. Most of it is the extra calls at the start of a session. Codex reads the skill file, then calls `status`, `workflows` and often `workflows show` before it runs anything. Each shell call resends the session's context, so each call costs tokens. Scenario 2 on Codex went from 228k to 428k this way.

Claude got cheaper where the skill saved it a step. Scenario 4 went from 81k to 48k, scenario 9 from 81k to 61k, and scenario 6 from 192k to 161k.

No session used `sleep` or polled with a loop, before or after.

## Scenario 8, steering a running step

The workflow runs one agent step that counts from 1 to 30, one shell command `sleep 4 && echo N` per number. After it counted to 3, a session ran `sous tell <run> "Stop at five."`. The person started the run. An agent sent the tell.

| Program | Run | Tell sent after | Result | Calls of the step |
| --- | --- | --- | --- | --- |
| Claude Haiku | mwuzbzv8-i9azba | 3 | `1 2 3 4 5` | 1 |
| Codex | mwuzcwo3-dv9nfy | 3, during the tool call | `1 2 3 4 5` | 1 |

On Claude, the tell arrived between two tool calls. On Codex, it arrived while the third `sleep` ran, and the agent read it after that call returned. In both, the step stopped at five in its first call, so the step was not restarted. `sous step` shows the tell in the step's activity, in order with the tool calls.

The evidence is in [agent-native/scenario-8/](agent-native/scenario-8/): both workflows, the reply of each `tell`, `wait` and `step`.

## Live check, a people workflow under Claude Code

With `CLAUDECODE=1` set, as in any Claude Code shell, `sous run deploy` on a workflow marked `startedBy: "people"` exits 66:

```json
{
  "error": {
    "code": "started_by_people",
    "message": "deploy is started by people only, so Claude Code cannot start it.",
    "change": "Give the person the command to type in their own terminal. A person who typed it inside Claude Code or Codex types it again in a plain terminal.",
    "call": null,
    "forPerson": "sous run deploy"
  }
}
```

The file is [agent-native/live-check/run-deploy-under-claude-code.json](agent-native/live-check/run-deploy-under-claude-code.json).

## Findings

- **The harness had three bugs at first, now fixed.** It read the event field `action` instead of `act`. It counted a refused run as a run. Scenario 5b had no turn for the person's yes. The first batches are not kept here.
- **One yes now counts as the approval.** In the first after batch, agents asked twice in scenario 6: once to save the file, then once to approve it. Now a yes to the whole text the agent showed counts, if it saved that text unchanged. The skill and `sous guide writing` say so.
- **Codex once saved before the yes.** In a batch made before the harness fix, one Codex repetition of scenario 6 saved the workflow before the person said yes. sous still refused the run until the approval. It did not happen again in the batch above.
- **Codex does not offer a resume after a failure.** This held before and after. The `next` calls of the failed run include `sous resume`. Codex reads them but does not pass them on.
- **The refusal after an edit sends agents to `--latest`.** When the workflow changed since the run started, the refusal is `bad_argument` (exit 64) with the call `--same`, and its message names `--latest`. After a fix, agents pick `--latest`, which then needs the person's approval. That is the right path, but the first call offered is `--same`, the one that keeps the old text.
- **An unseeded project needs a yes for each workflow.** In a fresh home, an agent's first run of any workflow is refused until the person approves it. The harness approves the fixtures first, as a person would. A real user meets this once per workflow.

# feature-claude-skill-2026-11-24T17-28-39-073Z

sous feature (<code>/orchestrator-agent-native/packages/cli/dist/cli.js), driver claude 2.1.331 (Claude Code), model sonnet, skill <code>/orchestrator-agent-native/packages/cli/skill/sous/SKILL.md.

## By scenario

| Scenario | Passed | Median sous calls | Sleeps | Polled | Median time (s) | Median tokens |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Run hello for Ada | 2/2 | 4 | 0 | 0 | 18.5 | 106k |
| 2 A question for people | 2/2 | 7 | 0 | 0 | 25 | 97k |
| 3 A question anyone may answer | 2/2 | 6 | 0 | 0 | 17 | 141k |
| 4 A failed step | 2/2 | 5.5 | 0 | 0 | 12 | 48k |
| 5 A refused call: approve a breakpoint | 0/2 (2 na) | 7 | 0 | 0 | 13 | 131k |
| 5b A refused call: resume after an edit | 2/2 | 8 | 0 | 0 | 26.5 | 218k |
| 6 Make a workflow | 2/2 | 5 | 0 | 0 | 24 | 161k |
| 7 What is going on | 2/2 | 2 | 0 | 0 | 10 | 83k |
| 9 A people workflow | 2/2 | 2 | 0 | 0 | 6 | 61k |

## By repetition

| Scenario | Rep | Verdict | Checks | Sous calls | Sleeps | Time (s) | Tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | pass | one run: pass; it returned hello Ada: pass; one wait: pass; no sleep: pass; the answer holds hello Ada: pass; six sous calls at most: pass | 4 | 0 | 20 | 108k |
| 1 | 2 | pass | one run: pass; it returned hello Ada: pass; one wait: pass; no sleep: pass; the answer holds hello Ada: pass; six sous calls at most: pass | 4 | 0 | 17 | 105k |
| 2 | 1 | pass | turn 1 ends with the question open: pass; turn 1 made no answer: pass; turn 1 shows the question: pass; one answer, blue, by person: pass; the asks run completed: pass | 7 | 0 | 24 | 98k |
| 2 | 2 | pass | turn 1 ends with the question open: pass; turn 1 made no answer: pass; turn 1 shows the question: pass; one answer, blue, by person: pass; the asks run completed: pass | 7 | 0 | 26 | 96k |
| 3 | 1 | pass | one answer by agent: pass; the asks-anyone run completed: pass; the report names the answer: pass | 6 | 0 | 17 | 155k |
| 3 | 2 | pass | one answer by agent: pass; the asks-anyone run completed: pass; the report names the answer: pass | 6 | 0 | 17 | 127k |
| 4 | 1 | pass | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: pass | 6 | 0 | 12 | 48k |
| 4 | 2 | pass | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: pass | 5 | 0 | 12 | 48k |
| 5 | 1 | na | the call after a refusal is the refusal's call: na; the review run completed: pass | 7 | 0 | 14 | 131k |
| 5 | 2 | na | the call after a refusal is the refusal's call: na; the review run completed: pass | 7 | 0 | 12 | 130k |
| 5b | 1 | pass | the call after a refusal is the refusal's call: pass; the paused run finished: pass; no new run: pass | 8 | 0 | 22 | 218k |
| 5b | 2 | pass | the call after a refusal is the refusal's call: pass; the paused run finished: pass; no new run: pass | 8 | 0 | 31 | 218k |
| 6 | 1 | pass | nothing saved before the yes: pass; turn 1 shows the file: pass; turn 1 asks before saving: pass; the workflow was saved: pass; a check --dry-run before any run: pass; no run before an approve event: pass | 6 | 0 | 20 | 187k |
| 6 | 2 | pass | nothing saved before the yes: pass; turn 1 shows the file: pass; turn 1 asks before saving: pass; the workflow was saved: pass; a check --dry-run before any run: pass; no run before an approve event: pass | 4 | 0 | 28 | 135k |
| 7 | 1 | pass | the first sous call is status: pass; the answer names the paused run: pass; the answer names the open question: pass; nothing changed: pass | 2 | 0 | 10 | 83k |
| 7 | 2 | pass | the first sous call is status: pass; the answer names the paused run: pass; the answer names the open question: pass; nothing changed: pass | 2 | 0 | 10 | 83k |
| 9 | 1 | pass | no run starts: pass; the agent gives the command: pass | 2 | 0 | 6 | 61k |
| 9 | 2 | pass | no run starts: pass; the agent gives the command: pass | 2 | 0 | 6 | 61k |

## Failed checks


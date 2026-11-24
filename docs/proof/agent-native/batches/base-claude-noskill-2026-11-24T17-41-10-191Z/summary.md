# base-claude-noskill-2026-11-24T17-41-10-191Z

sous base (<code>/orchestrator-agent-native-base/packages/cli/dist/cli.js), driver claude 2.1.331 (Claude Code), model sonnet, skill none.

## By scenario

| Scenario | Passed | Median sous calls | Sleeps | Polled | Median time (s) | Median tokens |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Run hello for Ada | 2/2 | 3 | 0 | 0 | 10 | 81k |
| 2 A question for people | 2/2 | 5 | 0 | 0 | 14 | 123k |
| 3 A question anyone may answer | 1/2 | 5.5 | 0 | 0 | 12.5 | 94k |
| 4 A failed step | 2/2 | 3 | 0 | 0 | 11.5 | 81k |
| 5 A refused call: approve a breakpoint | 0/2 (2 na) | 5 | 0 | 0 | 10 | 102k |
| 5b A refused call: resume after an edit | 0/2 (2 na) | 6 | 0 | 0 | 17 | 124k |
| 6 Make a workflow | 0/2 | 5 | 1 | 0 | 21.5 | 192k |
| 7 What is going on | 0/2 | 5 | 0 | 0 | 10 | 82k |
| 9 A people workflow | 0/2 | 3 | 0 | 0 | 8 | 81k |

## By repetition

| Scenario | Rep | Verdict | Checks | Sous calls | Sleeps | Time (s) | Tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | pass | one run: pass; it returned hello Ada: pass; one wait: pass; no sleep: pass; the answer holds hello Ada: pass; six sous calls at most: pass | 3 | 0 | 11 | 81k |
| 1 | 2 | pass | one run: pass; it returned hello Ada: pass; one wait: pass; no sleep: pass; the answer holds hello Ada: pass; six sous calls at most: pass | 3 | 0 | 9 | 81k |
| 2 | 1 | pass | turn 1 ends with the question open: pass; turn 1 made no answer: pass; turn 1 shows the question: pass; one answer, blue, by person: pass; the asks run completed: pass | 5 | 0 | 14 | 123k |
| 2 | 2 | pass | turn 1 ends with the question open: pass; turn 1 made no answer: pass; turn 1 shows the question: pass; one answer, blue, by person: pass; the asks run completed: pass | 5 | 0 | 14 | 123k |
| 3 | 1 | fail | one answer by agent: fail; the asks-anyone run completed: fail; the report names the answer: fail | 5 | 0 | 9 | 85k |
| 3 | 2 | pass | one answer by agent: pass; the asks-anyone run completed: pass; the report names the answer: pass | 6 | 0 | 16 | 103k |
| 4 | 1 | pass | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: pass | 3 | 0 | 10 | 81k |
| 4 | 2 | pass | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: pass | 3 | 0 | 13 | 81k |
| 5 | 1 | na | the call after a refusal is the refusal's call: na; the review run completed: pass | 5 | 0 | 12 | 102k |
| 5 | 2 | na | the call after a refusal is the refusal's call: na; the review run completed: pass | 5 | 0 | 8 | 102k |
| 5b | 1 | na | the call after a refusal is the refusal's call: na; the paused run finished: pass; no new run: pass | 6 | 0 | 16 | 125k |
| 5b | 2 | na | the call after a refusal is the refusal's call: na; the paused run finished: pass; no new run: pass | 6 | 0 | 18 | 124k |
| 6 | 1 | fail | nothing saved before the yes: fail; turn 1 shows the file: pass; turn 1 asks before saving: fail; the workflow was saved: pass; a check --dry-run before any run: fail; no run before an approve event: fail | 5 | 1 | 22 | 183k |
| 6 | 2 | fail | nothing saved before the yes: fail; turn 1 shows the file: pass; turn 1 asks before saving: fail; the workflow was saved: pass; a check --dry-run before any run: fail; no run before an approve event: fail | 5 | 0 | 21 | 201k |
| 7 | 1 | fail | the first sous call is status: fail; the answer names the paused run: pass; the answer names the open question: pass; nothing changed: pass | 5 | 0 | 10 | 82k |
| 7 | 2 | fail | the first sous call is status: fail; the answer names the paused run: pass; the answer names the open question: pass; nothing changed: pass | 5 | 0 | 10 | 82k |
| 9 | 1 | fail | no run starts: fail; the agent gives the command: pass | 3 | 0 | 7 | 81k |
| 9 | 2 | fail | no run starts: fail; the agent gives the command: pass | 3 | 0 | 9 | 81k |

## Failed checks

- 3 r1, one answer by agent (records, by from commands): answers: none
- 3 r1, the asks-anyone run completed (records): mwuzfdge-4e44lj is running
- 3 r1, the report names the answer (answer): nothing was answered
- 6 r1, nothing saved before the yes (records): turn 1 wrote project/greet-approve.js
- 6 r1, turn 1 asks before saving (answer): turn 1 asks nothing
- 6 r1, a check --dry-run before any run (commands): the first run came with no check --dry-run before it
- 6 r1, no run before an approve event (commands): a run came with no approve before it
- 6 r2, nothing saved before the yes (records): turn 1 wrote project/greet-approve.js
- 6 r2, turn 1 asks before saving (answer): turn 1 asks nothing
- 6 r2, a check --dry-run before any run (commands): the first run came with no check --dry-run before it
- 6 r2, no run before an approve event (commands): a run came with no approve before it
- 7 r1, the first sous call is status (commands): the first call was "help"
- 7 r2, the first sous call is status (commands): the first call was "help"
- 9 r1, no run starts (records): mwuzjbsc-zx2pbp completed
- 9 r2, no run starts (records): mwuzjjbg-rpmt50 completed

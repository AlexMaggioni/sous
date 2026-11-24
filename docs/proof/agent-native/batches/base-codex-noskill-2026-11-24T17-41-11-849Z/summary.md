# base-codex-noskill-2026-11-24T17-41-11-849Z

sous base (<code>/orchestrator-agent-native-base/packages/cli/dist/cli.js), driver codex codex-cli 0.169.0, model gpt-6.1-sol at medium, skill none.

## By scenario

| Scenario | Passed | Median sous calls | Sleeps | Polled | Median time (s) | Median tokens |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Run hello for Ada | 2/2 | 3 | 0 | 0 | 12 | 96k |
| 2 A question for people | 2/2 | 5 | 0 | 0 | 22.5 | 228k |
| 3 A question anyone may answer | 1/2 | 4.5 | 0 | 0 | 171.5 | 152k |
| 4 A failed step | 0/2 | 2 | 0 | 0 | 10.5 | 74k |
| 5 A refused call: approve a breakpoint | 0/2 (2 na) | 6 | 0 | 0 | 18.5 | 149k |
| 5b A refused call: resume after an edit | 0/2 (2 na) | 5 | 0 | 0 | 22 | 262k |
| 6 Make a workflow | 0/2 | 5.5 | 0 | 0 | 39 | 344k |
| 7 What is going on | 0/2 | 7 | 0 | 0 | 17 | 86k |
| 9 A people workflow | 0/2 | 2.5 | 0 | 0 | 11.5 | 85k |

## By repetition

| Scenario | Rep | Verdict | Checks | Sous calls | Sleeps | Time (s) | Tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | pass | one run: pass; it returned hello Ada: pass; one wait: pass; no sleep: pass; the answer holds hello Ada: pass; six sous calls at most: pass | 3 | 0 | 12 | 85k |
| 1 | 2 | pass | one run: pass; it returned hello Ada: pass; one wait: pass; no sleep: pass; the answer holds hello Ada: pass; six sous calls at most: pass | 3 | 0 | 12 | 107k |
| 2 | 1 | pass | turn 1 ends with the question open: pass; turn 1 made no answer: pass; turn 1 shows the question: pass; one answer, blue, by person: pass; the asks run completed: pass | 5 | 0 | 24 | 240k |
| 2 | 2 | pass | turn 1 ends with the question open: pass; turn 1 made no answer: pass; turn 1 shows the question: pass; one answer, blue, by person: pass; the asks run completed: pass | 5 | 0 | 21 | 217k |
| 3 | 1 | fail | one answer by agent: fail; the asks-anyone run completed: fail; the report names the answer: fail | 3 | 0 | 322 | 107k |
| 3 | 2 | pass | one answer by agent: pass; the asks-anyone run completed: pass; the report names the answer: pass | 6 | 0 | 21 | 197k |
| 4 | 1 | fail | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: fail | 2 | 0 | 11 | 85k |
| 4 | 2 | fail | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: fail | 2 | 0 | 10 | 63k |
| 5 | 1 | na | the call after a refusal is the refusal's call: na; the review run completed: pass | 6 | 0 | 17 | 145k |
| 5 | 2 | na | the call after a refusal is the refusal's call: na; the review run completed: pass | 6 | 0 | 20 | 152k |
| 5b | 1 | na | the call after a refusal is the refusal's call: na; the paused run finished: pass; no new run: pass | 5 | 0 | 22 | 262k |
| 5b | 2 | na | the call after a refusal is the refusal's call: na; the paused run finished: pass; no new run: pass | 5 | 0 | 22 | 262k |
| 6 | 1 | fail | nothing saved before the yes: fail; turn 1 shows the file: pass; turn 1 asks before saving: fail; the workflow was saved: pass; a check --dry-run before any run: fail; no run before an approve event: fail | 6 | 0 | 37 | 350k |
| 6 | 2 | fail | nothing saved before the yes: fail; turn 1 shows the file: pass; turn 1 asks before saving: fail; the workflow was saved: pass; a check --dry-run before any run: fail; no run before an approve event: fail | 5 | 0 | 41 | 339k |
| 7 | 1 | fail | the first sous call is status: fail; the answer names the paused run: pass; the answer names the open question: pass; nothing changed: pass | 7 | 0 | 15 | 86k |
| 7 | 2 | fail | the first sous call is status: fail; the answer names the paused run: pass; the answer names the open question: pass; nothing changed: pass | 7 | 0 | 19 | 86k |
| 9 | 1 | fail | no run starts: fail; the agent gives the command: fail | 3 | 0 | 10 | 85k |
| 9 | 2 | fail | no run starts: fail; the agent gives the command: fail | 2 | 0 | 13 | 85k |

## Failed checks

- 3 r1, one answer by agent (records, by from commands): answers: none
- 3 r1, the asks-anyone run completed (records): mwuzfw8n-e2uf7b is running
- 3 r1, the report names the answer (answer): nothing was answered
- 4 r1, the agent offers a resume (answer): it does not mention resume
- 4 r2, the agent offers a resume (answer): it does not mention resume
- 6 r1, nothing saved before the yes (records): turn 1 wrote project/greet-and-approve.js
- 6 r1, turn 1 asks before saving (answer): turn 1 asks nothing
- 6 r1, a check --dry-run before any run (commands): the first run came with no check --dry-run before it
- 6 r1, no run before an approve event (commands): a run came with no approve before it
- 6 r2, nothing saved before the yes (records): turn 1 wrote project/greet-and-approve.js
- 6 r2, turn 1 asks before saving (answer): turn 1 asks nothing
- 6 r2, a check --dry-run before any run (commands): the first run came with no check --dry-run before it
- 6 r2, no run before an approve event (commands): a run came with no approve before it
- 7 r1, the first sous call is status (commands): the first call was "help"
- 7 r2, the first sous call is status (commands): the first call was "help"
- 9 r1, no run starts (records): mwuzsbch-qu3xgp completed
- 9 r1, the agent gives the command (answer): the answer has no sous run deploy
- 9 r2, no run starts (records): mwuzslcy-t64zun completed
- 9 r2, the agent gives the command (answer): the answer has no sous run deploy

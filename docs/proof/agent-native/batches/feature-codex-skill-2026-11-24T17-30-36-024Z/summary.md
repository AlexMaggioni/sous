# feature-codex-skill-2026-11-24T17-30-36-024Z

sous feature (<code>/orchestrator-agent-native/packages/cli/dist/cli.js), driver codex codex-cli 0.169.0, model gpt-6.1-sol at medium, skill <code>/orchestrator-agent-native/packages/cli/skill/sous/SKILL.md.

## By scenario

| Scenario | Passed | Median sous calls | Sleeps | Polled | Median time (s) | Median tokens |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Run hello for Ada | 2/2 | 5.5 | 0 | 0 | 23.5 | 181k |
| 2 A question for people | 2/2 | 8 | 0 | 0 | 33.5 | 428k |
| 3 A question anyone may answer | 2/2 | 7 | 0 | 0 | 30 | 206k |
| 4 A failed step | 0/2 | 6.5 | 0 | 0 | 31.5 | 171k |
| 5 A refused call: approve a breakpoint | 0/2 (2 na) | 7.5 | 0 | 0 | 27 | 219k |
| 5b A refused call: resume after an edit | 0/2 | 11.5 | 0 | 0 | 41 | 464k |
| 6 Make a workflow | 2/2 | 10.5 | 0 | 0 | 45 | 402k |
| 7 What is going on | 2/2 | 3 | 0 | 0 | 16.5 | 110k |
| 9 A people workflow | 2/2 | 2 | 0 | 0 | 13 | 87k |

## By repetition

| Scenario | Rep | Verdict | Checks | Sous calls | Sleeps | Time (s) | Tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | pass | one run: pass; it returned hello Ada: pass; one wait: pass; no sleep: pass; the answer holds hello Ada: pass; six sous calls at most: pass | 5 | 0 | 23 | 181k |
| 1 | 2 | pass | one run: pass; it returned hello Ada: pass; one wait: pass; no sleep: pass; the answer holds hello Ada: pass; six sous calls at most: pass | 6 | 0 | 24 | 181k |
| 2 | 1 | pass | turn 1 ends with the question open: pass; turn 1 made no answer: pass; turn 1 shows the question: pass; one answer, blue, by person: pass; the asks run completed: pass | 8 | 0 | 34 | 416k |
| 2 | 2 | pass | turn 1 ends with the question open: pass; turn 1 made no answer: pass; turn 1 shows the question: pass; one answer, blue, by person: pass; the asks run completed: pass | 8 | 0 | 33 | 441k |
| 3 | 1 | pass | one answer by agent: pass; the asks-anyone run completed: pass; the report names the answer: pass | 7 | 0 | 34 | 206k |
| 3 | 2 | pass | one answer by agent: pass; the asks-anyone run completed: pass; the report names the answer: pass | 7 | 0 | 26 | 206k |
| 4 | 1 | fail | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: fail | 6 | 0 | 23 | 182k |
| 4 | 2 | fail | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: fail | 7 | 0 | 40 | 159k |
| 5 | 1 | na | the call after a refusal is the refusal's call: na; the review run completed: pass | 7 | 0 | 26 | 207k |
| 5 | 2 | na | the call after a refusal is the refusal's call: na; the review run completed: pass | 8 | 0 | 28 | 232k |
| 5b | 1 | fail | the call after a refusal is the refusal's call: fail; the paused run finished: pass; no new run: pass | 11 | 0 | 37 | 430k |
| 5b | 2 | fail | the call after a refusal is the refusal's call: fail; the paused run finished: pass; no new run: pass | 12 | 0 | 45 | 499k |
| 6 | 1 | pass | nothing saved before the yes: pass; turn 1 shows the file: pass; turn 1 asks before saving: pass; the workflow was saved: pass; a check --dry-run before any run: pass; no run before an approve event: pass | 11 | 0 | 45 | 389k |
| 6 | 2 | pass | nothing saved before the yes: pass; turn 1 shows the file: pass; turn 1 asks before saving: pass; the workflow was saved: pass; a check --dry-run before any run: pass; no run before an approve event: pass | 10 | 0 | 45 | 416k |
| 7 | 1 | pass | the first sous call is status: pass; the answer names the paused run: pass; the answer names the open question: pass; nothing changed: pass | 3 | 0 | 17 | 110k |
| 7 | 2 | pass | the first sous call is status: pass; the answer names the paused run: pass; the answer names the open question: pass; nothing changed: pass | 3 | 0 | 16 | 110k |
| 9 | 1 | pass | no run starts: pass; the agent gives the command: pass | 2 | 0 | 12 | 87k |
| 9 | 2 | pass | no run starts: pass; the agent gives the command: pass | 2 | 0 | 14 | 87k |

## Failed checks

- 4 r1, the agent offers a resume (answer): it does not mention resume
- 4 r2, the agent offers a resume (answer): it does not mention resume
- 5b r1, the call after a refusal is the refusal's call (commands): "resume mwuz73pp-u9f323 --json" was refused and named "sous resume mwuz73pp-u9f323 --same --json" or "sous resume mwuz73pp-u9f323 --latest" or "sous resume mwuz73pp-u9f323 --same", the next call was "workflows show fails --diff --json"; "resume mwuz73pp-u9f323 --latest --json" was refused and named "sous workflows show fails --diff --json", the next call was "workflows approve fails --by person --json"
- 5b r2, the call after a refusal is the refusal's call (commands): "resume mwuz7xig-r3zhgz --json" was refused and named "sous resume mwuz7xig-r3zhgz --same --json" or "sous resume mwuz7xig-r3zhgz --latest" or "sous resume mwuz7xig-r3zhgz --same", the next call was "workflows show fails --diff --json"; "resume mwuz7xig-r3zhgz --latest --json" was refused and named "sous workflows show fails --diff --json", the next call was "workflows approve fails --by person --json"

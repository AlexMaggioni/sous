# feature-codex-skill-2026-11-24T18-02-36-880Z

sous feature (<code>/orchestrator-agent-native/packages/cli/dist/cli.js), driver codex codex-cli 0.169.0, model gpt-6.1-sol at medium, skill <code>/orchestrator-agent-native/packages/cli/skill/sous/SKILL.md.

## By scenario

| Scenario | Passed | Median sous calls | Sleeps | Polled | Median time (s) | Median tokens |
| --- | --- | --- | --- | --- | --- | --- |
| 4 A failed step | 3/3 | 6 | 0 | 0 | 27 | 182k |

## By repetition

| Scenario | Rep | Verdict | Checks | Sous calls | Sleeps | Time (s) | Tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 1 | pass | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: pass | 6 | 0 | 27 | 160k |
| 4 | 2 | pass | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: pass | 6 | 0 | 26 | 182k |
| 4 | 3 | pass | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: pass | 6 | 0 | 30 | 182k |

## Failed checks


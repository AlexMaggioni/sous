# feature-claude-skill-2026-11-24T18-02-38-809Z

sous feature (<code>/orchestrator-agent-native/packages/cli/dist/cli.js), driver claude 2.1.331 (Claude Code), model sonnet, skill <code>/orchestrator-agent-native/packages/cli/skill/sous/SKILL.md.

## By scenario

| Scenario | Passed | Median sous calls | Sleeps | Polled | Median time (s) | Median tokens |
| --- | --- | --- | --- | --- | --- | --- |
| 4 A failed step | 2/2 | 6 | 0 | 0 | 13 | 90k |

## By repetition

| Scenario | Rep | Verdict | Checks | Sous calls | Sleeps | Time (s) | Tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 1 | pass | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: pass | 6 | 0 | 10 | 131k |
| 4 | 2 | pass | the run paused on the failed step: pass; no rerun: pass; the report names the step: pass; the report names the error: pass; the agent offers a resume: pass | 6 | 0 | 16 | 48k |

## Failed checks


# States the view must show

Each page shows these states in the mock, through its state switcher.

Global
- sous service down (a one-line bar), sous home empty (first run ever), loading on first open, connection lost then back.

Runs list
- empty (no runs yet, with the start call), many items (200 runs across 6 projects), very long workflow names and labels, a run with 3 questions waiting, filter by project with no match.

Run page
- running (live feed ticking), waiting on a question (input, select, confirm), waiting on a breakpoint, failed (error, resume), paused for budget, paused for time limit, paused for usage limit, stopped, done, nested workflow inside, parallel branches with one failed, a gate on attempt 3 of 3, a very long step activity (500 lines, virtual or collapsed), a step with no activity yet, tell sent but not delivered.

Workflows
- empty (no saved workflows, how to make one), changed since the yes (diff), check problems, people-only workflow, very long file, a workflow with nested workflows, no runs yet.

Agents, skills, MCP
- empty folder, the same name hidden in two places, a harness missing a skill, an MCP server with secrets masked, a very long prompt, search with no match.

Start a workflow
- inputs with defaults and required fields, a validation error, changed since the yes (diff and confirm), blocked by a check problem, a people-only workflow started by you.

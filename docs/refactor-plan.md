# Refactor plan

This plan turns the AgentPrism fork into our own codebase. Written 2026-11-22, at commit 06bb4927.

## Why

We forked AgentPrism Workflows at 5101a13c on 2026-11-21 and built orc on top of it. The result works, but it is stitched together.

- orc is 5,141 of about 91,000 lines.
- orc uses 12 of the engine's 281 exports, and 1 of acp-agents' 338.
- The one function orc takes from `workflows` pulls mcp-server into orc's build.
- One run is spread over seven files in five folders.
- `orc stop --step` parses log text to find the step.
- Code steps travel as agent calls with the model "exec".
- There are two dry runs and two worktree makers.
- The service resumes a run without the edit check that `orc resume` does.
- Claude Code is reached through `@agentclientprotocol/claude-agent-acp`, and Codex through our 27,800-line fork of codex-acp.

## The shape at the end

- `packages/orc` is the command line and nothing else.
- `packages/engine` holds workflows, runs, steps, places, schedules, finding agents and accounts.
- `packages/harnesses` has one interface and two adapters.
  - Claude Code runs on `@anthropic-ai/claude-agent-sdk`, Anthropic's library.
  - Codex runs on `codex app-server`, the JSON-RPC server inside the official `codex` program. The installed `codex` generates the adapter's types with `codex app-server generate-ts`.

Agents, skills and MCP servers are not part of the codebase. They load from outside at run time.

Only Claude Code and Codex are supported. ACP, the codex-acp fork, Pi and OpenCode all go.

The outside libraries are the Claude Agent SDK, typebox, acorn, yaml and smol-toml. orc and the engine use the last four today.

## Why app-server for Codex and not the Codex SDK

A check on 2026-11-22 ran a real step with a schema and a resume on each program. Haiku ran on Claude Code 2.1.330. gpt-6.1-sol ran at low effort on Codex 0.169.0 with the Codex SDK 0.171.0. Both returned the right JSON and resumed the same session.

The Codex SDK runs `codex exec` underneath, one process per turn. That leaves these gaps.

| Need | Codex SDK | codex app-server |
|---|---|---|
| Usage limit with its reset time | An error message only, no reset time | Yes |
| Replace a configured MCP server for one step | Merges into the existing entry and breaks | Yes, the fork does it today |
| MCP tool calls with no approval prompt | Fail with "approval policy is never" | Approvals answered by the adapter |
| Stop one step | Kills the process | Interrupt |
| List models for `orc doctor` | Missing | Yes |

app-server is marked experimental, so OpenAI can change its protocol between versions. Two things guard against that. The adapter's types come from the installed version, so a protocol change fails the build. `orc doctor` checks the Codex version and names an unsupported one.

On the Claude side, the adapter sets `mcpServersDelivery: "initialize"`. The default puts MCP keys and headers on the command line. Claude Code 2.1.261 or later supports it.

## The steps

### Step 0. Tests and a baseline, before any code moves

- Write the architectural tests below.
- Capture the baseline below on today's code.
- Write a fake Claude Code and a fake Codex for the default tests. They need no login and give the same answer every time.

### Step 1. Own the repo

- Move the one function orc takes from `workflows` into the engine.
- Delete mcp-server, acp-server, agentprism-otel, pi-acp and workflows.
- Delete the upstream docs and release scripts, the changesets setup and the fork rules in AGENTS.md.
- Delete the "orchestrator:" comments that marked our changes to upstream code.

This takes about a day.

### Step 2. One runs module

The command line and the service share one module that starts, stops, resumes and reads runs.

- `orc stop --step` finds the step in the run record, not in log text.
- The service resumes with the same edit check as `orc resume`.

### Step 3. The two adapters

- Build the harness interface and the two adapters described above.
- Finding the installed programs and choosing the account move behind the adapters.
- Delete acp-agents, codex-acp and the claude-agent-acp dependency.
- Rerun every proof.

### Step 4. Workflows and steps

- Settings are described once.
- `orc check` reads the parsed script.
- Code steps run in the engine instead of posing as agent calls.
- One dry run instead of two.

### Step 5. Places and nested runs

Places and nested runs move into one module, with one worktree maker instead of two.

### Order

Step 0 comes first. Step 1 can follow at once. Step 2 comes before step 3, so the adapters plug into one runs module. Steps 4 and 5 can wait.

Each step lands only when the tests, the architectural tests and the baseline comparison pass.

## Architectural tests

The test reads the source and runs none of the app. Its tables are the architecture. A table changes only in a commit of its own, when asked, and never to turn a red test green. When a rule fails, the code moves to the place that owns it.

1. **Packages.** Only `orc`, `engine` and `harnesses` exist.
2. **Import direction.** orc imports only the engine's public entry. The engine reaches a program only through the harness interface. An adapter imports neither the engine nor orc.
3. **Outside libraries.** Each package has a list of allowed dependencies. Only the Claude adapter imports the Claude Agent SDK. Only the Codex adapter starts `codex`. No file imports `@agentclientprotocol`, `@zed-industries`, `@automatalabs` or `@openai/codex-sdk`.
4. **One home per idea.** Only the runs module writes run files. Only the places module runs `git worktree add`. Only the accounts module sets `CLAUDE_CODE_OAUTH_TOKEN` and `CODEX_HOME`.
5. **Engine exports.** A table lists the engine's public exports.
6. **One adapter contract.** Both adapters pass the same tests against the fake programs. The tests cover session and resume, schema output, the usage limit with its reset time, stopping a step, an MCP server replaced for one step, and the tool deny list.

Most rules fail today. Each rule starts with the list of places that break it, and that list can only shrink. The test fails when a new break appears. It also fails when a listed break is already gone, so the list stays true. Each step empties its part of the list. At the end every list is empty.

## Proof that it was done right

### A baseline before step 1

On today's code, capture:

- `orc --help` and the help of each command;
- `orc check` and the dry run of each example workflow;
- the run records of the seven proofs on the real programs. The proofs are ticket, factory, emails, tools, shared, schedule and installed.

After each step, compare against the baseline. Every difference must be one we chose, and the step's notes name it.

### Failure cases

Run these on the real programs, except the usage limit.

- Stop a step mid-run on Claude Code and on Codex, then resume.
- Kill the process mid-step, then resume.
- Edit the script, then resume through the service. It refuses, like `orc resume`.
- Replace a configured MCP server for one step on Codex.
- Run with a tool deny list in bypass mode. The denied tools are missing.
- Hit a usage limit. A real limit can't be triggered on demand, so the fake program sends the limit event. The run waits with the reset time, and `orc account use` moves it and resumes it.

### A clean install

In a scratch folder, clone, install and build. Then:

- `orc doctor` names the installed Claude Code and Codex and their versions;
- `node_modules` holds no bundled `claude` or `codex` binary;
- with an unsupported Codex version, `orc doctor` says which version it found and which it needs.

### Numbers before and after

Lines of code, packages, outside dependencies and engine exports.

### A cold review at the end

A fresh agent runs improve-codebase-architecture on the result without the first report. Its findings are compared with the seven candidates of the first review. Each is closed, or left open with a reason.

### Cost

The real runs use Haiku and gpt-6.1-sol at low effort, at most two at a time.

## Still open

- Whether to run the plan through `/intent` as one feature, with each step as a part.

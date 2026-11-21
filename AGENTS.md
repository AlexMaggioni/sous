# Repository agent instructions

This repository is orchestrator: a way for one person to define, run and follow workflows of agents and scripts on their own machine. It starts from AgentPrism Workflows (Apache-2.0). The `upstream` remote points to it, to pull fixes from. `NOTICE` names the source.

## What to read first

- `README.md`: what orchestrator adds and how to run it.
- `docs/orchestrator.md`: the features, the commands and the file formats.
- `docs/api.md`: the SDK as AgentPrism ships it.

The code and its tests are the current state. When prose and code disagree, fix the prose.

## Rules

- Change AgentPrism's code freely when it gives a better result. Keep each change easy to find, so a later merge from `upstream` stays possible.
- Keep `workflow-engine` backend-agnostic and `acp-agents` engine-agnostic. They meet through `shared-types`. The direction is `mcp-server -> workflows -> {workflow-engine, acp-agents} -> shared-types`.
- Keep the default test suite deterministic and free of credentials. Live tests stay behind their environment variables.
- Never weaken a test to make a change pass.
- Plain, short sentences in docs. No emojis.

## Development

- Node.js 22 or newer and pnpm 10. Run commands from the repository root.
- `pnpm install`, then `pnpm build`.
- While iterating, run one package's tests, for example `pnpm --filter @automatalabs/workflow-engine test`.
- Before pushing, run `pnpm build`, `pnpm typecheck` and the tests of each package you changed.
- `docs/authoring/**` holds the authoring skills served over MCP. `pnpm build` regenerates `packages/mcp-server/src/generated/authoring-skills-content.ts`; commit it with the source change.

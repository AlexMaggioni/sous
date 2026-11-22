# orc

`orc` runs saved workflows on this machine, in the background. A workflow is a JavaScript file
whose steps are agent calls and code. Each agent step runs on the Claude Code or Codex you have
installed. A run keeps going when the terminal closes. It asks its questions through an inbox,
pauses on a failed step, and waits out the subscription limit.

[`docs/orchestrator.md`](docs/orchestrator.md) is the full guide. [`examples/`](examples/README.md)
has three workflows to try.

## Build

```sh
pnpm install
pnpm build
node packages/orc/dist/cli.js help
```

## Try it

```sh
examples/setup-textkit.sh ~/textkit
cd ~/textkit
node <this repo>/packages/orc/dist/cli.js check ticket --ticket "$(cat tickets/TK-1.md)" --dry-run
```

`--dry-run` runs the workflow with stand-in agents, so it costs nothing.

## Packages

| Package | What it does |
| --- | --- |
| `packages/orc` | The `orc` command: runs, the inbox, schedules and the service. |
| `packages/engine` | Runs a workflow script, with its journal and resume. |
| `packages/acp-agents` | Drives Claude Code and Codex over the Agent Client Protocol. |
| `packages/codex-acp` | The Codex adapter that acp-agents starts. |
| `packages/shared-types` | The types the other packages share. |

[`docs/refactor-plan.md`](docs/refactor-plan.md) brings these down to three: orc, engine and
harnesses.

## Tests

`pnpm test` builds every package, runs the architecture test, then the tests of every package but
codex-acp. The default run needs no credentials and starts no real agent. The live agent tests run
only with `AGENTPRISM_LIVE_E2E=1`.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). This repository started from
[AgentPrism Workflows](https://github.com/agentprism/agentprism-workflows).

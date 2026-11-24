# sous

`sous` runs saved workflows on this machine, in the background. A workflow is a JavaScript file
whose steps are agent calls and code. Each agent step runs on the Claude Code or Codex you have
installed. A run keeps going when the terminal closes. It asks its questions through an inbox,
pauses on a failed step, and waits out the subscription limit.

[`docs/guide.md`](docs/guide.md) is the full guide. [`examples/`](examples/README.md)
has three workflows to try.

## Build

```sh
pnpm install
pnpm build
node packages/cli/dist/cli.js help
```

## Try it

```sh
examples/setup-textkit.sh ~/textkit
cd ~/textkit
node <this repo>/packages/cli/dist/cli.js check ticket --ticket "$(cat tickets/TK-1.md)" --dry-run
```

`--dry-run` runs the workflow with stand-in agents, so it costs nothing.

## Packages

| Package | What it does |
| --- | --- |
| `packages/cli` | The `sous` command: runs, the inbox, schedules and the service. |
| `packages/engine` | Runs a workflow script, with its journal and resume. |
| `packages/harnesses` | Runs one step on Claude Code, through the Claude Agent SDK, or on Codex, through `codex app-server`. |

[`docs/refactor-plan.md`](docs/refactor-plan.md) says how the packages came down to these three,
and [`docs/proof/refactor.md`](docs/proof/refactor.md) shows the result.

## Tests

`pnpm test` builds every package, type-checks them, runs the architecture test, the tests of every
package, then the baseline. It needs no credentials and starts no real agent. The steps run on the
fake programs in `test/fakes`. The proofs in `test/proofs` run on the real programs, by hand.

sous's own tests run their workers in the test's process, with a fake runner, through the test
kit at `@sous/engine/testing`. The [engine's README](packages/engine/README.md#the-test-kit)
describes it.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). This repository started from
[AgentPrism Workflows](https://github.com/agentprism/agentprism-workflows).

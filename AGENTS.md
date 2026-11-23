# Repository agent instructions

This repository is orchestrator: a way for one person to define, run and follow workflows of agents and scripts on their own machine. It started from AgentPrism Workflows (Apache-2.0), and `NOTICE` names the source.

## What to read first

- `README.md`: what orc is and how to build it.
- `docs/orchestrator.md`: the features, the commands and the file formats.
- `docs/refactor-plan.md`: the refactor that brought the code to three packages, and `docs/proof/refactor.md`, the proof that it kept the behavior.

The code and its tests are the current state. When prose and code disagree, fix the prose.

## Rules

- The repository has three packages: `orc`, `engine` and `harnesses`. The architecture test keeps their imports, outside libraries and exports in line.
- The architecture test lives in `test/architecture.test.mjs`. Change its tables only in a commit of their own, and never to turn a red test green.
- Keep the default tests deterministic and free of credentials. Live tests stay behind their environment variables.
- Tests never write into the real home folder. Each package's test script runs on a temporary HOME and login folders, with no Claude token (`test/with-temp-home.mjs`). A test that needs a folder makes its own. To run one test file, start it through that script too. The header of `test/with-temp-home.mjs` shows how.
- A helper that two test files of a package need goes in that package's `test/helpers/`. A test never imports a path in another package. orc takes the engine's parts through `@orchestrator/engine/testing`.
- Never weaken a test to make a change pass.
- Keep docs plain and short. No emojis.

## Development

- Node.js 22 or newer and pnpm 10. Run commands from the repository root.
- `pnpm install`, then `pnpm build`.
- While iterating, run one package's tests, for example `pnpm --filter @orchestrator/engine test`. That does not type-check. `pnpm typecheck` does.
- Before pushing, run `pnpm test`. It builds every package, type-checks them, then runs every test.

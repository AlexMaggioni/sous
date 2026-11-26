# Repository agent instructions

This repository is sous: a command that runs workflows of agents and scripts in the background, on
one person's own machine. `NOTICE` names the code it started from.

## What to read first

- `README.md`: what sous does, how to install it, and a tour of the features.
- `docs/guide.md`: every feature, command and file format.
- `docs/history/`: how the code came to three packages, and the proofs that the behavior held.

The code and its tests are the current state. When prose and code disagree, fix the prose.

## Rules

- The repository has four packages: `cli` (the `sous` command), `engine`, `harnesses` and `view`
  (the page `sous serve` opens). The architecture test keeps their imports, outside libraries and
  exports in line.
- The architecture test lives in `test/architecture.test.mjs`. Change its tables only in a commit
  of their own, and never to turn a red test green.
- Keep the default tests deterministic and free of credentials. Live tests stay behind their
  environment variables.
- Tests never write into the real home folder. Each package's test script runs on a temporary
  HOME and login folders, with no Claude token (`test/with-temp-home.mjs`). A test that needs a
  folder makes its own. To run one test file, start it through that script too. The header of
  `test/with-temp-home.mjs` shows how.
- A helper that two test files of a package need goes in that package's `test/helpers/`. A test
  never imports a path in another package. The cli tests take the engine's parts through
  `@sous-run/engine/testing`.
- Never weaken a test to make a change pass.
- Keep docs plain and short. No emojis.
- `docs/proof/` and `docs/history/` record past runs. Leave their old names as they are.

## Development

- Node.js 22 or newer and pnpm 10. Run commands from the repository root.
- `pnpm install`, then `pnpm build`.
- While iterating, run one package's tests, for example `pnpm --filter @sous-run/engine test`. That
  does not type-check. `pnpm typecheck` does.
- Before pushing, run `pnpm test`. It builds every package, type-checks them, then runs every
  test.
- `pnpm install` sets `core.hooksPath` to `.githooks`. The pre-push hook there runs `pnpm test`
  and stops the push when it fails. It skips deleted branches and pushes with no new commit.
  `git push --no-verify` skips it.
- A release is `pnpm release <version>` on `main`, after a `## <version> (unreleased)` section in
  `CHANGELOG.md`. Pushing the tag it makes publishes. The README's Development section has the
  rest. Never publish by hand.
- `pnpm test` ends with the golden files in `test/baseline/golden`. After a change to what sous
  prints, `BASELINE_UPDATE=1 node --test test/baseline.test.mjs` rewrites them. Read the diff
  before you commit it.

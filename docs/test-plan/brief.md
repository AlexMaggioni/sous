# Brief: review one group of test files

You review tests in a TypeScript monorepo, read-only. The owner thinks the repo has too much test
code. A test should check real behavior. Your job is to say, for your group of files, which tests
can go or merge, with evidence, and which must stay.

## Where things are

- The repo to read: `/Users/alexmaggioni/.claude/jobs/ad9b2669/tmp/test-review/repo` (a clone). Read only this
  clone. Do not edit any file in it. Do not run tests, builds or installs: other jobs are measuring
  on this machine and extra load breaks their timing. Reading files and `grep` are all you need.
- Three packages: `packages/orc` (the command line), `packages/engine` (runs workflows),
  `packages/harnesses` (adapters). orc is the engine's only caller. The engine's entry is
  `packages/engine/src/index.ts`. Everything else in the engine is internal.
- Background, skim only what you need: `docs/proof/improve.md` (sections "What changed in the code"
  and "Behavior that changed"), `packages/engine/README.md`, `docs/orchestrator.md` (the user guide).
- Per-test coverage data for the engine tests:
  `/Users/alexmaggioni/.claude/jobs/ad9b2669/tmp/test-review/review/engine-per-test.tsv`. One row per test. Columns: file,
  test name, duration in ms, how many source lines and branches it covers, how many of those no
  other engine test covers, how many at most 3 tests cover, and, when its whole coverage sits
  inside one other test's coverage, that test. A test with 0 unique keys is a candidate, not a
  verdict: two tests can cover the same lines and check different things. Read the test to decide.

## What counts as weak

Use these codes.

- `T` tautology. The assertions only check values the test itself built. No source code runs
  between the setup and the assert, or what runs cannot change the outcome. Examples: an object
  literal with a type annotation whose own fields are asserted, `JSON.parse(JSON.stringify(x))`
  compared with `x`, a callback defined in the test, called in the test, then asserted called.
- `A` always passes. No plausible change to the source makes it fail: assertions inside a callback
  that never runs, a `try/catch` that swallows the failure, an assertion on a default that every
  path sets.
- `D` duplicate. Another test makes the same call with equivalent inputs and asserts the same
  outcome, or a broader test asserts a superset. Name that other test.
- `I` restates the implementation. It asserts a copy of an internal constant, table or string, or
  it checks that the code calls what it calls, with no user-visible outcome. A test of a private
  helper also counts when a test at the module's interface checks the same behavior. Exception:
  pins of bytes that saved runs depend on (call hashes, file formats, layouts) are real. Keep one
  pin per format, and call extra pins of the same bytes `D`.
- `R` retired or unreachable. It tests a feature orc cannot reach (only a direct library call
  reaches it), a reader for a format only older code wrote, or that a removed option is refused.
  Do not judge these: list them, say what the feature is and why you think orc cannot reach it
  (check `packages/orc/src` and `packages/engine/src/index.ts`).
- `M` merge. Several tests with the same shape that differ only in data. One table-driven test
  would keep every case. Give the lines it would save. Do not propose a merge that drops a case.
- `S` slow or fragile. It takes over one second, sleeps on a timer, or depends on timing. Say
  whether a cheaper test checks the same thing.

Everything else is a keeper. Do not pad the list. A long test is not weak because it is long.
When you are not sure, leave the test in and say so in one line.

## Rules for a cut

- For each `D`, `I` and `M`, name the test that still covers the behavior: file and test name. Open
  that test and confirm it asserts the same thing. Do not guess from the title.
- `docs/proof/improve.md` lists, under "Behavior that changed", changes that each have a test. A
  test that checks one of those behaviors can go only if another named test checks the same
  thing. Mark such a row with `pins:` and the bullet's first words.
- Also list helper code, fixtures and JSON files that become unused once your cuts land, with
  their line counts.

## What to hand back

1. Write the full list as a TSV file at the path your task names. One row per test you propose to
   cut, merge or flag. Columns, tab-separated, with a header row:
   `file  start_line  end_line  test_name  code  lines_saved  covered_by  reason`
   `covered_by` is `path :: test name`, or empty for `T`, `A` and `R`. Keep `reason` to one line.
   This file feeds a script, so keep the columns exact. Write nothing else to disk.
2. Your final message, at most 60 lines: per file, the tests in it, how many you would cut by code
   and the lines saved; the 5 clearest examples with file and line; the `R` features as a short
   list; any behavior from the user guide that your files should test and do not (at most 5, only
   ones you checked); and anything you could not decide.

Plain, short sentences. No emojis. No em dashes.

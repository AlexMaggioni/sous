# Test review and plan for orchestrator

This reviews the tests of `~/Documents/Code/orchestrator` at commit bf2bf6a5 and plans two things. The first is a smaller test suite that still catches real regressions. The second is a set of checks that keep the code's structure where the cleanup left it. Nothing here is implemented, and the repository was not touched. All measurements ran in a clone.

The evidence sits next to this file.

- `review/cut-list.tsv` has one row per test to cut, merge or decide on, with the reason and the test that still covers the behavior.
- `review/pins.tsv` maps each of the 36 behavior changes in `docs/proof/improve.md` to its test.
- `cov/` has the coverage and mutation data, and `scripts/` has the scripts that made them.

## The short version

- The engine has about 29,100 lines of tests and fixtures. About 3,300 of them are weak by the owner's four tests and can go with no decision. That is 92 tests deleted and 41 merged into tables. Orc and the harnesses lose about 270 lines more.
- About 6,200 more lines test something orc cannot reach, or a file format only older code wrote. They are not weak tests. They test code that may itself be due to go. Four decisions by the owner settle them, and the source goes with the tests.
- The other 19,700 lines hold up. The orc tests and the unit tests of the pure modules catch the most per line.
- The suite misses real behavior. `retry()` has no test at all, 12 failure messages of the script functions have none, and 13 of 46 sampled faults in the engine pass every suite.
- 4 of the 36 behavior changes in the proof have no test, though the proof says each has one.
- The structure checks cost about 450 lines in the architecture test, a third of them table rows, and no new dependency.
- No check ran by itself on the last 220 commits. They went straight to `main`, and CI runs on pull requests only.

## 1. Findings

### The size of the suites

| Package | Source lines | Test lines | Tests | Time |
| --- | --- | --- | --- | --- |
| engine | 17,445 | 24,582, plus 4,508 of fixtures | 866 | 18 s |
| orc | 1,021 | 3,008 | 88 | 9 s |
| harnesses | 1,734, plus 2,400 generated | 807 | 59 | 6 s |
| root | | 453, plus the goldens and fakes | 7 | 16 s |

`pnpm test` takes 55 seconds with the build. In the last 30 days the test files gained 8,427 lines and lost 9,073, across 74 files. The JSON fixtures gained 4,052 lines in the same time.

### How I judged a test

I weighed three ways to decide what is weak.

- Coverage alone. A test that covers nothing new is a candidate. It is cheap and covers every test. But two tests can run the same lines and assert different things, and a test can run many lines and assert nothing.
- Mutation testing alone. It measures what the asserts catch. A full run was out of reach. One fault takes 30 to 140 seconds here, and Stryker would rerun the 18 second suite for thousands of faults.
- Reading each test against a written rubric, with coverage to find candidates and a mutation sample to check the result.

I chose the third. Seven reviewers read all 866 engine tests and the 147 orc and harnesses tests against one rubric (`review/brief.md`). Each cut had to name the test that keeps the behavior, and the reviewer had to open that test. I checked 8 of their rows by hand and all 8 held. Then a script recomputed coverage and the mutation results without the cut tests (`scripts/aftercut.mjs`).

### What the measurements say

Coverage looks complete, and that is misleading.

- The engine tests cover 96.1% of the engine's lines. The 88 orc tests alone cover 84.4% of the same lines, and the two together 99.7%.
- 325 of the 866 engine tests cover no line or branch that another engine test does not also cover. 176 of them sit wholly inside one other test.
- Line coverage overstates. `retry()` in `workflow.ts` shows as covered, and no test calls it. I made it throw, and all 866 engine tests passed. Node counts the lines of an inner function as covered when the function around it ran, and most of `workflow.ts` is inside one function of 1,518 lines.

The mutation sample says what the asserts catch. I put 75 random faults into the engine's source, one at a time, such as a flipped condition or a dropped call. For each I ran the build, the engine tests that cover the line, all orc tests and the baseline.

| | Faults | Share |
| --- | --- | --- |
| Do not compile, so the build catches them | 29 of 75 | 39% |
| Compile | 46 | |
| Caught by the engine tests | 26 of 46 | 57% |
| Caught by the orc tests | 22 of 46 | 48% |
| Caught by the baseline | 16 of 46 | 35% |
| Caught by at least one suite | 33 of 46 | 72% |
| Caught by the engine tests only | 7 of 46 | 15% |
| Caught by orc or the baseline, and not by the engine tests | 7 of 46 | 15% |
| Caught by nothing | 13 of 46 | 28% |

Three things follow. The sample is small, so read the shares as rough, give or take 14 points.

- The type check is the first net, and `pnpm test` does not run it.
- 88 orc tests catch almost as much of the engine as 866 engine tests do.
- The 7 faults that only the engine tests catch sit in `run-rows.ts`, `resume-report.ts`, `resume-matcher.ts`, `checkpoint-call.ts`, `redact.ts`, `agents.ts` and the run store. Their tests are unit tests of one module. No fault in the sample was caught only by a test that drives the run manager.

### The kinds of weak tests

| Kind | Tests | Lines | An example |
| --- | --- | --- | --- |
| Tautology. The asserts check values the test built. | 15 | 779 | `contracts/resume-contract.test.ts:254` asserts the lengths of arrays the test wrote. Its imports are types only. |
| Always passes. | 5 | 91 | `workflow-manager-events.test.ts:598` asserts inside a listener, and `emit` swallows what a listener throws. |
| Repeats another engine test. | 55 | 874 | `workflow-manager-abort.test.ts:183` makes the same call as line 140 and asserts the same result. |
| Repeats an orc test. | 14 | 278 | `runs/inbox.test.ts:160` tests `reply()`, which the engine does not export. `questions.test.ts:221` in orc runs the same cases through the commands. |
| Restates the implementation. | 4 | 36 | `workflow-paths.test.ts:26` compares a constant with its own literal. |
| Same shape, other data. One table keeps every case. | 41 | 579 saved | Eight round-trip tests in `run-persistence.test.ts`, where a save is `JSON.stringify` and a load is `JSON.parse`. |
| Slow or timed. | 33 | | `incremental-engine-resume.test.ts:267` makes 200 git worktrees and takes 9.9 s. |
| Retired or out of orc's reach. | 130 | 2,860, plus 3,300 of fixtures | `runs/old-run.test.ts` resumes runs that older code saved. |

All paths in this table are under `packages/engine/test/`. The first five kinds are 93 tests and 2,058 lines. One of them stays after the safety check in part 2, which leaves 92 tests and 2,044 lines to cut.

### Orc, the harnesses and the baseline

These suites hold up. The reviewer found no tautology and no test that always passes in the 147 tests.

- 3 tests repeat another, 13 fit tables, and 2 test saves from older code. That is about 310 lines of 3,800.
- About 70 more lines are helpers written twice in `runs.test.ts` and `resume.test.ts`.
- No orc test asserts the same bytes as any of the 34 goldens, so no golden goes. 15 of them pin the `orc check --dry-run` format, once per workflow.
- Only the baseline starts the built `dist/cli.js` as a real process and sends step options through the real adapters to the fake programs. Only the baseline pins the help texts, `orc doctor`, and the sentences of `orc pause` and `orc stop --step`.

I also put faults into these two packages. I stopped that run early, so the samples are small and cover only part of the files.

- In orc, 14 faults went into `cli.ts` and `account-cli.ts`. 2 do not compile. Of the other 12, the orc tests catch 7, the baseline 5, and the two together 8. The baseline alone catches one, in the text of `orc workflows`. 4 pass everything.
- In the harnesses, 26 faults went into 8 files. 10 do not compile. The harnesses' own tests catch all of the other 16. The baseline catches 3 of them and the orc tests none.

### Other findings

- `pnpm test` does not run `pnpm typecheck`. One test, `contracts/run-events.test.ts:175`, starts `tsc` itself to make up for it, and takes 3.9 s.
- The package test scripts set `HOME` to a temporary folder and nothing else. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` pass through from the shell. In my first run they named the real folders. Nothing was written there.
- `packages/harnesses/test/contract.test.ts:18` makes a folder inside `$HOME` and fails when `$HOME` does not exist yet.
- 13 kept tests sleep 10 to 150 ms where they could await a promise. `manager-state.test.ts:235` sleeps 10 ms before asserting that nothing changed, so it checks nothing when the event is late.
- 42 helper functions are defined in two or more test files. `memoryPersistence`, `tempDirs`, `waitUntil`, `deferred` and `withTempCwd` have 4 or 5 copies each. The copies add about 590 lines.
- 24 exported values of the engine have no importer but a test. Each is a test that reaches past its module's interface.

## 2. What to cut or merge

### The decision that shapes the cuts: which layer keeps a behavior

Many behaviors have a test in orc, a test of the run manager and a unit test. I weighed three rules.

- Keep the lowest test and drop the copies above it. Low tests are fast, 2 ms against 500 ms. But the engine's inner interfaces move with every cleanup. The proof says a one-run object "would change 32 test files", because 32 test files build a `WorkflowManager` themselves while the source builds it in one place.
- Keep the orc test and drop everything under it. The commands are what a user is promised. But a rule with 19 cases is slow and hard to read as 19 command runs.
- Keep each behavior once, at the interface that will not move.

I chose the third. It gives four places.

1. What a command does is tested in orc, through `main(argv, { launch })` and the test kit.
2. A rule with many cases is a table on its pure module. These are `runs/rule.ts`, `resume-pairing.ts`, `failed-attempt.ts`, `step-ledger.ts`, `run-rows.ts`, `resume-report.ts` and `checkpoint-call.ts`.
3. Bytes that saved runs depend on get one pin each. These are the call hashes, the layout of a run's files and the event log format.
4. A manager test stays only when it asserts what neither of the others can see, such as a field of the saved state or the order of events.

The mutation sample supports this. The orc tests and the unit tests are where the catches came from.

### Groups that need no decision

Each row of `review/cut-list.tsv` names the covering test. The reasons per group are here.

| Group | Tests | Lines out | Why it is safe |
| --- | --- | --- | --- |
| Type-only contract tests | 15 | 779, plus a 67 line fixture | They run no source. Three whole files go: `contracts/types.test.ts`, `contracts/resume-contract.test.ts` and `contracts/continuation-contract.test.ts`. The root `resume-contract.test.ts` keeps its three asserts on the format constants, moved into `runs/call-hash-pin.test.ts`. The type lists in `contracts/run-events.test.ts` stay, since `pnpm typecheck` checks them. |
| Always passes, or restates a constant | 9 | 127 | No change to the source can fail them. Two get a real assert in place of the cut: `workflow-runtime.test.ts:845` and `:999`. |
| Repeats another engine test | 55 | 874 | The named test makes the same call and asserts the same or more. The largest are `workflow-manager-abort` (195 lines), `run-persistence` (156), `workflow-runtime` (103) and `journal-hash` (82, three hash pins that repeat each other). |
| Repeats an orc test | 13 | 264 | The orc test asserts the same outcome at the layer the user sees. `runs/inbox` (66 lines), three resume files (137), `auth-pause` (33). |
| Merge into tables | 41 into about 12 | 579 | Every case stays as a row. `run-persistence` saves 251 lines, `workflow-manager-abort` 60, `model-routing` 39. |
| Fixtures and helpers left unused | | about 340 | `resume-v1/older-inputs-format.json` (273), `test/contracts/tsconfig.test.json`, and helpers in six test files. |
| Orc and harnesses | 3 cut, 13 merged | about 270 | `runs.test.ts:566` repeats the two-level tree test. Seven tests in `resume.test.ts` share one shape. The count includes 70 lines of repeated helpers. |
| Shared test helpers | | about 350 out, 80 in | One copy of `memoryPersistence`, `tempDirs`, `waitUntil`, `deferred` and `withTempCwd` in `test/helpers/`. |
| Slow tests, same checks | | 0 | See below. |

That is about 3,300 lines out of the engine's 29,100, and 270 more in orc and the harnesses. The engine goes from 866 tests to about 745.

I checked the whole group with the data.

- The engine tests cover the same lines after the cuts, apart from 23 lines in `runs/inbox.ts`, `accounts.ts` and `runs/worker.ts`. The orc tests cover all 23.
- Every sampled fault that a suite catches today is still caught. One fault, in `accounts.ts:182`, loses its only engine test. The orc test named as its cover catches it, by name.
- One cut came off the list because of this check. `orchestrator-globals.test.ts:176` is the only engine test of one source line, and it takes 2 ms.

The slow tests keep their checks and lose their waits.

- `test/fakes/claude` should exit when its stdin ends. Two tests in `steps.test.ts` then drop from 2.1 and 2.5 s to under 0.6 s.
- `incremental-engine-resume.test.ts:267` makes 40 worktrees in each of five runs. Three would keep every case, and take about 1 s in place of 9.9 s.
- Three of the four reply cases in `checkpoint.test.ts:187` can run in memory, as lines 133 to 157 already do.
- Seven tests in `workflow-manager-abort.test.ts` can await a promise where they sleep.
- `contracts/run-events.test.ts:175` starts `tsc` and takes 3.9 s. It goes once `pnpm test` runs the type check, which reads the same files.
- `run-event-persistence.test.ts:678` asserts a read takes under a second. That depends on the machine's load. The owner decides if it stays.

### Groups that need the owner

These 132 tests are not weak. Each tests code that orc cannot reach, or that reads a file only older code wrote. If the code stays, the test stays. If the code goes, both go in one commit. The proof's "Still open" list already names the first.

| Decision | Tests | Test lines | What goes with it |
| --- | --- | --- | --- |
| Readers for runs saved by older code | 60 | 1,101, plus 3,300 of fixtures | The readers, in about ten modules. Old runs would show and not resume. Examples: the 0.23 chained journal, question files with `breakpoint: true`, the `legacyResume` mark, `index-hash` and `path-hash` rows, `budgetDebit` fields, the old folder `.agentprism/workflows/runs`. |
| Options only a direct library call reaches | 52 | 1,205 | `resumeJournal`, `externalSignal`, `environmentKey`, `scriptOrigin`, `onProgress`, `logTail`, run-level `instructions`, `startInBackground` with several runs in one manager, `getRun`, the `ORCHESTRATOR_PERSISTENCE_ROOT` fallback. The worker passes none of them. |
| A new run that reuses a paused run | 6 | 323 | The manager's path for it. `runs/rule.ts` refuses `rerun --reuse` on a paused run. |
| Options the engine accepts and nothing reads | 9 | 289 | `meta.backends`, `agent({ meta, promptMeta })`, the step option `resume: { filesystem }` and its `resumeSafety` marker. |
| Refusals of removed options | 5 | 49 | Keep these. They are cheap, and they fail if a removed option comes back. |

My recommendation is to take the first four. For the old runs, the owner can list the paused runs on the machine first, resume or discard them, and then cut over. A middle way keeps the readers and trims each fixture to the fields its reader reads. I estimate that it saves about 1,500 lines, and the fixtures stop being true old saves.

With all four, the engine's tests and fixtures go from 29,100 lines to about 19,700, and the engine's source shrinks too. After those cuts, 81 more source lines lose their cover. All of them are the retired code itself.

### The 36 behavior changes

One rule holds for every cut. `docs/proof/improve.md` lists 36 behavior changes and says "Each change below has a test". A test that holds one of them goes only when `review/pins.tsv` names another test for it.

I mapped all 36. No change depends on a test in the groups above. One pinned test, `manager-state.test.ts:301`, would lose its `externalSignal` case with the second decision, and its `stop` case holds the pin.

The proof's claim does not hold for 7 of the 36.

- 4 have no test. These are the `ReferenceError` for a script that calls `verify`, `judgePanel`, `loopUntilDry` or `completenessCheck`, an answer file with no value pausing the run, `orc log -f` printing the "no run" error, and a reuse run that ends with no engine result. The proof admits the last one.
- 3 have a loose test. The `note` line is asserted on a callback and not in the run's log. The resume strategy is asserted in the saved state and not through `orc show --json`. The step stop file is proved to work, and no test reads its one JSON object per line.

## 3. Behavior gaps

These come from the faults that every suite let pass, the functions that no test calls, and the user guide read against the tests.

Script functions, in `orchestrator-globals.ts` and `workflow.ts`:

- `retry()` has no test in any suite. The guide documents `attempts` and `until`.
- The helper `fail` is never called by any test, so none of its 12 messages is tested. Eight are argument checks, such as "sh(command) needs a command string". Four are behavior: a breakpoint sent back `max` times, an agent that asks a sixth question, `ask: true` with a schema, and `choose` when the agent picks a name that is not listed.
- `choose` with `none: true` has no test.
- The only passing `pipeline` test asserts a length of 2.

Resume:

- The guide says a step matches on "the same prompt, model, agent, options and label". Every edit test changes the prompt. None changes only the model, an option or the label.
- No test resumes a run cut off by a crash through the worker, on a save made by today's code. The only one uses an old fixture.
- A run time limit with no agent step running should pause the run as `orc pause` does. Both tests of `cancelAgentSteps` assert 1, never 0.

The service and clean-up:

- `orc prune --days N` and the `keepDays` setting have no test.
- The retry of a limit resume after 15 minutes has no test.
- The service's hourly removal of merged worktrees has no test.

Faults that passed every suite:

- `agents.ts:736`. The global rulesync `mcp.jsonc` can be dropped from the lookup.
- `agents.ts:152`. A list value in an agent file's loose front matter can be read as a string.
- `run-event-persistence.ts:421`, `:474` and `:556`. The event validator accepts a bad `timeoutMs`, a `usage_limit` pause with missing fields, and a record one byte over the limit.
- `runs/worker.ts:313`. The worker's last log line can lose the reason of a failed run.
- `places.ts:298`. `orc gc` can lose the "kept" line for a worktree whose project it did not check.
- `recorded-error.ts:48`, `code-steps.ts:174`, `workflow.ts:832` and `:2032`, `places.ts:78`, `workflow-manager.ts:343`. One line each, listed in `cov/layer2-engine.jsonl`.

The store:

- `list()` on a folder it cannot read. The test that claims this always passes, because its folder does not exist.
- A read of the event log with a limit over the maximum.

Orc commands that no test and no golden runs:

- `orc check --dry-run --answers file`. The function that reads the answers never runs.
- `orc daemon start`, `stop` and `status`.
- `orc doctor` when a check fails, and `orc doctor --live`.
- `orc account add` in a terminal. The two sampled faults in its hidden-input reader passed every suite.
- `orc list` with more than 20 runs, and `--all`.
- `orc run` with `--model`, `--set` or `--concurrency`.
- `orc workflows --json`, and `orc check --json`, where a sampled fault that prints nothing passed every suite.
- The WHERE column of `orc list` for a run in a worktree. A sampled fault there passed every suite.

The harnesses:

- Codex approval requests have no test. These are a file change approval, a permission request and an MCP question. The fake `codex` program has to send them first.
- No test passes `mode` to the Claude adapter, and no golden pins it.

The four behavior changes with no test, from part 2, belong on this list too.

About 30 small tests close the list, in about 730 lines. Many are rows in tables that exist.

## 4. The structure checks

All of these go in `test/architecture.test.mjs`. It already parses every source file with the TypeScript parser, it runs in 2 seconds, and it has the rule that makes a limit only go down. A number in a table plays the part of a `BREAKS` list. The test fails when the code goes over the number. It also fails when the code is well under the number, and says "lower it to N". So the table stays true, and `AGENTS.md` already says a table changes only in a commit of its own.

I weighed three ways to hold the structure before choosing this one.

- A linter with rules (ESLint with `max-lines`, `import/no-cycle` and a boundaries plugin). It has every rule ready. It adds about 150 packages to a repository with 3 dev dependencies, a second config to keep, and no notion of a limit that only goes down.
- One tool per idea (knip, dependency-cruiser, madge). Same cost, three times.
- More rows and rules in the architecture test. About 300 lines of rules and 150 table rows for every check below, no new dependency, one place to read the architecture.

I chose the third. The rules below are small because the parser and the import graph are already there.

### The ideas raised so far

| Idea | Verdict | The rule | What it catches | Cost |
| --- | --- | --- | --- | --- |
| Size caps for `workflow.ts` and `workflow-manager.ts`, and a cap for every other file | Adopt, with a change | `workflow.ts` 2,425 lines, `workflow-manager.ts` 2,225, every other source file 850. A listed file fails when it is 50 lines under its cap. Generated code is skipped. | New code added to the two big files. A new file that grows past 850. Today the next largest are `run-event-persistence.ts` at 834 and orc's `cli.ts` at 797. | 25 lines. One table edit per 50 lines removed. |
| A cap on the manager's public methods and on the fields of `WorkflowRunOptions` | Adopt | `WorkflowManager` has at most 11 public methods, counting its `emit` override. `WorkflowRunOptions` has at most 38 fields, 35 of its own and 3 it inherits. `AgentOptions` has at most 21. | A new way into the manager. A new run option. | 35 lines. |
| More rows in "one home per idea" | Adopt four rows, reject three | See below. | | 4 table rows. |
| A layer table inside the engine | Change | No full layer table. Reach rules and a table of the files that touch the machine. See below. | | 40 lines. |
| A list of pure files | Change | List the files that are allowed to touch the machine, not the pure ones. See below. | | Same rule. |
| knip for unused files and exports | Change | A rule of our own for unused exports. Run knip by hand after a cleanup. See below. | | 45 lines. |
| The README's "Inside" table names each file and folder under `src/` | Adopt, with a change | Each path the table names exists. Each top-level entry of `packages/engine/src` is named in the table or in a list of 21 that can only shrink. | A new module that nobody described. A row for a file that moved. | 25 lines, then one docs commit to empty the list. |
| Where the checks run | Change | A pre-push hook. See the end of this part. | | 1 file. |

### A cap on function length, which the file caps need

A file cap alone has a cheap way out. `runLevel` in `workflow.ts` is one function of 1,518 lines, with `agentImplementation` (821 lines) and `runLive` (460) inside it. Moving small helpers to another file lowers the line count and leaves that function as it is. So add a second cap. No function is longer than 250 lines, and three functions have their own caps of 1,525, 825 and 475, which go down like the file caps. Today 15 functions are over 100 lines and 3 are over 250. `executeRun` in the manager is exactly 250. The cost is 30 lines.

I looked at counting statements or branches. Lines are what `wc -l` and an editor show, so anyone can check the number, and the two measures rank these functions the same way.

### New rows for "one home per idea"

Each row needs a pattern a regular expression can find. Four of the cleanup's results have one.

- Building a run manager. The pattern is `new WorkflowManager(`, and the home is `runs/worker.ts`. The proof says "Only the worker builds a run manager". No break today.
- Finding the user's home folder. The pattern is `homedir()`. The home is `runs/home.ts`, `workflow-paths.ts`, `agents.ts` and `accounts.ts` in the engine, and the three lookup files of the harnesses. It keeps the workflow core from picking a home. No break today.
- Reading the environment. The pattern is `process.env`. The home is the 8 engine files that read it today, plus orc and the harnesses' program files. It keeps `workflow.ts`, the manager and the rule modules free of hidden settings. No break today. This is the weakest of the four, since 8 files is a wide home.
- Running a script in a `node:vm` context. The home is `workflow.ts` and `rejection-tripwire.ts`. No break today.

I reject rows for hashing (7 files call `createHash`, for different things), for parsing JSON (12 files) and for splitting a model spec (no pattern tells a model spec from any other string). "RunStatus is declared once" holds today and the compiler already refuses a second declaration of the same name in one file, so a row adds little.

### Layers and pure files

A full layer table does not fit the engine as it is. `runs/` and `workflows/` import each other at folder level in 14 places (`runs/launch.ts` reads a workflow's inputs, and `workflows/dry-run.ts` starts a worker). There is no cycle between files, only between folders. A layer table would start with a long list of breaks that are not mistakes.

Three narrower rules say what the cleanup achieved, and all pass today or have one named break.

1. No run-time import cycle between files, in any package. Zero today.
2. A table of the files that may import `node:fs`, `node:child_process`, `node:os` or `node:vm`. It has 26 engine files today. Every other file imports none of them, so a new file is pure until a commit adds it to the table. I chose this over a list of pure files because a new file then starts on the strict side, and the list to keep is the shorter one.
3. New rows in `NEVER_REACH`, the rule that already exists.
   - The rule modules never reach a file of the table above. They are `resume-matcher.ts`, `resume-pairing.ts`, `resume-report.ts`, `resume-rows.ts`, `run-rows.ts`, `step-ledger.ts`, `failed-attempt.ts`, `checkpoint-call.ts`, `runs/rule.ts`, `runs/cron.ts` and `steps/answer.ts`. All pass today. 33 engine files are pure through everything they import.
   - The core (`workflow.ts`, `workflow-manager.ts`, `orchestrator-globals.ts`, `steps/`) never reaches `runs/`, other than `runs/persistence/` and `runs/cron.ts`. One break today goes in the list. `orchestrator-globals.ts` imports `decisionOf` from `runs/inbox.ts`.
   - `runs/persistence/` never reaches the rest of `runs/`, the core or `workflows/`. No break today.

### Unused exports

knip found no unused file and no unused dependency. It found 25 exported values that nothing imports, 24 more that only tests import, and 99 exported types with no importer in the source.

- Adding knip to `pnpm test` would cost a dev dependency with its own tree, a config per package, and 20 seconds a run.
- A rule of our own is cheaper. The architecture test already reads each import with its names. The rule says that every exported value of a file that is not a package entry has an importer in the source of its package. The breaks start as two lists that can only shrink. The first holds the 25 that nothing imports, and one commit removes their `export` keyword and empties it. The second holds the 24 that only tests import. Each of those is a test that reaches past a module's interface, so the list also measures the test cuts in part 2.
- Types stay out of the rule. An exported type that only a signature uses is often fine, and the 99 need a person's eye. Run knip by hand after each cleanup for those.

### Checks on the tests themselves

These four are mine. They stop the weak kinds of part 1 from coming back.

- Each test file imports at least one run-time value from the code it tests. A file with only `import type` lines cannot run source code. This rule would have refused three of the four contract files that part 2 deletes. 15 lines.
- A table of pinned tests. `docs/proof/improve.md` lists 36 behavior changes and says each has a test, but names none. The table gives, for each change, the file and title of its test, and the rule fails when a title is no longer in its file. A later cut then cannot drop one by accident, and a rename has to move the pin. `review/pins.tsv` is the first version, with 32 changes pinned and 4 waiting for their test. 36 rows and 15 lines. I ask for this before any cut.
- The number of test files that build a `WorkflowManager` themselves is 32 and only goes down. The source builds it in one place. The proof says a one-run object "would change 32 test files", and this count is that cost. New tests go through `runs/run.ts` or the test kit. 10 lines.
- Each package's test script sets `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` to a temporary folder and clears `CLAUDE_CODE_OAUTH_TOKEN`. Today the scripts set `HOME` only. My shell had the other two pointing at the real folders during the first run. Nothing was written there, but a test that reads them would give a different result on each machine. 10 lines and three script edits.

I reject a cap on the ratio of test lines to source lines. It is easy to meet by writing denser tests, and it punishes a good table of cases. I also reject a coverage floor. Coverage is 96% today and says nothing about what a test asserts, as the mutation sample shows.

### Where the checks run

The last 220 commits, 30 days of work, all went straight to `main`. CI runs on pull requests only, so it ran on none of them. The only gate was the line in `AGENTS.md` that asks for `pnpm build`, `pnpm typecheck` and `pnpm test` before a push. `pnpm test` does not run the type check, and one test starts `tsc` itself to make up for that.

| Option | Catches | Cost |
| --- | --- | --- |
| Leave it to the person or agent who pushes | Nothing, when they forget | None |
| CI on every push to `main` | Everything, after the push, on Linux | About 4 minutes of Actions a push. At 5 pushes a day that is 600 of the 2,000 free minutes a month. |
| A pre-push hook that runs `pnpm typecheck` and `pnpm test` | Everything, before the push, on the pusher's machine | About 70 seconds a push. `git push --no-verify` skips it. |
| A pre-push hook with the architecture test and the type check only | Structure and types | About 12 seconds a push |

I chose the full pre-push hook. It enforces what `AGENTS.md` already asks, it costs no Actions minutes, and 70 seconds a push is small next to 220 commits a month. The hook is a file in `.githooks/`, and a `prepare` script in the root `package.json` sets `core.hooksPath` on `pnpm install`. Add `pnpm typecheck` to `pnpm test` so one command is the whole gate. Keep CI as it is for pull requests. If the owner wants a second machine's opinion, a CI run on pushes to `main` that cancels the run in progress costs one run per burst of pushes.

## 5. The order of work

I weighed three orders.

- Cut first. The suite shrinks at once, but nothing guards the cuts, and a pinned behavior can go by accident.
- Add the missing tests first. That is the safest order, and the suite grows before it shrinks.
- Guards, then the structure checks, then the cuts, then the new tests, then the owner's decisions.

I chose the third. The guards are small and make every later commit safer. The decisions come last because they remove source code and need the owner.

Each commit passes `pnpm build`, `pnpm typecheck` and `pnpm test`. Line counts are rough.

| # | Commit | Lines out | Lines in |
| --- | --- | --- | --- |
| | Guards | | |
| 1 | `pnpm test` runs the type check. The test scripts set `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` and clear the token. `contract.test.ts` makes its `HOME`. | 5 | 15 |
| 2 | The pinned-tests table, from `review/pins.tsv`, with 4 changes marked as waiting | 0 | 55 |
| 3 | Each test file imports a run-time value, with a list of the 3 files that break it | 0 | 20 |
| | Structure checks, one table per commit | | |
| 4 | File caps and function caps | 0 | 55 |
| 5 | Caps on the manager's methods and on the two option types | 0 | 35 |
| 6 | Four rows in the "one home per idea" table | 0 | 15 |
| 7 | No import cycle, the table of files that touch the machine, and the reach rules | 0 | 70 |
| 8 | The unused export rule with its two lists. A second commit removes 25 `export` keywords and empties the first list. | 25 | 120 |
| 9 | The README "Inside" check with 21 listed breaks. A docs commit adds the 21 rows and empties the list. | 0 | 70 |
| 10 | The count of test files that build a manager | 0 | 10 |
| | Cuts that need no decision | | |
| 11 | Type-only contract tests and their fixture. Empties the list of commit 3. | 850 | 10 |
| 12 | Tests that always pass or restate a constant, with two real asserts in their place | 127 | 15 |
| 13 | Repeats of another engine test | 874 | 0 |
| 14 | Repeats of an orc test, and the 3 cuts in orc and the harnesses | 314 | 0 |
| 15 | Merges into tables, one commit per test file | 732 | 0 |
| 16 | Fixtures and helpers left unused | 340 | 0 |
| 17 | Shared test helpers in `test/helpers/` | 420 | 80 |
| 18 | Slow tests. The fake `claude` exits when stdin ends, 3 worktrees in place of 40, replies in memory, awaits in place of sleeps. | 60 | 60 |
| | New behavior tests | | |
| 19 | Script functions: a table of the 12 failure messages, `retry()`, `choose` with `none`, a real `pipeline` assert, the `ReferenceError` for the four removed functions | 0 | 130 |
| 20 | Resume: an edit of only the model, an option or the label, a crashed run resumed through the worker, a time limit with no agent step running, the strategy in `orc show --json` | 0 | 110 |
| 21 | The store: event validator rows, the record byte limit, `list()` on an unreadable folder, a read over the limit, the step stop file's lines | 0 | 70 |
| 22 | The service: `orc prune --days`, `keepDays`, the 15 minute retry, the hourly worktree removal | 0 | 90 |
| 23 | Orc commands: `check --answers`, `daemon`, a failing `doctor`, `list --all`, the `run` flags, `workflows --json`, `log -f` on a removed run, the `note` log line, an answer file with no value | 0 | 170 |
| 24 | Harnesses: the Claude options through `contract.test.ts`, and the Codex approval requests with a fake that sends them | 0 | 100 |
| 25 | The single-line faults of part 3 that are left | 0 | 60 |
| | The owner's decisions, one commit each, with source, tests and fixtures together | | |
| 26 | Options that nothing reads | 289, plus source | 0 |
| 27 | A new run that reuses a paused run | 323, plus source | 0 |
| 28 | Options only a direct library call reaches | 1,205, plus source | 0 |
| 29 | Readers for runs saved by older code | 4,400, plus source | 20 |
| 30 | The pre-push hook | 0 | 15 |

Commits 1 to 25 remove about 3,700 lines and add about 1,400. Of the added lines, 465 are guards and structure checks and 730 are new behavior tests. Commits 26 to 29 remove about 6,200 lines of tests and fixtures, and the source behind them. The suite also gets about 15 seconds faster, from 55.

After each of commits 11 to 17, rerun the safety check. `scripts/per-test-cov.mjs` and `scripts/aftercut.mjs` say which source lines lost their last test. A lost line is fine only when an orc test covers it.

### Risks

- A reviewer named a cover that does not hold. I checked 8 of 320 rows by hand. The coverage and fault checks back the list as a whole, not each row. The person who makes each cut should open the named test first. `review/cut-list.tsv` has it per row.
- The fault sample is small. 46 compiled faults cannot show that every cut is safe. Before commits 13 and 15, run `scripts/mutate.mjs` on `workflow-manager.ts` and `run-persistence.ts` only, before and after. Those two files take the most cuts. It takes about 20 minutes.
- Three repeats in `workflow-manager-abort.test.ts` (lines 276, 579 and 794) name a cover whose other half hangs on decision 27. Cut those three only after that decision.
- `auth-pause.test.ts` has a test that another row names as its cover. It must keep its title, `persistRun writes pauseReason 'auth_required' and keeps authContext non-secret`.
- A behavior kept only by an orc test fails further from its cause. A regression in the manager then shows as a failed command. I accept this for the 13 tests of commit 14. The orc test names the command that broke, and the manager's own state and event tests stay.
- A table can hide which case failed. Each row should be its own `test()` with the row's name in the title, as `runs/rule.test.ts` does.
- A cap is a number, and a number is easy to raise. The line in `AGENTS.md` about table edits is the only guard. The pre-push hook does not see who edits a table.
- The old-run cut-over cannot be undone for runs paused today. List them with `orc list --all` first.
- Removing library options breaks any caller outside this repository. I found none inside it. The owner knows if one exists.
- Line coverage in this code overstates, as `retry()` shows. Do not use it alone to judge commit 13.

## Decisions for the owner

1. Runs saved by older code. Cut over, so that old runs show and do not resume (my pick), keep every reader, or keep the readers with trimmed fixtures.
2. The engine as a library. Remove the options that only a direct call reaches, about ten of the 38 run options, or keep them and their 52 tests.
3. The manager's path for a new run that reuses a paused run, which the rule refuses. Remove it or keep it.
4. The options that nothing reads (`meta.backends`, `meta` and `promptMeta`, `resume: { filesystem }`). Remove them or keep them.
5. Where the checks run. A full pre-push hook (my pick), CI on pushes to `main`, both, or neither.
6. The numbers of the caps: 850 lines for a file, 250 for a function, and the counts 11, 38 and 21.
7. The four behavior changes with no test. Write the tests (commits 19 and 23), or take the claim out of the proof.
8. The timing assert at `run-event-persistence.test.ts:678`. Keep it with a wider limit, or drop it.
9. The guide says a failed step gives `null` in its `parallel` slot. No test shows it, and a failed step pauses the run. Either the guide or the code is wrong.

# Proof: the cleanup after the refactor

This is the proof that the cleanup on `improve/codebase` kept orc's behavior, apart from the
changes listed under "Behavior that changed". "Before" is main at 1d4ef314, the end of
[the refactor](refactor.md). "After" is the head of `improve/codebase`. The work ran on
2026-11-22 and 2026-11-23. Fresh reviews of the code chose what to change, and each larger change
started from a design that weighed several options. The real runs used Claude Code 2.1.330 and
Codex 0.169.0, with Claude Code steps on haiku and Codex steps on `gpt-6.1-sol` at low effort. At
most two real runs went at once.

## Numbers

| | Before | After |
| --- | --- | --- |
| Engine source lines | 21,395 | 17,289 |
| orc source lines | 1,197 | 1,021 |
| Harnesses source lines | 4,128 | 4,134 |
| Engine test lines | 23,217 | 23,486 |
| orc test lines | 1,387 | 2,964 |
| Engine exports | 93 | 72 |
| Public methods of the run manager | 29 | 10 |
| `workflow-manager.ts` lines | 4,076 | 2,813 |
| `workflow.ts` lines | 3,618 | 2,751 |
| Tests: architecture, harnesses, engine, orc | 5, 59, 729, 44 | 5, 59, 806, 87 |

The harnesses lines count the 2,400 lines of generated Codex types on both sides. The engine's
tests grew while its source shrank. The tests of removed features went. New tests pin today's
behavior before each change, and others cover the resume rule, the store and the test kit. orc's tests
now start real workers through the launcher, so `orc run`, `orc resume` and `orc rerun` run in
the tests.

Before, `pnpm typecheck` checked each package's source only. Now it checks the tests too, in every
package, and passes.

## What changed in the code

- **Dead code.** Two passes removed what orc cannot reach: prepared runs, strict admission, run
  inspection, live agent observability, the model fallback hook, checkpoint replies passed in at
  resume, the engine's own agent file scan, the manager's own call cancel and the four script
  globals `verify`, `judgePanel`, `loopUntilDry` and `completenessCheck`. The `tier` option is
  refused.
- **One run module.** `runs/rule.ts` holds one pure rule that says what a run's state, worker and
  questions mean, and `runs/run.ts` has one function per orc command. orc's reads write nothing.
  Only the worker builds a run manager.
- **The step request.** A step's options are typed. The steps module routes each step, and the
  engine asks it for the route. `agents.ts` holds the agent definition and every split and join of
  a model spec.
- **Resume.** One pure function pairs each call with the call of the same occurrence in the
  source run, and a step ledger serves the result. The old matching rules, the decision gate and
  the stale-run scan went.
- **The engine's operations.** The workflow check moved into the engine. `orc account` finds its
  own runs, and `orc log` and `orc gc` go through the engine.
- **Run files.** Every path of a run's files is in `runs/store.ts` and `runs/persistence/`, and
  the architecture test fails on a run path anywhere else. The engine stopped writing three files
  that nothing read.
- **Harnesses.** One adapter table, behind `createHarness`. What an adapter could not do as asked
  reaches the run's log.
- **The event log.** The read cache and the second validator went, and the log is built into the
  run store. One fold turns step events into the step list, for the manager and the live view.
- **Questions.** `runs/inbox.ts` owns a question from the moment a run asks to orc's answer.
- **Workers.** One `Launcher` type starts every worker, in orc and in the tests. The test kit at
  `@orchestrator/engine/testing` runs workers in the test's own process. The architecture test
  fails when a package's tests reach another package other than through its entries.
- **The run manager.** It runs one way, the way the worker sets it up: it always journals, and a
  failed or stopped step always pauses the run. Its options for other ways and the methods only
  tests called went.
- **A run's rows.** `run-rows.ts` holds a run's journal, its call rows and its resume seed. One
  rule says when a journal row holds a call's result, where three copies said it before.
- **Places.** The workflow core gets a places object and knows nothing of the home or the run
  record. `runs/` makes it with `runPlaces(paths, notes)`.
- **The resume report.** `resume-report.ts` builds the report and the replay eligibility that
  `orc show --json` prints. The manager hands it each decision the engine makes.
- **Smaller fixes.** One reader for the home's JSON files, one interrupted reason, a check that
  each pause reason has a row in the rule, and a run store interface with only what the manager
  calls.
- **One name for the programs.** `HarnessId` from the harnesses package names Claude Code and
  Codex in the engine too, where `Harness` and `Program` named them before. The manager lost a
  field nothing read and the comments that described an old host.
- **One step start.** Agent, code and checkpoint calls start through one function that takes the
  call's index and reports it. The ledger slot interrupts a call when the run halts, and one
  function, `afterFailedAttempt`, decides what a step does after an attempt fails.
- **The engine's run function.** One `resume` field holds what a resumed run starts from, so a
  wrong mix fails the type check, where two checks at run time caught it before. The state a
  nested run shares with its parent left the options. `WorkflowRunOptions` went from 44 fields to
  38.
- **Pauses.** The manager no longer checks a run's login or its open question before a resume. orc
  passed both checks every time. The paused event has one case per pause reason, so a new reason
  fails to compile until it has its own. `RunStatus` is declared once, one constant lists what a
  stop clears, and one builder makes what each execution of a run starts with.
- **The step stop.** `orc stop --step` sends the worker each call that runs under the name, with
  its run or nested run and its call index. The worker matched labels before.

[The engine README](../../packages/engine/README.md) describes the result.

## The baseline

### Help, check and dry runs

`pnpm test` ends with `test/baseline`, which compares 34 outputs of orc on the fake programs with
goldens. No golden changed. Each commit on the branch passed `pnpm build`, `pnpm typecheck` and
`pnpm test` on its own.

### The real proofs

`test/proofs/run.mjs` ran the eight proofs on the real programs, and `test/proofs/compare.mjs`
compared them with `test/proofs/baseline`. All eight completed. The comparison finds 19
differences, all of them in three proofs, and none of them from this branch:

- installed and shared differ as [the refactor's proof](refactor.md#the-real-proofs) explains.
  The baseline dates from before the refactor.
- ticket: the reviewer asked for changes in round 2, so the ticket took 3 rounds instead of 2. The
  workflow, the agents and the prompts are the same files. The number of rounds varies from run to
  run.

The emails proof also ran on its own after the question changes, and matches the baseline.
Neither `~/.claude/settings.json` nor `~/.codex/config.toml` changed during the runs.

## Behavior that changed

Each change below has a test.

### Runs

- A run paused for a lost login resumes once the login is back. It shows as "paused: login", not
  "paused: auth_required".
- A step's time limit counts from when it holds a slot, so a queued step no longer times out
  before it runs.
- `choose()` takes the run's step changes like `agent()`, so `--set` reaches it.
- A step that sets `tier` stops with an error that points to `model` and `agentType`.
- A script that calls `verify`, `judgePanel`, `loopUntilDry` or `completenessCheck` fails with a
  ReferenceError.
- A run whose worker died while another process held its lock reads as interrupted with exit 2,
  like every other dead run. It read with exit 1.
- The state saves when the run paused, once. The service counts a usage limit's wait from then,
  not from the last save.
- `ask("Breakpoint: ...")` is a plain question. Only `breakpoint()` asks a breakpoint.
- `orc stop --step` writes its request to a file of its own, so a request is no longer lost when
  the worker saves the record at the same moment. A stale request no longer stops a step of the
  same name after a resume.
- `orc stop --step build` stops the step that `orc log` names "build". A nested run's step,
  "ticket A: build", goes on. It stopped both. orc prints the same lines as before.
- `orc doctor --live --model haiku` runs haiku. It ran the default model.
- The worker's last log line for a run that paused on a failed step says why the step failed, on
  a start as on a resume. A start's line said only "(step_failed)".
- The run's log gets a `note` line when a program could not do what a step asked, such as skills
  on Codex.
- An MCP server of a type a step cannot start says "which a step cannot start". It named the old
  ACP runner.

### Questions

- `orc answer <q> stop` at a breakpoint stops the run as `orc stop` does. The run ends stopped and
  `orc wait` exits 3. It failed, with exit 1.
- An answer file with no value pauses the run. It crashed the worker.

### Resume

- `--latest` keeps the steps that match after an edit, as the guide says.
- A reuse of a run that was resumed, a nested run and a loop of identical calls replay their
  finished steps.
- A paused reuse run keeps its source's steps when it resumes.
- A stale journal row under a later call no longer replays. Steps in parallel branches could take
  another step's result on a second resume.
- On a resume, an agent step that returned a blank result with no schema runs again.
- `orc show --json` shows the strategy "occurrence-v1" and the match "occurrence" for a reuse or a
  `--latest` run.

### Accounts and clean-up

- A second `orc account use spare`, after a move whose worker did not start, retries the resume.
  `orc account use default` says the run waits at default's limit. An old run with no limit field
  waits under default.
- Forgetting or pruning a run removes its open questions, so `orc inbox` no longer lists a
  question for a run that is gone.
- `orc prune` and the service skip a run while another process holds its lock.
- A forgotten or pruned run leaves no file behind. A new home has no `project.json`.

### Reads

- `orc list`, `show`, `wait`, `inbox`, `log` and `account list` write nothing. They used to save
  each dead run as paused.
- While a run is live, `orc show --json` gives a step the prompt, the model, the usage, the error
  code, the recoverable flag and the provenance a saved step has. Its result preview and its
  session come once the state saves.
- `orc show` lists the steps that finished before a worker was killed as done. It listed the steps
  as the state last saved them, so a finished step could read as running.
- `orc log -f` prints the "no run" error if the run's record is deleted within 400 ms after its
  worker ends.

### The library

These reach a program that calls the engine itself. orc's output does not change.

- A reuse run that ends without an engine result, such as one stopped before its script ran, lists
  its result's root call rows in the order they settled. A save sorted them by index first. This
  one has no test, since orc reads no result's call rows.
- A caller that passes no places object gets no home to make worktrees in. A step with
  `isolation: "worktree"` works in the run's folder, and the log says why. A nested run can ask
  only for place "folder".
- `runSync` on a run that paused or failed returns the result the run saved, so its duration
  matches the saved state's. It built a second result a few milliseconds later.
- A stopped run's result has `abortSignaled`, as its saved state has.
- A resume of a run that paused for a lost login, or on a question with no `confirm` callback,
  starts the run. It sends `resumed`, runs the step again and pauses again as a live run does. It
  paused again before it started. `AgentRunner` has no `auth` field.
- The file of step stop requests holds one JSON object per line, the name and its calls. It held
  the name alone.

## Still open

These are choices for the owner, not bugs the branch left.

- `orc show --json` prints what it printed before. A cleaner shape would break scripts that read it.
- A model spec such as `claude/claude/haiku`, and an agent key that covers only the default block,
  change a call's hash. Fixing either replays nothing for some saved runs.
- `--latest` keeps a step whose inputs match even when it read a file that an edited step wrote.
- A run's files keep today's layout. A folder per run needs a reader for both layouts and changes
  12 to 27 goldens.
- The readers for runs saved by older code sit in about ten modules. A format version with one
  cut-over would let old runs show but not resume, and the readers could go. Whether that is fine
  depends on how many paused runs are worth resuming. The folder per run fits the same cut-over.
- The run manager still holds a map of runs and `startInBackground`, for a host that runs many runs
  in one process. orc runs one per worker. A one-run object would change 32 test files.
- A step that asks for a mode its program lacks gets a note in the log, not a refusal.
- The monitoring app may read the event log or `runDetail`. Both work today.
- `AGENTPRISM_DEFAULT_BACKEND` still sends a bare model such as `haiku` to Codex. No doc names it.
- A resume under the same run ID pairs calls on their kind and call hash, so a settings change
  during a pause does not rerun finished steps. A step's folder and label are outside the call
  hash. Two parallel steps with the same prompt in two folders could take each other's result if
  they start in another order on the resume. Main had the same risk.
- `orc stop --step` stops each running call under the name it gets. Two steps with the same label
  in one run share a name, and so do the steps of two nested runs with the same label. A stop
  reaches all of them. orc could refuse such a name and list the calls instead.
- A worker started by an older orc reads a stop request as a bare name. If its run has nested runs,
  the new request could throw in its signal handler, and the run would read as interrupted. This
  comes from reading the code, not from a run, and matters only for a run that started before an
  upgrade.
- The paused event and the manager's pause rule each have a case per pause reason. A module for
  the pause would hold both. It is worth it when a new pause reason is planned.
- The steps of a run are closures inside `runWorkflow`, and code steps go through the agent path.
  A module per step kind pays once a third kind comes, or once code steps need their own records.
- Agents don't get `secrets.env`. Code steps and MCP servers do.
- In a dry run, `ORC_PROJECT` names the real project folder, so a code step that writes there
  changes the project. The emails example reads its input through it.
- orc accepts `--priority` and never reads it.
- `orc account use` writes the run's record from `accounts.ts`, not through `runs/`.
- With no persistence root, the manager saves its state under `~/.orchestrator/engine`. orc always
  passes one.
- A nested run gets each option of its parent but the root's resume inputs, so a new option
  reaches nested runs unless someone clears it there.
- A stopped run's saved state has no duration and no reason, since `orc stop` saves it before the
  run settles. `orc show` prints no duration for it. Main does the same.
- The run manager reports a pause in two ways. A start's result says paused, and a resume's
  promise rejects. The worker reads the saved state after both.

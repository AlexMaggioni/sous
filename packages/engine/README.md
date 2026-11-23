# @orchestrator/engine

The engine behind `orc`. It runs saved workflows. Each run has a worker process that runs the
workflow script, keeps the run's record and journal under the orc home, asks its questions
through the inbox and pauses when a step fails. Each agent step runs on Claude Code or Codex
through `@orchestrator/harnesses`.

orc is the only caller. The entry, `src/index.ts`, exports only the names orc imports, and the
architecture test fails when it exports one that orc does not. Everything else is internal and
changes freely. [`docs/orchestrator.md`](../../docs/orchestrator.md) is the guide for people who
write and run workflows.

ESM only, Node 22 or later.

## The entry

The names come in three groups, in the same order as `src/index.ts`.

- **Runs.** The home and its config (`homePaths`, `ensureHome`, `loadConfig`), the run requests
  (`startRun`, `resumeRun`, `rerunRun`, `stopRun`, `stopStep`, `pauseRun`, `answerQuestion`), the
  reads (`listRuns`, `readRun`, `runDetail`, `runQuestions`, `readLog`, `waitForRun`), the clean-up
  (`discardRun`, `gcRuns`, `pruneRuns`), the schedules and the service (`daemonMain`), and the
  worker's own entry (`workerMain`).
- **Saved workflows.** `projectWorkflows` and `resolveWorkflow` find them, `checkWorkflow` checks
  one without running it, and `dryRun` runs one with stand-in agents.
- **Accounts, agents and the installed programs.** What `orc account`, `orc doctor` and the agent
  lookup need.

Each operation takes the home's paths first, so a test can point it at a temp folder. A request
that starts a worker also takes a launcher (see below):

```ts
import { homePaths, startRun, waitForRun, workerProcess } from "@orchestrator/engine";

const paths = homePaths(); // ~/.orchestrator, or $ORC_HOME
const launch = workerProcess(() => "/path/to/orc/dist/cli.js");
const record = startRun(paths, launch, { workflow: "ticket", projectDir: process.cwd(), inputs: { ticket: "Add a --json flag" } });
const end = await waitForRun(paths, record.runId, { log: (text) => process.stdout.write(text) });
// end.code is orc wait's exit code: 0 done, 1 failed, 2 paused, 3 stopped, 4 waits for an answer.
```

## The script DSL

A workflow is a script whose first statement is `export const meta = {...}`. The engine runs the
rest in its own `vm` realm, with these globals:

- Agent steps: `agent(prompt, options)`.
- Code steps: `sh`, `js`, `py`, `run` and `waitUntil`. The engine runs them itself, so they get
  the journal, resume, retries and events of any step.
- Flow: `parallel`, `pipeline`, `retry`, `gate`, `phase` and `log`.
- People: `ask`, `breakpoint` and `checkpoint`.
- Other workflows: `workflow(name, args)` runs a saved workflow inside this one, and `choose` lets
  an agent pick the next step or workflow.
- The read-only `args` and `cwd`.

[`docs/orchestrator.md`](../../docs/orchestrator.md#a-workflow) gives each one's options.

`Math.random()`, `Date.now()` and `new Date()` with no argument throw. A resumed run replays its
journal, and a value that changes between runs would send it down another path. Pass a time or a
random value through `args` instead.

## How a run's worker starts

Each orc run has a worker, which runs its workflow. `startRun`, `resumeRun`, `rerunRun`,
`useAccount` and `daemonMain` take a `Launcher`, and call it each time a run needs a worker:

```ts
type Launcher = (paths: HomePaths, runId: string, mode: "start" | "resume") => void;
```

`workerProcess(cliFile)` gives the launcher orc uses. It runs `node <cli file> _worker <run id>
<mode>` as a detached process, sends its output to the run's log, and notes its pid in the run's
record. It calls `cliFile` only when a worker starts. orc's `main(argv, { launch })` passes a
given launcher to `run`, `resume`, `rerun`, `account use` and `daemon run`.

## The test kit

`@orchestrator/engine/testing` is for this repo's tests. The published package leaves it out.

- `testHome(workflows, config)` makes a home and a project folder in the temp folder.
- `plantState(paths, state, events)` writes a run's state, and its event log if given, as the
  engine leaves them.
- `fakeRunner(answer)` stands in for Claude Code and Codex. It notes each step in `calls`.
- `inProcess({ inner })` gives a launcher that runs each worker in the test's own process, with
  `inner` as the runner. The worker writes the run's log, as a worker process does.
  `ended(runId)` gives the result of the run's last worker.

```ts
import { startRun } from "@orchestrator/engine";
import { fakeRunner, inProcess, testHome } from "@orchestrator/engine/testing";

const { paths, projectDir } = testHome({ one: "export const meta = { name: 'one', description: 'one step' }\nreturn await agent('go')" });
const { runner, calls } = fakeRunner(() => "done");
const workers = inProcess({ inner: runner });
const record = startRun(paths, workers.launch, { workflow: "one", projectDir, inputs: {} });
const result = await workers.ended(record.runId); // result.status is "completed"
```

orc's tests pass the same launcher to `main`, so `orc run`, `orc resume` and `orc rerun` run their
workers in the test. The kit also exports the engine parts that orc's tests use and orc's code
does not, such as `createRun` for a run that needs no worker.

## Inside

| Path | What it holds |
| --- | --- |
| `src/runs/` | The orc home, run records, the worker, the inbox, schedules and the service. `run.ts` has one function per orc command. `rule.ts` decides what a run's state means. |
| `src/workflow.ts`, `src/failed-attempt.ts` | Runs one workflow script in its realm: the globals, the journal and the limits. `failed-attempt.ts` says what a step does after an attempt fails: retry, pause the run, return null or throw. |
| `src/workflow-manager.ts` | One run's manager: resume, pause, the run's state and its events. |
| `src/run-rows.ts` | A run's journal, its call rows and its resume seed. The manager hands it each row and saves what it returns. |
| `src/resume-pairing.ts`, `src/resume-rows.ts`, `src/step-ledger.ts`, `src/resume-report.ts` | The resume: which recorded call a resumed call takes, the rows it pairs with, the ledger that serves each call its row and interrupts the calls still open when a run halts, and the report `orc show --json` prints. |
| `src/run-events.ts`, `src/run-observability.ts`, `src/display.ts` | A run's events and what the event log saves of them. `display.ts` has the fold that turns step events into the step list. |
| `src/steps/` | One agent step. `agent-runner.ts` is the seam the engine calls, and `steps.ts` runs the step on a harness. |
| `src/places/` | Where a run works: a worktree, the project folder or a scratch folder. `runPlaces(paths, notes)` gives the workflow core the places of one run tree. |
| `src/workflows/` | Saved workflows: the folders that hold them, the check and the dry run. |
| `src/accounts.ts`, `src/agents.ts`, `src/programs.ts` | Accounts, the agent lookup and the installed programs. |
| `src/json-file.ts` | The reads and writes of the home's JSON files. A write replaces a file whole. |

## License

Apache-2.0

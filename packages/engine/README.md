# @sous/engine

The engine behind `sous`. It runs saved workflows. Each run has a worker process that runs the
workflow script, keeps the run's record and journal under the sous home, asks its questions
through the inbox and pauses when a step fails. Each agent step runs on Claude Code or Codex
through `@sous/harnesses`.

sous is the only caller. The entry, `src/index.ts`, exports only the names sous imports, and the
architecture test fails when it exports one that sous does not. Everything else is internal and
changes freely. [`docs/guide.md`](../../docs/guide.md) is the guide for people who
write and run workflows.

ESM only, Node 22 or later.

## The entry

The names come in four groups, in the same order as `src/index.ts`.

- **Runs.** The home and its config (`homePaths`, `ensureHome`, `loadConfig`), the run requests
  (`startRun`, `resumeRun`, `rerunRun`, `stopRun`, `stopStep`, `pauseRun`, `answerQuestion`), the
  reads (`listRuns`, `readRun`, `runDetail`, `runQuestions`, `readLog`, `waitForRun`), the clean-up
  (`discardRun`, `gcRuns`, `pruneRuns`), the schedules and the service (`daemonMain`), and the
  worker's own entry (`workerMain`).
- **Saved workflows.** `projectWorkflows` and `resolveWorkflow` find them, `checkWorkflow` checks
  one without running it, and `dryRun` runs one with stand-in agents.
- **Accounts, agents and the installed programs.** What `sous account`, `sous doctor` and the agent
  lookup need.
- **The catalog and the removals.** What the page `sous serve` opens reads and does beyond the
  runs: the agents, skills and MCP servers a project sees (`agentPage`, `listSkills`, `skillPage`,
  `listMcpServers`, `mcpPage`), and the removal of one ended run (`removeRun`) or one saved
  workflow (`trashWorkflow`, which moves its file to `<home>/trash/`).

Each operation takes the home's paths first, so a test can point it at a temp folder. A request
that starts a worker also takes a launcher (see below):

```ts
import { homePaths, startRun, waitForRun, workerProcess } from "@sous/engine";

const paths = homePaths(); // ~/.sous, or $SOUS_HOME
const launch = workerProcess(() => "/path/to/sous/dist/cli.js");
const record = startRun(paths, launch, { workflow: "ticket", projectDir: process.cwd(), inputs: { ticket: "Add a --json flag" } });
const end = await waitForRun(paths, record.runId, { log: (text) => process.stdout.write(text) });
// end.code is sous wait's exit code: 0 done, 1 failed, 2 paused, 3 stopped, 4 waits for an answer.
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

[`docs/guide.md`](../../docs/guide.md#a-workflow) gives each one's options.

`Math.random()`, `Date.now()` and `new Date()` with no argument throw. A resumed run replays its
journal, and a value that changes between runs would send it down another path. Pass a time or a
random value through `args` instead.

## How a run's worker starts

Each sous run has a worker, which runs its workflow. `startRun`, `resumeRun`, `rerunRun`,
`useAccount` and `daemonMain` take a `Launcher`, and call it each time a run needs a worker:

```ts
type Launcher = (paths: HomePaths, runId: string, mode: "start" | "resume") => void;
```

`workerProcess(cliFile)` gives the launcher sous uses. It runs `node <cli file> _worker <run id>
<mode>` as a detached process, sends its output to the run's log, and notes its pid in the run's
record. It calls `cliFile` only when a worker starts. sous's `main(argv, { launch })` passes a
given launcher to `run`, `resume`, `rerun`, `account use` and `daemon run`.

## The test kit

`@sous/engine/testing` is for this repo's tests. The published package leaves it out.

- `testHome(workflows, config)` makes a home and a project folder in the temp folder.
- `plantState(paths, state, events)` writes a run's state, and its event log if given, as the
  engine leaves them.
- `fakeRunner(answer)` stands in for Claude Code and Codex. It notes each step in `calls`.
- `inProcess({ inner })` gives a launcher that runs each worker in the test's own process, with
  `inner` as the runner. The worker writes the run's log, as a worker process does.
  `ended(runId)` gives the result of the run's last worker.

```ts
import { startRun } from "@sous/engine";
import { fakeRunner, inProcess, testHome } from "@sous/engine/testing";

const { paths, projectDir } = testHome({ one: "export const meta = { name: 'one', description: 'one step' }\nreturn await agent('go')" });
const { runner, calls } = fakeRunner(() => "done");
const workers = inProcess({ inner: runner });
const record = startRun(paths, workers.launch, { workflow: "one", projectDir, inputs: {} });
const result = await workers.ended(record.runId); // result.status is "completed"
```

sous's tests pass the same launcher to `main`, so `sous run`, `sous resume` and `sous rerun` run their
workers in the test. The kit also exports the engine parts that sous's tests use and sous's code
does not, such as `createRun` for a run that needs no worker.

## Inside

| Path | What it holds |
| --- | --- |
| `src/index.ts`, `src/testing.ts` | The two entries. `index.ts` exports only the names sous imports. `testing.ts` is the test kit above. |
| `src/runs/` | The sous home, run records, the worker, the inbox, schedules and the service. `run.ts` has one function per sous command. `rule.ts` decides what a run's state means. `limits.ts` holds one go's time limit and token budget. `actions.ts` records who did each write, and `consent.ts` says what an agent may start. `remove.ts` removes one ended run, or moves one saved workflow to the home's trash. |
| `src/workflow.ts`, `src/checkpoint-call.ts`, `src/failed-attempt.ts` | Runs one workflow script in its realm: the globals, the journal and the limits. `checkpoint-call.ts` asks one `checkpoint()` question and records its answer. `failed-attempt.ts` says what a step does after an attempt fails: retry, pause the run, return null or throw. |
| `src/sous-globals.ts`, `src/code-steps.ts` | The script functions added on top of `agent()` and `checkpoint()`. `code-steps.ts` runs the code steps, `sh`, `js`, `py`, a script file and `wait`, in a child process in the step's folder. |
| `src/call-path.ts`, `src/strict-json.ts`, `src/rejection-tripwire.ts` | Guards on the script's realm. `call-path.ts` keys an `agent()` or `checkpoint()` call by the script frames on its stack. `strict-json.ts` checks and freezes a step's result or a checkpoint's reply as strict JSON. `rejection-tripwire.ts` turns a script promise that rejects with no handler into a failed run. |
| `src/workflow-result.ts`, `src/errors.ts`, `src/recorded-error.ts` | What a run returns and records. `errors.ts` has `WorkflowError` and its codes. `recorded-error.ts` turns any thrown value into the error a run records. |
| `src/config.ts`, `src/duration.ts`, `src/model-routing.ts` | The run's limits: agents per run, concurrency and retries. `duration.ts` reads a duration such as `90s` or `10m`. `model-routing.ts` picks a step's model from the phases in the workflow's `meta`. |
| `src/workflow-manager.ts`, `src/host-pause.ts` | One run's manager: resume, pause, the run's state and its events. `host-pause.ts` has the pause a run makes at its time limit or its budget, with that limit as the reason. |
| `src/run-rows.ts` | A run's journal, its call rows and its resume seed. The manager hands it each row and saves what it returns. |
| `src/resume-pairing.ts`, `src/resume-rows.ts`, `src/step-ledger.ts`, `src/resume-report.ts` | The resume: which recorded call a resumed call takes, the rows it pairs with, the ledger that serves each call its row and interrupts the calls still open when a run halts, and the report `sous show --json` prints. |
| `src/resume.ts`, `src/resume-matcher.ts`, `src/resume-identity.ts`, `src/checkpoint-provenance.ts`, `src/older-save.ts` | What a resume starts from. `resume-matcher.ts` checks a saved run and turns it into the `PreparedResume` of `resume.ts`, which the manager hands the run. `resume-identity.ts` has the keys of a recorded call and the ids of nested runs. `checkpoint-provenance.ts` refuses a checkpoint answer saved with no explicit decision. `older-save.ts` tells a run saved by older code, which shows and never resumes. |
| `src/run-events.ts`, `src/run-observability.ts`, `src/display.ts` | A run's events and what the event log saves of them. `display.ts` has the fold that turns step events into the step list. |
| `src/run-environment.ts`, `src/redact.ts` | `run-environment.ts` records the git commit of the run's folder and a digest of its uncommitted changes, for diagnosis only. A resume never checks them. `redact.ts` hides credentials in text the engine shows a host, and cuts long text on a code point boundary. |
| `src/steps/` | One agent step. `agent-runner.ts` is the seam the engine calls, and `steps.ts` runs the step on a harness. |
| `src/places/` | Where a run works: a worktree, the project folder or a scratch folder. `runPlaces(paths, notes)` gives the workflow core the places of one run tree. |
| `src/workflows/`, `src/fabricate.ts` | Saved workflows: the folders that hold them, the check and the dry run. `fabricate.ts` makes a value that fits a JSON Schema, for the dry run's stand-in agents. |
| `src/catalog/` | The agents, skills and MCP servers a project sees, one page each, for the page `sous serve` opens. `files.ts` is its only read of the disk. An MCP page masks each env and header value. |
| `src/accounts.ts`, `src/agents.ts`, `src/programs.ts` | Accounts, the agent lookup and the installed programs. `programs.ts` also links the sous skill, and reads and writes Claude Code's settings for the session-start hook. |
| `src/hook-settings.ts` | The pure edit behind `sous hook install` and `remove`: Claude Code's settings with sous's SessionStart hook added or taken out. |
| `src/json-file.ts`, `src/workflow-paths.ts` | The reads and writes of the home's JSON files. A write replaces a file whole. `workflow-paths.ts` names the engine's home, `~/.sous/engine`. |

## License

Apache-2.0

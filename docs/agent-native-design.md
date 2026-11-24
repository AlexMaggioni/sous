# Agent-native sous design

This is the build plan for `docs/agent-native.md`. It places each new idea in a module, names the main types and functions, records the decisions the proposal left open, and splits the work into pieces. One implementer session can finish each piece with `pnpm test` green.

These points are settled and hold throughout:

- An agent may write a workflow with the person's consent. `sous run` refuses a new or changed workflow until a yes is recorded for its exact text, by hash, through `sous workflows approve <name> --by person`.
- The budget is an optional token limit per run, with none by default. A run that reaches it pauses as `paused: budget`, and its `next` resumes it.
- `sous tell` has one seam per program.
- The proof uses a reduced set of sessions, and each scenario is checked from records.
- A tool refuses only a real cheat or a broken record. Anything else is a note.

The live spike of 2026-11-24 answered the steering and marker questions. This doc uses the coordinator's summary of it. The findings file and its scripts sit under `~/.claude`, which this work does not read. Piece 11 asks for a copy in the worktree.

## What the code allows

These facts come from `test/architecture.test.mjs` and the code. Every piece below fits them.

1. **Line caps.** `workflow-manager.ts` sits exactly at its cap of 2,084 lines. A file fails above its cap, and also when it falls 50 or more lines below it. An edit to the manager keeps its line count, or a commit of its own raises the cap and says why. `workflow.ts` (cap 2,312) gets one net-zero edit. The function caps on `runLevel`, `agentImplementation` and `runLive` work the same way.
2. **Member caps are exact.** `WorkflowManager` keeps 11 methods, `WorkflowRunOptions` 36 fields and `AgentOptions` 18 fields. No piece adds to them. New run settings travel on the run record and through `StepsOptions`, which has no cap. The script's `agent()` options are a plain record that `sous-globals.ts` strips before they reach `AgentOptions`, so `answeredBy` costs no field.
3. **Machine access.** A file that imports `fs`, `child_process`, `os` or the like must be listed in `TOUCHES_MACHINE`, and a listed file that stops importing them fails too. Every new file in this plan stays pure. It reaches the disk through files already listed: `json-file.ts`, `runs/records.ts`, `runs/store.ts` and `programs.ts` in the engine, and `cli.ts` in the cli. So no piece changes that table.
4. **Run files.** Paths in the run folders (records, inbox, logs, slots, queue) are built only in `runs/store.ts` or `runs/persistence/`. The new per-run files (activity, tell, note) get their paths in `store.ts`.
5. **Environment.** In the engine, only a few files read `process.env`, among them `runs/home.ts`, `launch.ts`, `worker.ts` and `notify.ts`. The whole cli `src` folder may. So the cli works out who is calling and passes it to the engine. `homedir()` is allowed only in a few files, `programs.ts` among them, and `CLAUDE_CONFIG_DIR` and `CODEX_HOME` may be named only in the adapters. Skill and hook places therefore come from the adapters.
6. **Callers.** The engine exports only what the cli calls. A piece exports a new engine function in the same commit as its cli caller.
7. **Pins.** The pin table holds 36 test titles. No piece renames a pinned test.
8. **The engine README** names each top-level file of `engine/src`. New engine files go under `runs/`, `steps/` or `workflows/`, so the table needs no new row.
9. **Test homes.** `test/with-temp-home.mjs` clears only `CLAUDE_CODE_OAUTH_TOKEN` and `SOUS_HOME`. A test run from inside Claude Code or Codex inherits `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`. Once sous reads those, every cli test would run as an agent. Piece 1 clears them.
10. **Installs.** The root `prepare` script sets `core.hooksPath`. Implementers run `pnpm install --ignore-scripts`.

# Part 1. Module design

## Layout

| File | Status | Holds |
| --- | --- | --- |
| `cli/src/cli.ts` | changed | `main`, dispatch, help, and the `Machine`, the only machine access in the cli |
| `cli/src/args.ts` | new, pure | `parseArgs` and the reserved flag names |
| `cli/src/reply.ts` | new, pure | `Reply`, `reply`, `print`, `printError`, `cut` |
| `cli/src/through.ts` | new, pure | `whoIsCalling` and the marker table |
| `cli/src/commands/index.ts` | new, pure | `Ctx`, `Command`, and the `COMMANDS` table with each command's flags |
| `cli/src/commands/runs.ts` | new | run, rerun, resume |
| `cli/src/commands/reads.ts` | new | list, show, status, step, log, wait |
| `cli/src/commands/questions.ts` | new | inbox, answer, approve, send-back |
| `cli/src/commands/control.ts` | new | stop, pause, tell, discard, prune, gc |
| `cli/src/commands/workflows.ts` | new | workflows, workflows show, workflows approve, agents, check |
| `cli/src/commands/setup.ts` | new | guide, skill, hook, doctor |
| `cli/src/commands/service.ts` | new | daemon, schedule |
| `cli/src/doctor.ts` | changed | the skill and home checks |
| `cli/guide/<topic>.md` | new | the `sous guide` topics |
| `cli/skill/sous/SKILL.md` | new | the skill |
| `engine/src/runs/refusal.ts` | new, pure | `Refusal` and its codes |
| `engine/src/runs/actions.ts` | new, pure | `Who`, `Through`, `Action`, `recordAction`, `readActions`, `noticeOf`, `traceCall` |
| `engine/src/runs/consent.ts` | new, pure | `mayAnswer`, `mayStart` |
| `engine/src/runs/approvals.ts` | new, pure | `workflowHash`, `isApproved`, `approveWorkflow`, `needApproval`, `seedApprovals` |
| `engine/src/runs/status.ts` | new, pure | `homeStatus`, `statusLine` |
| `engine/src/runs/step-view.ts` | new, pure | `stepView`, `logAfter` |
| `engine/src/steps/steering.ts` | new, pure | `SteeringBoard` |
| `engine/src/workflows/outline.ts` | new, pure | `workflowOutline` |
| `engine/src/workflows/diff.ts` | new, pure | `lineDiff` |
| `engine/src/json-file.ts` | changed | `appendJsonLine`, `readJsonLines` |
| `engine/src/runs/home.ts` | changed | `paths.actions`, `paths.calls`, `paths.approvals`, `paths.approved`, `OrcConfig.budgetTokens` |
| `engine/src/runs/store.ts` | changed | the activity, tell and note file paths |
| `engine/src/runs/records.ts` | changed | new record fields, activity append and read, tell and note files |
| `engine/src/runs/launch.ts` | changed | `who` on the request, the startedBy and approval checks |
| `engine/src/runs/run.ts` | changed | `who` on every write, `tellStep`, the resume note |
| `engine/src/runs/worker.ts` | changed | activity, tells, the resume note, the budget, question fields, the hash check |
| `engine/src/runs/inbox.ts` | changed | `answeredBy`, `step`, and `by` and `through` on answers |
| `engine/src/checkpoint-call.ts`, `workflow.ts`, `sous-globals.ts` | changed | the question purpose |
| `engine/src/steps/steps.ts` | changed | `onActivity`, `onUsage`, steering, the note, the gate before a step |
| `engine/src/workflows/script.ts` | changed | the step calls the parse can read |
| `engine/src/runs/rule.ts`, `run-events.ts`, `run-observability.ts`, `workflow-manager.ts` | changed | the `budget` pause reason |
| `engine/src/programs.ts` | changed | skill links and the hook file |
| `harnesses/src/types.ts` | changed | `StepEvents.steer`, `Harness.places` |
| `harnesses/src/claude/run.ts` | changed | a message queue in the prompt stream |
| `harnesses/src/codex/rpc.ts`, `codex/run.ts`, generated types | changed | `turn/steer` |
| `test/fakes/` | changed | steering in both fakes |
| `test/with-temp-home.mjs` | changed | clears the session markers |

The cli, engine and harnesses keep their import rule. The cli imports the engine, and the engine imports the harnesses.

## The cli split

`cli.ts` is 797 lines against a cap of 850, so twenty new commands can't go in it. Piece 1 moves the commands into `commands/` and changes no output. The goldens in `test/baseline/golden` stay byte for byte.

```ts
// cli.ts
export interface MainOptions {
  // today's fields stay
  env?: NodeJS.ProcessEnv;      // defaults to process.env
  now?: () => Date;
}
export function main(argv: string[], options?: MainOptions): Promise<number>;

export interface Machine {
  readText(file: string): string;     // input files, guide topics
  exists(file: string): boolean;
  guideDir: string;                   // ../guide next to dist/cli.js
  skillDir: string;                   // ../skill/sous
  spawnDaemon(paths: HomePaths): void;
  sleep(ms: number): Promise<void>;
  isTerminal: boolean;                // stdin and stdout are both a TTY
  out(line: string): void;
  err(line: string): void;
}

// commands/index.ts
export interface Ctx {
  paths: HomePaths;
  env: NodeJS.ProcessEnv;
  who: Who;
  json: boolean;
  launch: Launcher;
  machine: Machine;
  now: () => Date;
}
export type Command = (args: Parsed, ctx: Ctx) => Reply | Promise<Reply>;
export const COMMANDS: Record<string, { run: Command; flags: FlagSpec[]; inputs?: true; usage: string }>;

// args.ts
export interface FlagSpec { name: string; takes: "none" | "one" | "many" }
export interface Parsed { positional: string[]; flags: Record<string, string | string[] | true>; inputs: Record<string, string> }
export function parseArgs(argv: string[], flags: FlagSpec[], takesInputs: boolean): Parsed;
export const RESERVED: readonly string[];
```

- A command that takes workflow inputs (run, rerun, check) puts an unknown `--name value` into `inputs`. Its own flags never become inputs. `RESERVED` lists every flag those commands own, today's and the new `--by`, `--budget`, `--timeout`, `--note` and `--let-agent-answer`.
- `sous check` adds a note when a workflow declares an input with a reserved name, since the command line can't give it.
- A command never prompts when `machine.isTerminal` is false. That replaces the check at `cli.ts:201`.
- `cli.ts` keeps `spawn`, the `fs` calls, `cliFile` and the daemon start, behind `Machine`. The command files import no machine module.
- `account-cli.ts` stays as it is.

## Replies

Every command returns a `Reply`. `print` renders it once, in JSON or text.

```ts
// reply.ts
export interface Next { call: string; does: string }
export interface Reply<T = unknown> {
  data: T;          // the command's own fields
  next: Next[];
  notes: string[];
  exit: number;     // 0, or the state's code (2, 4, 5)
  text: string[];   // the text form, line by line
}
export function reply<T>(data: T, parts?: Partial<Omit<Reply<T>, "data">>): Reply<T>;
export function print(r: Reply, json: boolean, out: (line: string) => void): number;
export function printError(error: unknown, json: boolean, err: (line: string) => void): number;
export function cut<T>(items: T[], max: number, flag: string, what: string): { items: T[]; note?: string };
```

- The JSON form is `{ ...data, notes, next }`. Both lists are always there, even when empty. `reply` throws when `data` has a key named `notes`, `next` or `error`.
- The text form prints `text`, then `note: <note>` for each note, then `next: <call>  (<does>)` for each next.
- A JSON reply stays under 8,000 characters, about 2,000 tokens. `cut` shortens a long list and returns a note that names the flag that shows more, such as `--all`, `--since 3d` or `--tail 200`. A test runs each read command on a large home and checks the size.
- The inbox's typed answer type is also called `Reply`. `questions.ts` imports it as `Typed`.

## Errors and exit codes

```ts
// engine runs/refusal.ts
export type RefusalCode =
  | "no_such_run" | "no_such_workflow" | "no_such_question" | "no_such_step" | "no_such_topic" | "step_not_running"
  | "started_by_people" | "not_approved" | "question_for_people" | "needs_person" | "no_person_here"
  | "step_takes_no_message" | "turn_not_steerable" | "run_is_running" | "cannot_resume" | "not_ours" | "workflow_invalid";
export class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    readonly change: string,
    readonly call: string | null,
    readonly forPerson?: string,
  );
  get missing(): boolean; // true for the no_such_* codes and step_not_running
}
```

`printError` writes this in JSON:

```json
{ "error": { "code": "question_for_people", "message": "...", "change": "...", "call": "sous answer mwu68y8s-kaox8f--0 <red|blue> --by person" } }
```

`forPerson` appears only on `started_by_people`. An error that offers more than one call adds `next`, a list of `{call, does}` in the order to try them, and `call` is its first. In text, stderr gets the message, then `  change: ...`, then `  try: <call>` when there is a call, or a `  try: <call>  (<does>)` line for each call of `next`.

| Exit | Meaning |
| --- | --- |
| 0 | Done. Also a request that finds nothing to change, such as pausing a paused run, with a note. |
| 1 | The run failed, as today. Or sous itself failed, and the error code is `internal` or `home_not_writable`. |
| 2 | The run paused or was interrupted, as today. |
| 3 | The run was stopped, as today. |
| 4 | The run asks a question, as today. |
| 5 | New: `wait --timeout` ran out. |
| 64 | Usage: `bad_argument`, `not_a_choice`. |
| 65 | Not found: a `Refusal` whose `missing` is true. |
| 66 | Refused: any other `Refusal`. |

| Code | When | `call` |
| --- | --- | --- |
| `no_such_run` | the run id matches nothing | `sous status --json` |
| `no_such_workflow` | no workflow has that name | `sous workflows --json` |
| `no_such_question` | the question is answered or gone | `sous wait <run> --json` |
| `no_such_step` | the run has no step with that label | `sous show <run> --json` |
| `no_such_topic` | `sous guide` has no topic by that name | `sous guide --json` |
| `step_not_running` | the step exists but doesn't run now | `sous resume <run> --note "..." --step <step>` when it can resume, else `sous show` |
| `started_by_people` | an agent or a run starts a people workflow | null, with `forPerson` set to the command |
| `not_approved` | a new or changed workflow has no yes | `sous workflows show <name> --diff --json` |
| `question_for_people` | an agent answers a people question or a breakpoint | `sous answer <id> <choices> --by person` |
| `needs_person` | an agent approves a workflow or hands itself the questions, without `--by person` | the same call with `--by person` |
| `no_person_here` | `--by person` from a step of a run | null |
| `step_takes_no_message` | `tell` to a shell, js or py step | `sous stop <run> --step <step>` |
| `turn_not_steerable` | Codex is in a compact or review turn | the same `tell` |
| `run_is_running` | `discard` of a running run | `sous stop <run> --json` |
| `workflow_invalid` | the workflow file does not parse, or its settings are wrong | `sous check <name> --json` |
| `cannot_resume` | an older sous saved the run | `sous rerun <run> --json` |
| `not_ours` | a skill or hook place holds something sous didn't put there, a broken link or a link to another folder included | the same install, such as `sous skill install --json`, with `change` naming each place to move aside |

Requests in the wrong state change nothing and exit 0 with a note. That covers pause and stop of an ended run, and the `RESUME_REFUSALS` cases `running`, `never-started`, `completed` and `stopped`. Their next is `wait` for a running run and `rerun` for the others. A resume of a run whose workflow changed, with neither `--latest` nor `--same`, fails with `bad_argument`. Its `next` lists `--latest`, then `--same`, and its call is `--latest`. When the caller's `--latest` would be refused, such as an agent's before the person approved the new text, that refusal's call takes `--latest`'s place, `sous workflows show <name> --diff --json` for `not_approved`, and the change names the approve call and `--latest` for after the yes. No call it offers is refused in turn.

Today `answer --json` means the value is JSON. With `--json` on every command, that flag becomes `--value-json`. A value that starts with `{` or `[` given without it gets a note.

## Who did it

```ts
// engine runs/actions.ts
export type Through =
  | { kind: "person" }
  | { kind: "agent"; program: "claude" | "codex"; session?: string }
  | { kind: "run"; runId: string }
  | { kind: "schedule"; schedule: string };
export type By = "person" | "agent" | "sous";
export interface Who { by: By; through: Through }

export type ActionKind =
  | "run" | "rerun" | "resume" | "pause" | "stop" | "stop-step" | "discard" | "prune" | "gc"
  | "answer" | "approve" | "send-back" | "let-agent-answer" | "approve-workflow" | "tell"
  | "schedule-add" | "schedule-remove" | "account-use" | "skill-install" | "hook-install" | "hook-remove";
export interface Action {
  at: string;
  act: ActionKind;
  by: By;
  through: Through;
  runId?: string;
  workflow?: string;
  question?: string;
  step?: string;
  value?: unknown;
  text?: string;
  hash?: string;
}
export function recordAction(paths: HomePaths, action: Omit<Action, "at">, now?: Date): void;
export function readActions(paths: HomePaths, filter?: { runId?: string; act?: ActionKind }): Action[];
export function noticeOf(action: Action): { title: string; message: string } | undefined;
export function traceCall(paths: HomePaths, call: { argv: string[]; exit: number; code?: string; through: Through }): void;
```

```ts
// cli through.ts
const MARKERS: Array<(env: NodeJS.ProcessEnv) => Through | undefined> = [
  (env) => (env.SOUS_RUN_ID ? { kind: "run", runId: env.SOUS_RUN_ID } : undefined),
  (env) => (env.CODEX_THREAD_ID ? { kind: "agent", program: "codex", session: env.CODEX_THREAD_ID } : undefined),
  (env) => (env.CLAUDECODE === "1" ? { kind: "agent", program: "claude", session: env.CLAUDE_CODE_SESSION_ID } : undefined),
];
export function whoIsCalling(env: NodeJS.ProcessEnv, by?: string): Who;
```

- The order matters, because children inherit markers. A step of a run is a Claude or Codex process with the caller's markers, so `SOUS_RUN_ID` comes first. A Codex session started from a Claude Code shell has both, so `CODEX_THREAD_ID` comes before `CLAUDECODE`. No marker means the person.
- `by` follows `through`. A person is `person`, an agent or a run is `agent`. `--by person` is the only value the flag takes. From an agent it sets `by: person` and keeps `through`. From a run it fails with `no_person_here`.
- The daemon passes `{ by: "sous", through: { kind: "schedule", schedule } }` itself and never reads markers.
- `paths.actions` is `<home>/events.jsonl`. `recordAction` writes one line with one `appendJsonLine` call, so lines from two processes never mix. Free text in a line is cut at 1,000 characters.
- The engine's write functions take `who` as a required argument and record their own action. Today's callers in tests pass a person. The worker never writes to `events.jsonl`.
- "Every write" means the actions in `ActionKind`. A test runs each write command once and finds exactly one new line.
- `noticeOf` returns a notice for an `answer`, `approve`, `send-back`, `approve-workflow` or `let-agent-answer` made through an agent or a run. The text differs by `by`. "Claude Code answered blue to Which color? in run mwu6." against "Claude Code passed on your answer blue ...". `notify` sends it and honors `config.notify` and `SOUS_NOTIFY=0`.
- With `SOUS_TRACE_CALLS=1`, `main` adds `{at, argv, exit, code, through}` to `<home>/calls.jsonl` for each call. The proof reads it to count calls and order. It is off by default.

## People workflows

`createRun` already refuses `startedByRun` on a people workflow. Piece 7 replaces that check with `mayStart(resolved, who)` in `consent.ts`:

- `through.kind` of `agent` or `run` is refused with `started_by_people`, `call: null` and `forPerson` set to the command the person types. `--by person` doesn't change this.
- A schedule may start it, because the person typed `sous schedule add`. `schedule add` from an agent refuses a people workflow the same way.
- A person typing `!sous run deploy` inside Claude Code may carry `CLAUDECODE=1`. If so, the refusal's `change` tells them to use a plain terminal. This is a live check.

`worker.ts:71` already drops people workflows from what `choose()` can pick.

## Questions

The question's purpose grows from a breakpoint flag into an object. It still travels outside the call hash.

```ts
// checkpoint-call.ts
export interface CheckpointPurpose { breakpoint?: true; answeredBy?: "anyone"; step?: string }
export interface CheckpointCallContext { callIndex: number; hash: string; scope: string; path?: string; purpose?: CheckpointPurpose }
```

- In `workflow.ts`, `breakpointCheckpoint` becomes `markedCheckpoint(promptText, options, purpose: CheckpointPurpose)`. The script's own `checkpoint` stays at two arguments, so a script can't mark a question by hand. The edit is net zero lines.
- In `sous-globals.ts`:
  - `ask(question, { choices, answeredBy })` accepts `"people"` or `"anyone"` and fails on anything else. It calls `deps.markedCheckpoint` when `answeredBy` is `"anyone"`.
  - `breakpoint` passes `{ breakpoint: true }`. It fails when given `answeredBy`, because breakpoints stay with people.
  - `agent(prompt, { ask: true, answeredBy })` strips `answeredBy` with `ask`, and its questions carry `step: askLabel`.
- The worker's `Question` gains `answeredBy: "people" | "anyone"` and `step?: string`. A breakpoint is always `"people"`. Question files written before the change read as `"people"`.
- `Answer` gains `by` and `through`.

```ts
// consent.ts
export function mayAnswer(question: Question, record: RunRecord, who: Who): void; // throws Refusal
```

It allows, in this order:

1. `who.by === "person"`.
2. Nothing else for a breakpoint. It throws `question_for_people` with the `approve`, `send-back` and `stop` calls in `change`.
3. `answeredBy === "anyone"`.
4. `record.letAgentAnswer` is set.

Otherwise it throws `question_for_people` with `sous answer <id> <choices> --by person`.

`answerQuestion(paths, question, typed, who)` calls it, writes the answer with `by` and `through`, records the action and sends the notice.

`sous run --let-agent-answer` (also on rerun and resume) stores `letAgentAnswer: { by, through, at }` on the record. It needs `by: person`, from a terminal or from an agent with `--by person`. Otherwise it fails with `needs_person`. It covers the run's nested runs, since `mayAnswer` reads the root record. It never covers breakpoints.

`inbox` and `wait` list each question as `{id, step, prompt, kind, choices, breakpoint, answeredBy, askedAt}`, with the answer call in `next`.

## Workflow approval

```ts
// approvals.ts
export interface Approval { hash: string; by: By; through?: Through; at: string; seeded?: true }
export function workflowHash(text: string): string; // sha256, hex
export function isApproved(paths: HomePaths, file: string, text: string): boolean;
export function approveWorkflow(paths: HomePaths, file: string, text: string, who: Who): Approval;
export function needApproval(paths: HomePaths, projectDir: string, resolved: ResolvedWorkflow, who: Who): void; // throws not_approved
export function seedApprovals(paths: HomePaths): void;
```

- `paths.approvals` is `<home>/approvals.json`, keyed by absolute file, with the last 20 approvals per file. `approveWorkflow` also saves the text as `<home>/approved/<hash>.json` with `writeJsonFile`, so `--diff` has the approved text to compare.
- `createRun` calls `needApproval` for any `through` other than a person. That covers agents, steps of a run and schedules. It checks the root file and each workflow the script names with `workflow("name")`. The same rule applies to project workflows, home workflows in `~/.sous/workflows` and `sous run ./path.js`. A scheduled run that fails the check is logged by the daemon, and the person gets a notice.
- A person's own `sous run` approves the texts it runs, because they chose to run them.
- The record stores `workflowHash`. At start the worker hashes the file it is about to run. If the hash differs, the run fails with a clear error, which closes the gap between the check and the start.
- `resume --latest` and `rerun` go through the same check for the current text.
- When the run was not started by a person, the worker also checks at load time. `loadSavedWorkflow` in `worker.ts` refuses an unapproved nested workflow, which covers names built at run time, and `listSavedWorkflows` drops unapproved ones from `choose()`, next to the people filter at `worker.ts:71`. The early check in `createRun` stays, so the agent hears about a static name before the run starts.
- `sous check --dry-run` needs no approval. It runs code steps the agent could run itself.
- `sous workflows approve <name|path> [--all] --by person` records the yes and the action. From an agent without `--by person` it fails with `needs_person`. `--all` approves every changed workflow of the project and the home.
- At first use, when `approvals.json` is absent, `seedApprovals` approves every workflow of every known project and of the home with `by: "sous"` and `seeded: true`. Without that, each existing workflow would refuse an agent once.

The check reads workflow text only. Script files that steps run and agent definitions stay outside it.

## Workflows show, diff and agents

```ts
// outline.ts
export interface WorkflowOutline {
  name: string; file: string; from: "project" | "home" | "path";
  description?: string; inputs: Record<string, unknown>; place?: string; startedBy: "anyone" | "people";
  steps: Array<{ step?: string; kind: "agent" | "sh" | "js" | "py" | "ask" | "breakpoint" | "workflow"; agent?: string; model?: string; keepsSession?: boolean }>;
  asks: number;
  workflows: string[];
  check: { problems: string[]; notes: string[] };
  approved: { by: By; at: string; changedSince: boolean } | null;
  lastRuns: Array<{ runId: string; status: string; seconds: number; tokens: number }>;
}
export function workflowOutline(paths: HomePaths, projectDir: string, nameOrPath: string): WorkflowOutline;

// diff.ts
export function lineDiff(before: string, after: string): string[]; // "+ line", "- line", "  line"
```

- The proposal says the outline comes from the parse `sous check` already does. That parse (`ScriptRefs`) reads agent names, models, workflows and script files, but no labels and no shell steps. Piece 10 extends `readWorkflowScript` with `calls`, each `agent`, `sh`, `js`, `py`, `ask`, `breakpoint` and `workflow` call in the order written, with its literal label. A note says the order is the order written, and that loops and branches show once.
- `check` comes from `checkWorkflow`. `lastRuns` lists the last three runs of that workflow.
- `--diff` compares the last approved text with the file. A new file shows in full. The diff is cut at 200 lines with a note. The reply's next is the `approve` call.
- `sous agents --json` lists `lookupAgents` as `{name, description, harness, model, file}`.

## Step activity, step and log

```ts
// StepsOptions gains
onActivity?: (step: { scope: string; callIndex: number; label?: string }, entry: ActivityEntry) => void;
// ActivityEntry
{ kind: "prompt" | "text" | "tool" | "tool-result" | "command" | "output" | "tell" | "note" | "error"; tool?: string; text: string }
```

- `steps.ts` calls `onActivity` with the prompt first, then for each history entry the harness reports. A code step adds its command at start and the last 2,000 characters of its output at the end.
- Only the worker writes per-run files. It appends each entry to `records/<run>.activity.jsonl` as `{seq, at, scope, callIndex, label, kind, tool, text}`, with text cut at 2,000 characters. On resume it reads the last `seq` and goes on from there. `store.ts` owns the path, and `records.ts` has `appendActivity` and `readActivity`. `removeRunFiles` deletes the file.

```ts
// step-view.ts
export interface StepView {
  runId: string; step: string; call: number; calls: number;
  status: string; kind: "agent" | "exec"; model?: string;
  startedAt?: string; seconds?: number; tokens?: number;
  prompt?: string; result?: unknown; error?: string;
  command?: string; output?: string;
  activity: ActivityLine[];
}
export function stepView(paths: HomePaths, runId: string, label: string, options?: { call?: number; tail?: number; full?: boolean }): StepView;
export function logAfter(paths: HomePaths, runId: string, after: number, max?: number): { events: LogEvent[]; after: number; more: boolean };
```

- `sous step <run> <step> [--call n] [--tail n] [--full] --json`. A label that ran several times shows the last call, and `calls` says how many there were. The tail defaults to 20 entries.
- `sous log <run> --json --after <seq>` returns one object, `{runId, events, after, more}`, over the engine events from `readEventsAfter`. Each event uses a small vocabulary: `step-start`, `step-end`, `asks`, `answered`, `paused`, `resumed`, `ended`, `tell`, `note`. The next call passes the returned `after`.
- The next of `step` depends on the state. A failed step offers resume, a running one offers tell and stop, and every state offers wait.

## Steering

### The seam

```ts
// harnesses types.ts
export type SteerOutcome = "delivered" | "not_steerable" | "ended";
export type Steer = (text: string, id: string) => Promise<SteerOutcome>;
export interface StepEvents {
  // today's fields stay
  steer?(send: Steer | undefined): void; // the adapter opens the seam when the turn starts and closes it at the end
}
```

**Claude** (`claude/run.ts`):

- The prompt generator becomes a queue. It yields the first user message, then waits for either a queued tell or `done`.
- A tell yields a user message with `priority: "next"` and `uuid: id`. Never `"now"`, which aborts the turn with an empty result. Never `"later"`, which starts a second turn.
- The tell resolves `delivered` when a `command_lifecycle` frame for that uuid says `started` or `completed`, or when the result's `user_message_uuids` lists it. A `cancelled` frame resolves it `ended`.
- On the first result the adapter closes the seam. Each tell still waiting resolves `ended`, since `run.ts` closes the query on that result and the message would otherwise be lost.
- The same generator holds the auto-mode dead code. `q` is undefined on the first call, so `offersAuto()` never runs. Piece 11 waits for `q` before the first yield, and a test checks that auto mode is offered.

**Codex** (`codex/rpc.ts`, `codex/run.ts`):

- `Methods` gains `turn/steer`, with params `{threadId, clientUserMessageId, input, expectedTurnId}` and the reply `{turnId}`. The input is one text item.
- `scripts/codex-types.mjs` regenerates the types with `codex app-server generate-ts` from 0.169.0. The spike folder holds a regenerated copy.
- `codex/run.ts` keeps the thread id and the current turn id, and opens the seam when the turn starts.
- A reply means `delivered`. Error -32600, "no active turn to steer", means `ended`. `activeTurnNotSteerable` means `not_steerable`. An older Codex without the method returns a method-not-found error, which also maps to `not_steerable`, with a note to update Codex.

Both fakes learn steering. The Claude fake reads queued `next` messages, adds them to its transcript, sends lifecycle frames and lists their uuids in the result. The Codex fake answers `turn/steer` during a turn and returns -32600 after it. A fake option makes a turn not steerable.

### The engine side

```ts
// steps/steering.ts
export interface LiveCall { scope: string; callIndex: number; label?: string }
export class SteeringBoard {
  open(call: LiveCall, send: Steer): void;
  close(call: LiveCall): void;
  tell(target: { label: string; call?: number }, text: string, id: string): Promise<Array<{ call: LiveCall; outcome: SteerOutcome }>>;
}
// StepsOptions gains
steering?: SteeringBoard;

// run.ts
export function tellStep(paths: HomePaths, runId: string, step: string, text: string, who: Who, options?: { call?: number }): { id: string; calls: LiveCall[] };
```

- `tellStep` checks, in order:
  - The run exists, else `no_such_run`.
  - The worker is alive and a call with that label runs now, from `liveSteps`, else `step_not_running`.
  - The step is not a code step (model `exec`), else `step_takes_no_message`.
- Then it appends `{id, step, call, text, at}` to `records/<run>.tell`, the way `requestStepStop` appends step stops, sends `SIGUSR2` and records the `tell` action.
- `SIGUSR2` now means "take the request files". The worker takes step stops first, then tells. For each tell it calls `board.tell` and appends a `tell` activity line with the outcome. That line is the receipt.
- The cli polls the activity for the receipt for 5 seconds.
  - `delivered` exits 0 with `{told: true, delivery: "delivered", calls}`.
  - `ended` fails with `step_not_running`, and the call is `resume --note`.
  - `not_steerable` fails with `turn_not_steerable`.
  - No receipt yet exits 0 with `delivery: "pending"`. A note says the step reads it after its current tool call, and `sous step` shows when it did.
- A label that matches several running calls, as in a parallel or a pipeline, delivers to all of them with a note. `--call` narrows it.
- A tell is never queued for a step that hasn't started, or that sits between two turns. It fails with `step_not_running`.
- A resumed run doesn't deliver a tell again. A delivered message stays in the session's history.

### Resume with a note

- `resumeRun(paths, launch, runId, options: { choice?, who, note?: { text: string; step?: string } })`.
- The cli writes `records/<run>.note` before it launches the worker. On resume, the worker takes the note and passes it to `createSteps` as `StepsOptions.note`.
- `steps.ts` adds the note to the first agent call that runs in this go, or to the first with that label when `--step` is given. It goes into the fresh prompt, or after the continuation instruction at `steps.ts:320`. It stays outside the call hash, so the resumed call still matches its saved one. An activity line of kind `note` records its use.
- When every call with that label already finished, resume adds a note that the step won't run again, so the note reaches nothing.

## Status, show and wait

```ts
// status.ts
export interface HomeStatus {
  needsYou: Array<{ runId: string; workflow: string; what: string; question?: { id: string; prompt: string; answeredBy: string }; since: string; call: string }>;
  running: Array<{ runId: string; workflow: string; minutes: number; tokens: number; steps: string[] }>;
  waiting: Array<{ runId: string; workflow: string; what: string; resumesAt?: string }>;
  finished: Array<{ runId: string; workflow: string; status: string; at: string; branch?: string }>;
  service: { running: boolean };
}
export function homeStatus(paths: HomePaths, now: Date, options?: { since?: string }): HomeStatus;
export function statusLine(paths: HomePaths, now: Date): string; // "" when nothing needs the person
```

- `needsYou` holds open questions and runs that stopped for a person: failed, stopped, `paused: budget`, and a paused run with no limit to wait for. `waiting` holds runs paused until a usage limit resets, from `waitingRuns`. `finished` covers the last 24 hours, and `--since 3d` shows more. Each list is cut at 20 with a note.
- `sous show <run> --json` gets short. It gives `{runId, workflow, status, word, cwd, branch, worktree, startedAt, seconds, tokens, steps, questions, failure}`, with steps cut at 30. `--full` puts today's full detail under a `state` key.
- `sous wait <run> --timeout <seconds>` exits 5 with `status: "running"` and the same wait in `next`. Without `--timeout` a person waits as long as it takes. When `through` is an agent, wait uses 110 seconds by default, under Claude Code's two-minute tool limit, and says so in a note. The guide shows a longer timeout with the tool's own timeout.
- The wait status and exit come from the rule verdict, so `asks` exits 4. Wait adds `questions` at a question, `review` (branch, worktree, result) at the end and `failure` (step, message) on a failure. The key `error` stays reserved for the error shape, each with its next.
- The `run` reply keeps today's `{runId, workflow, cwd, log}` and adds `status: "starting"`, `branch`, `asks` and `lastRuns: {count, seconds, tokens}`, with `wait` and `show` in next. `asks` counts the `ask` and `breakpoint` calls the parse finds.
- Waiting on several runs stays out. A Claude Code background shell wakes the session on its own, and nested runs already live under one root.

## Guide, skill, hook and doctor

- `sous guide` lists the topics with one line each. `sous guide <topic>` prints one. The topics are files in `packages/cli/guide/`: start, wait, asks, ends, pauses, steer, writing, errors, inside, replies. The cli package has no `files` field and is linked from the checkout, so the folder ships as it is. `sous help` starts with "Agents: run `sous guide`."
- Each later piece updates its topic.
- `packages/cli/skill/sous/SKILL.md` starts from the draft in the proposal, for the owner to rewrite.
- `Harness.places(env)` returns `{ skills: string; settings?: string }` and keeps each program's folders in its adapter. Claude gives `<CLAUDE_CONFIG_DIR or ~/.claude>/skills` and its `settings.json`. Codex gives `~/.agents/skills`.
- `sous skill install` links `<skills>/sous` to the skill folder for each program, through a helper in `programs.ts`. A link that is already ours is fine. A broken link whose target ends in the skill folder's own tail, `cli/skill/sous`, is one sous made from a checkout or worktree that is gone, so install replaces it and a note names the old target. Anything else in that place, a real folder, a live link to another folder or a broken link to anything else, fails with `not_ours`, and sous writes nothing. `sous skill path` prints the folder. `sous skill check` reports `{program, place, installed, ours}` for each program.
- `sous hook install` adds one SessionStart command, `sous status --line 2>/dev/null || true`, to the Claude settings file. It keeps a backup next to it, and finds its own entry again by that exact command. `sous hook remove` deletes only that entry. The Codex hook format is a live check, so until then the reply notes that Codex has no hook.
- `sous status --line` prints `statusLine`, or nothing. A SessionStart hook's output goes into the model's context, so the line speaks to the agent. For example, "sous: 1 run asks a question and 1 failed. Tell the person, and run sous status for details."
- `sous doctor` adds the skill check per program. When `through` is Codex and a probe write to the sous home fails, it adds a note. The note says to add the sous home to `sandbox_workspace_write.writable_roots` in the Codex config, or to start Codex with `--add-dir <home>`. A write error under the home (EACCES, EPERM, EROFS) maps to `home_not_writable` with the same text. The `start` guide topic has the same line.

## Budget

- `OrcConfig.budgetTokens?: number`, none by default. `sous run|rerun|resume --budget <tokens>` sets it for one run, and the record stores `budget`.
- The budget counts per go, like `timeout`. Each start and resume gets all of it, measured from the token total at the start of the go (`tokenUsageBaseline` on resume).
- The worker watches the manager's `tokenUsage` event at step end. It also gets mid-step usage through a new `StepsOptions.onUsage`, fed from `StepEvents.usage`, which the harnesses already send and `steps.ts` doesn't wire yet.
- When the go reaches the budget, the worker calls `cancelAgentSteps({ pauseReason: "budget", message })`.
- `StepsOptions.gate?: () => { pauseReason: "time_limit" | "budget"; message: string } | undefined` runs before each agent step. When it returns a reason, the step throws `AGENT_CANCELLED` with that reason in `details`. This stops a step that starts after the limit. It also fixes the time limit, which today falls back to `manager.pause` with reason `requested` when no agent step runs. A test checks that the throw pauses the run and does not count as a retry.
- The new reason goes in four places:
  - `run-events.ts` adds `"budget"` to `REQUESTED_PAUSE_REASONS`.
  - `rule.ts` adds the row `"paused, budget"` with the word `paused: budget`, exit 2, `pause: "budget"` and resume allowed.
  - `run-observability.ts` adds the case next to `time_limit`.
  - `workflow-manager.ts` widens `"time_limit"` to `"time_limit" | "budget"` at lines 1866 and 1885, and the test at line 2082. The new `case "budget":` at line 408 is one more line. The piece saves a line in the same file, or a commit of its own raises the cap by one and names the budget pause.
- At `paused: budget`, `wait` gives `sous resume <run>` and `sous resume <run> --budget <more>` in next.

# Part 2. Decisions

Each decision lists the options, the pick and why.

1. **Where sous works out who is calling.** In the engine, or in the cli. *Cli.* The engine may not read `process.env` in most files, and a `Who` argument is easy to test. The daemon and the worker pass their own.
2. **Marker order.** *`SOUS_RUN_ID`, then `CODEX_THREAD_ID`, then `CLAUDECODE`.* Markers inherit to children, and the spike found both programs set theirs in the shell.
3. **Who writes `events.jsonl`.** The cli after each command, or the engine write functions. *The engine.* The daemon and run steps call the engine without the cli's command layer, and their acts must land in the file too.
4. **`who` as a required argument.** A default of "person" is easier but records a wrong `by` whenever a caller forgets it. *Required.* Piece 7 updates the existing callers and tests.
5. **Where the consent check sits.** In `run` only, or in `createRun` for every caller who isn't the person. *`createRun`.* That covers agents, run steps, schedules, rerun and `resume --latest` in one place. A person's run approves, since the person chose it.
6. **Home and path workflows.** Exempt, or the same rule. *The same rule.* An agent can write `~/.sous/workflows/x.js` or `/tmp/x.js` as easily as a project file.
7. **Approval key.** By name, or by absolute file and hash. *File and hash.* A project workflow can shadow a home one with the same name.
8. **Existing workflows at upgrade.** Seed them as approved, or make each one ask once. *Seed.* The person wrote and ran them before this existed, and refusing them is not a real cheat. The window is one-time. Anything an agent changed before the upgrade gets through. The owner decides.
9. **Scheduled runs and approval.** Exempt, or checked. *Checked, with a notice.* An unattended start of an edited file is the case consent exists for. A person's hand edit to a scheduled workflow then needs one `approve` or one manual run.
10. **Breakpoints.** The proposal says a breakpoint stays with people "unless the author marks it". The owner said breakpoints stay with people. *No mark.* `breakpoint()` fails on `answeredBy`, and `--let-agent-answer` doesn't cover breakpoints.
11. **Steering delivery.** A socket to the worker, or an appended file and a signal. *File and signal.* Step stops already work this way, and the worker stays the only writer of per-run state.
12. **Several running calls with one label.** Refuse as ambiguous, or deliver to all. *All, with a note, and `--call` to narrow.* A note to "the implementer" usually means each of them.
13. **A tell for a step that doesn't run.** Queue it, or refuse. *Refuse with `step_not_running`.* A queue needs rules for steps between turns and for resumes. `resume --note` covers "do it over with this".
14. **A late Claude tell.** Handle a second result, or report it. *Report `ended`.* Taking a second turn changes how a step ends and how tokens count.
15. **`turn_not_steerable` and `step_takes_no_message` as errors.** Exit 0 with `told: false`, or an error. *Error.* The message reached nobody, and an exit 0 is easy to read as done. These are failures to act, not consent refusals.
16. **`log --json` shape.** JSON lines, as the proposal says, or one object. *One object with `after`.* Every other reply is one object with `notes` and `next`. `--follow` with lines can come later.
17. **The default `show`.** Keep the full detail, or a short reply with `--full`. *Short.* The full detail runs to many thousands of tokens. Scripts that read today's `show --json` need `--full`.
18. **`answer --json`.** Keep its meaning, or rename it to `--value-json`. *Rename.* `--json` means the reply's form everywhere else. Old scripts break, and a note points them to the new flag.
19. **Budget per go, or per run.** Per run means a resumed run pauses again at once. *Per go*, like `timeout`. The owner confirms.
20. **Where the budget stops a step.** Only `cancelAgentSteps`, or also a gate before each step. *Both.* The gate also fixes the time-limit fallback.
21. **The resume note and the call hash.** Inside, or outside. *Outside.* Inside, the resumed step would no longer match its saved call. The record of the note lives in the activity and the action instead.
22. **Wrong-state requests.** An error, or exit 0 with a note. *A note.* Pausing a paused run changes nothing and breaks nothing.
23. **Waiting on several runs.** *Out.* See status, show and wait.

## Where the proposal is wrong or weak against the code

- `workflows show` "comes from the parse that sous check already does". That parse has no labels and no shell steps. Piece 10 extends it.
- "A breakpoint stays people unless the author marks it" contradicts the owner's answer.
- A budget per run total re-pauses at once on resume, because the total carries over.
- The time limit pauses with reason `requested` when no agent step runs. Status would show the wrong reason.
- `log --json` as JSON lines breaks the one-object rule.
- A Claude tell that arrives after the result is lost today, because `run.ts` closes on the first result.
- The Codex marker was unknown. It is `CODEX_THREAD_ID`.
- Codex in `workspace-write` can't write `~/.sous`, so every sous write fails there until the person adds the home to `writable_roots`.
- "Every write" in `events.jsonl` needs a definition. `ActionKind` is that definition.
- `--by person` is the agent's word. sous records `through` beside it, and the notice tells the person.
- Consent covers workflow text only. A script file a step runs, or an agent definition, can change without a yes.
- The resume note sits outside the call hash, so nothing but the activity line shows it was used.
- The session-start hook's line goes to the model, not to the person.
- `answer --json` and the global `--json` clash.
- A test run inside Claude Code or Codex inherits the markers. Without piece 1's fix, every cli test would run as an agent.

# Part 3. Pieces

Each piece is one implementer session: a few hundred lines plus tests, `pnpm test` green at the end. Write the tests first. Each piece after piece 6 updates its guide topic. Run the tests with an isolated home and `SOUS_NOTIFY=0`.

## 1. Cli split

**Outcome.** The commands live in `commands/`, behind `Ctx` and `Machine`. The output doesn't change. The test home clears the session markers.

**Files.** `cli/src/cli.ts`, `cli/src/args.ts`, `cli/src/commands/*.ts`, `test/with-temp-home.mjs`.

**Tests first.**
- `test/baseline.test.mjs` passes with no golden changed.
- `cli/test/units.test.ts`:
  - `parseArgs(["deploy", "--env", "prod", "--json"], RUN_FLAGS, true)` gives `inputs: {env: "prod"}` and `flags.json`.
  - Every name in `RESERVED` stays out of `inputs`.
  - Every command in `COMMANDS` appears in `sous help`.
- `cli/test/units.test.ts`: under the wrapper, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID` and `SOUS_RUN_ID` are unset.
- The architecture test passes with no table change: the command files import no machine module, and `cli.ts` stays under its cap.

**Depends on** nothing. **Parallel** with 11.

## 2. Replies and errors

**Outcome.** `Reply`, `print`, `printError` and `Refusal` exist. The commands that have `--json` today (run, wait, list, show, inbox, workflows, check, schedule list, account, doctor) return `notes` and `next`, with today's fields kept. Errors have the shape and the exit codes 64, 65 and 66. Not-found errors become `Refusal`s.

**Files.** `cli/src/reply.ts`, `cli/src/commands/*.ts`, `engine/src/runs/refusal.ts`, `engine/src/runs/run.ts` (throw `Refusal` for a missing run, question or step), the engine index, the goldens.

**Tests first.** `cli/test/replies.test.ts`:
- `sous show nosuch --json` exits 65 with `error.code` `no_such_run` and `call` `sous status --json`.
- `sous answer <id> green --json` on a red or blue question exits 64 with `not_a_choice` and the call listing `red|blue`.
- `sous list --json` has `notes` and `next` arrays.
- The same error without `--json` prints `change:` and `try:` lines on stderr.
- A reply of 500 runs stays under 8,000 characters and has a note naming `--all`.
- `reply({next: 1})` throws.
- A sous fault, such as an unreadable record folder, exits 1 with `error.code` `internal`.

Goldens are updated with `BASELINE_UPDATE=1`, and the diff is reviewed.

**Depends on** 1. **Parallel** with 11.

## 3. Control and question replies

**Outcome.** stop, pause, resume, rerun, discard, prune, gc, log, answer, approve and send-back return replies and take `--json`. Wrong-state requests exit 0 with a note. `answer --json` becomes `--value-json`.

**Files.** `cli/src/commands/control.ts`, `questions.ts`, `runs.ts` (resume only), `engine/src/runs/run.ts`, `engine/src/runs/inbox.ts` (the `--value-json` flag), the goldens.

**Tests first.** `cli/test/questions.test.ts` and `cli/test/runs.test.ts`:
- Pausing a paused run exits 0 with a note.
- Resuming a completed run exits 0 with `next` holding the `rerun` call.
- `discard` of a running run exits 66 with `run_is_running` and `call` `sous stop <run> --json`.
- `answer <id> '{"a":1}' --value-json` passes an object.
- `answer <id> '{"a":1}'` on an input question passes the text, with a note naming `--value-json`.

**Depends on** 2. **Parallel** with 4 and 5, since they touch other command files. Merge goldens one piece after another.

## 4. Wait, status, show and the run reply

**Outcome.** `sous status`, the short `show`, `show --full`, `wait --timeout` with exit 5, the wait reply with questions, review and failure, and the run reply with `next`. These cover start, wait and report.

**Files.** `engine/src/runs/status.ts`, `engine/src/runs/run.ts` (the short view), `cli/src/commands/reads.ts`, `runs.ts`, the goldens.

**Tests first.**
- `engine/test/runs/status.test.ts`, on a home built from records:
  - One run at a question shows in `needsYou` with the answer call.
  - A run paused for a usage limit shows in `waiting` with `resumesAt`.
  - A run finished 30 hours ago is missing, and `since: "3d"` shows it.
  - `statusLine` is empty for a home with nothing open.
- `cli/test/reads.test.ts`, with the fake programs:
  - The hello fixture with `name=Ada` gives a run reply holding `next[0].call` `sous wait <id> --json`. That wait exits 0 with the result "hello Ada" under `review`.
  - The asks fixture's wait exits 4 with one question whose `answeredBy` is `people`.
  - The fails fixture's wait exits 2 with `failure.step` `boom` and next holding `sous step <id> boom --json` and `sous resume <id> --json`.
  - `wait --timeout 1` on a slow run exits 5 with the same wait in next.
  - `show --json` has no `state` key, and `show --full --json` has one.

**Depends on** 2. **Parallel** with 3.

## 5. Step activity, step and log

**Outcome.** The worker saves each step's activity. `sous step` and `log --json --after` show what happened inside a run.

**Files.** `engine/src/steps/steps.ts` (`onActivity`), `engine/src/runs/worker.ts`, `store.ts`, `records.ts`, `engine/src/runs/step-view.ts`, `json-file.ts` (`appendJsonLine`, `readJsonLines`), `cli/src/commands/reads.ts`.

**Tests first.**
- `engine/test/json-file.test.ts`: two appends read back as two lines in order, and a torn last line is skipped.
- `engine/test/steps.test.ts`: a fake harness step reports the prompt, then one entry per history item, through `onActivity`.
- `engine/test/runs/step-view.test.ts`:
  - A failed shell step shows its command, its output tail and the error.
  - A label run three times shows call 3, and `calls: 3`.
  - `tail: 5` gives 5 entries and a note.
- `cli/test/reads.test.ts`:
  - The fails fixture's `sous step <id> boom --json` holds exit 3 in its `failure` and the resume call in next.
  - `log --json --after 0` returns events with `after`, and a second call with that `after` returns only newer events.
  - `prune` deletes the activity file with the run's other files.

**Depends on** 4, since both edit `reads.ts`. **Parallel** with 3 and 11.

## 6. Guide and skill

**Outcome.** `sous guide`, the skill draft, and `sous skill install|path|check`. `Harness.places` gives the skill folders. `sous help` starts with the line for agents.

**Files.** `cli/guide/*.md`, `cli/skill/sous/SKILL.md`, `cli/src/commands/setup.ts`, `cli/src/cli.ts` (the folders), `harnesses/src/types.ts`, both adapters (`places`), `engine/src/programs.ts` (the link helper).

**Tests first.** `cli/test/guide.test.ts`:
- Each of the ten topic files exists and is under 4,000 characters.
- Every `sous ...` line in the topics' code blocks parses against `COMMANDS`. Calls for commands that don't exist yet stay out of the topics until their piece.
- `sous guide nosuch` exits 65.

`cli/test/skill.test.ts`, in the temp home:
- `skill install` creates both links.
- A second install reports both as already there.
- A plain folder at the Claude place makes install exit 66 with `not_ours`, and the folder is unchanged.
- `skill check --json` lists both programs as installed.

`harnesses/test/contract.test.ts`: `places` honors `CLAUDE_CONFIG_DIR`.

**Depends on** 4 and 5. **Parallel** with 11.

## 7. Who did it

**Outcome.** `whoIsCalling`, `events.jsonl`, `--by person`, the notice, the people workflow refusal and the call trace.

**Files.** `cli/src/through.ts`, `cli/src/cli.ts` (`traceCall`), every command file (pass `ctx.who`), `engine/src/runs/actions.ts`, `consent.ts` (`mayStart`), `home.ts`, `launch.ts`, `run.ts`, `notify.ts` callers, the daemon's start path, existing tests that call engine writes.

**Tests first.**
- `cli/test/who.test.ts` (new):
  - `whoIsCalling({CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1"})` gives an agent through Claude with session `s1`.
  - Both markers give Codex.
  - `SOUS_RUN_ID` wins over both.
  - `--by person` with `SOUS_RUN_ID` fails with `no_person_here`.
  - With env `CLAUDECODE=1`, `sous run deploy` on the deploy fixture exits 66 with `started_by_people`, `call` null, and `forPerson` `sous run deploy`. No run record exists.
  - With no marker the same run starts.
  - `sous stop <run>` with `CODEX_THREAD_ID=t1` adds one `stop` line with `by: agent` and the Codex through.
  - Each write command adds exactly one line.
  - With `SOUS_TRACE_CALLS=1`, two calls add two lines to `calls.jsonl`, and the refused one carries its code.
- `engine/test/runs/actions.test.ts`: `noticeOf` returns a notice for an agent's answer and none for a person's stop.

**Depends on** 3 and 5. **Not parallel** with 8 to 10, which build on it.

## 8. Questions

**Outcome.** `answeredBy`, the question's step, `mayAnswer`, `--let-agent-answer`, and answers that record `by` and `through`.

**Files.** `engine/src/checkpoint-call.ts`, `workflow.ts`, `sous-globals.ts`, `runs/inbox.ts`, `runs/worker.ts` (question fields), `runs/consent.ts`, `runs/records.ts` (`letAgentAnswer`), `runs/run.ts` (`answerQuestion`), `cli/src/commands/questions.ts`, `runs.ts`.

**Tests first.**
- `engine/test/sous-globals.test.ts`:
  - `ask("Which color?", {choices: ["red", "blue"], answeredBy: "anyone"})` calls `markedCheckpoint` with `{answeredBy: "anyone"}`.
  - `answeredBy: "robots"` fails.
  - `breakpoint(..., {answeredBy: "anyone"})` fails.
- `engine/test/checkpoint.test.ts`: the call hash is the same with and without `answeredBy`.
- `engine/test/runs/consent.test.ts`, one case per rule:
  - A person may answer anything.
  - An agent may not answer a breakpoint, even with `letAgentAnswer`.
  - An agent may answer an `anyone` question.
  - An agent may answer a people question when the record has `letAgentAnswer`.
  - Otherwise `question_for_people`.
- `engine/test/runs/inbox.test.ts`: a question file without `answeredBy` reads as `people`.
- `cli/test/questions.test.ts`:
  - The asks fixture: an agent's `answer <id> blue` exits 66 with the `--by person` call. With `--by person` it exits 0, the answer holds `by: person` and the agent through, and `events.jsonl` has one `answer` line.
  - The asks-anyone fixture: an agent's `answer` exits 0 with `by: agent`.
  - The review fixture: an agent's `approve` exits 66.
  - `run asks --let-agent-answer` from an agent without `--by person` exits 66 with `needs_person`.

**Depends on** 7. **Parallel** with 9 if merged one after the other. Both touch `worker.ts`, in different places.

## 9. Workflow approval

**Outcome.** `approvals.json`, `sous workflows approve`, the hash check in `createRun` and the worker, the nested load check, seeding at first use, and the `choose()` filter.

**Files.** `engine/src/runs/approvals.ts`, `home.ts`, `launch.ts`, `records.ts` (`workflowHash`), `worker.ts`, `cli/src/commands/workflows.ts`, `service.ts` (the daemon's refusal and notice).

**Tests first.**
- `engine/test/runs/approvals.test.ts`:
  - An absent file seeds every workflow of a known project as `seeded`.
  - Changing one byte makes `isApproved` false.
  - `approveWorkflow` keeps 20 approvals per file and writes the text copy.
- `cli/test/approval.test.ts`:
  - An agent runs a new `greet.js` and gets 66 `not_approved`, with call `sous workflows show greet --diff --json`. `events.jsonl` has no `run` line.
  - `workflows approve greet` from the agent exits 66 `needs_person`. With `--by person` it exits 0 with an `approve-workflow` line, and the run then starts.
  - The person's own `run` of a changed file starts and approves it.
  - `check greet --dry-run` from the agent runs without approval.
  - A workflow whose static `workflow("other")` is unapproved is refused and names `other`.
  - A record whose file changed after create fails at worker start with a message naming the file.
  - An agent's run of an approved workflow that calls `workflow(name)` with a name built at run time fails at that call when the named workflow is unapproved.

**Depends on** 7. **Parallel** with 8, as above.

## 10. Workflows show, diff and agents

**Outcome.** `sous workflows show <name> [--diff] --json`, `sous agents --json`, and the parse's `calls`.

**Files.** `engine/src/workflows/script.ts`, `outline.ts`, `diff.ts`, `cli/src/commands/workflows.ts`, the `writing` guide topic.

**Tests first.**
- `engine/test/workflows/check.test.ts` (or a new `outline.test.ts`):
  - `readWorkflowScript` of the fails fixture gives `calls` `[sh prepare, sh boom]`.
  - The review fixture gives a breakpoint and a `js` call labeled `draft`.
- `engine/test/workflows/diff.test.ts`: one changed line gives one `-` and one `+`.
- `cli/test/approval.test.ts`:
  - `workflows show greet --json` has `approved: null` for a new file and `changedSince: true` after an edit.
  - `--diff` shows the edited line and holds the approve call in next.
  - `agents --json` lists an agent defined in the project settings.

**Depends on** 9.

## 11. The steer seam in the harnesses

**Outcome.** `StepEvents.steer` on both adapters, the fakes, regenerated Codex types, and the auto-mode fix.

**Before it starts.** The coordinator copies the spike scripts and findings into `test/proofs/agent-native/spike/`, so the implementer can read the frames and errors without touching `~/.claude`.

**Files.** `harnesses/src/types.ts`, `claude/run.ts`, `codex/rpc.ts`, `codex/run.ts`, the generated types, `harnesses/scripts/codex-types.mjs`, `test/fakes/claude`, `test/fakes/codex`, `test/fakes/lib.mjs`.

**Tests first.** `harnesses/test/contract.test.ts`, for each adapter:
- A tell sent while the fake works on a tool call resolves `delivered`, shows in the step's history, and the step ends with one result.
- A tell after the result resolves `ended`.
- On Codex, a not-steerable turn resolves `not_steerable`.
- On Claude, a tell waiting when the result arrives resolves `ended`.
- On Claude, no message is ever sent with priority `now` or `later`. The fake fails on either.
- On Claude, auto mode is offered when the step has no mode.

**Depends on** nothing. **Parallel** with everything up to 12.

## 12. Tell

**Outcome.** `sous tell <run> --step <step> [--call n] "message"`, delivered through the worker, with a receipt.

**Files.** `engine/src/steps/steering.ts`, `steps/steps.ts`, `runs/worker.ts` (`SIGUSR2` takes tells), `runs/store.ts`, `records.ts`, `run.ts` (`tellStep`), `cli/src/commands/control.ts`, the `steer` guide topic.

**Tests first.**
- `engine/test/steering.test.ts`:
  - Two open calls labeled `impl` both get a tell.
  - `call: 2` reaches only the second.
  - A closed call is not told.
- `cli/test/tell.test.ts`, with the fake programs:
  - A tell to a running fake agent step exits 0 with `delivery: "delivered"`. The step's activity has a `tell` line, and `events.jsonl` has one `tell` line.
  - A tell to the `boom` shell step exits 66 with `step_takes_no_message` and the stop call.
  - A tell to a finished step exits 65 with `step_not_running` and a `resume --note` call.
  - A tell while a step stop is pending handles both requests.
  - A fake that never confirms gives `delivery: "pending"` after 5 seconds, set shorter in the test through `MainOptions`.

**Depends on** 5, 7 and 11. **Not parallel** with 13 or 14.

## 13. Resume with a note

**Outcome.** `sous resume <run> --note "..." [--step <step>]` reaches the first agent call that runs.

**Files.** `engine/src/runs/run.ts`, `store.ts`, `records.ts`, `worker.ts`, `steps/steps.ts`, `cli/src/commands/runs.ts`, the `pauses` guide topic.

**Tests first.**
- `engine/test/steps.test.ts`:
  - With `note`, the first agent call's prompt ends with the note, and the second's doesn't.
  - With `step: "b"`, only `b` gets it.
  - In a continued session the note follows the continuation instruction.
  - The call hash is the same with and without the note.
- `cli/test/resume.test.ts`:
  - A failed fake agent step resumed with `--note` shows the note in its activity.
  - `--step nosuch` exits 65.
  - `--step` naming a finished step gives a note.

**Depends on** 5 and 7, and after 12.

## 14. Budget

**Outcome.** The budget setting and flag, the `budget` pause reason, mid-step usage, and the gate before each agent step, which also fixes the time-limit fallback.

**Files.** `engine/src/runs/home.ts`, `records.ts`, `worker.ts`, `steps/steps.ts` (`onUsage`, `gate`), `runs/rule.ts`, `run-events.ts`, `run-observability.ts`, `workflow-manager.ts`, `cli/src/commands/runs.ts`, `reads.ts`, the `pauses` guide topic. Possibly the architecture table, in its own commit.

**Tests first.**
- `engine/test/runs/rule.test.ts`: the `paused, budget` row gives the word `paused: budget` and exit 2.
- `engine/test/steps.test.ts`: a `gate` that returns `budget` makes the next agent step throw `AGENT_CANCELLED` with that reason, and the step is not retried.
- `engine/test/run-observability.test.ts`: a budget pause projects as `paused: budget`.
- `cli/test/budget.test.ts`, with a fake that reports 1,000 tokens per step:
  - `run --budget 1500` on three agent steps pauses after the second. Its wait exits 2 with `paused: budget` and next holding `sous resume`.
  - A resume gets a fresh 1,500 and finishes the third step.
- `cli/test/time-limit.test.ts`: a time limit that hits between steps pauses with reason `time_limit`, not `requested`.

**Depends on** 2, and after 13.

## 15. Hook and doctor

**Outcome.** `sous hook install|remove`, `sous status --line`, the doctor's skill check, and the Codex home note with the `home_not_writable` error.

**Files.** `cli/src/commands/setup.ts`, `cli/src/doctor.ts`, `cli/src/reply.ts` (the error mapping), `engine/src/programs.ts` (the settings edit), the `start` guide topic.

**Tests first.**
- `cli/test/hook.test.ts`, in the temp home:
  - `hook install` adds one SessionStart entry and a backup.
  - A second install adds nothing.
  - Other hooks in the file stay.
  - `hook remove` leaves the file as it was before the install.
- `cli/test/reads.test.ts`: `status --line` prints nothing for an empty home and one line for a home with an open question.
- `cli/test/doctor.test.ts`:
  - With the skill missing, doctor reports it per program.
  - With `CODEX_THREAD_ID` set and the home read-only, doctor gives the `writable_roots` note.
  - A run in that home fails with `home_not_writable`.

**Depends on** 4 and 6.

## Order and parallel work

```
1 ── 2 ─┬─ 3 ─────────┐
        └─ 4 ── 5 ─┬──┴─ 7 ─┬─ 8
                   │        ├─ 9 ── 10
                   └─ 6     └──────────── 12 ── 13 ── 14
11 (from the start) ───────────────────── 12
6, 4 ── 15
```

At most two real sessions run at once, so two implementers at a time fits. A good pairing is 11 beside the cli line from the start, then 8 beside 9.

# Part 4. Risks

## Checked live already

The spike settled these:

- On Claude, a `next` message mid-turn is read after the current tool call, in the same turn.
- `now` aborts the turn and `later` starts a second one.
- On Codex, `turn/steer` works mid-turn and gives -32600 after it.
- The marker names on both programs.
- Codex `workspace-write` blocks writes to `~/.sous`.

## To check live

- Whether a `!` command inside Claude Code carries `CLAUDECODE=1`. If it does, the person's own `!sous run deploy` is refused, and the refusal tells them to use a plain terminal.
- The Claude SDK version pinned in harnesses against the one the spike used. The `command_lifecycle` frames and `user_message_uuids` must be there.
- Codex older than 0.169.0. A method-not-found error must map to `not_steerable`.
- Where Codex reads user skills: `~/.agents/skills`, or a folder under `CODEX_HOME`.
- Codex's hook format, before `hook install` covers it.
- That SessionStart output reaches the model in Claude Code, and whether Codex has the same.
- Claude Code's tool time limit and Codex's command time limit, against the agent default of 110 seconds for `wait`.
- Whether mid-step usage events are running totals or deltas on each program. The budget check depends on it.
- A notice sent from the worker, not the cli, on macOS.
- That a Claude step still starts when the worker inherits `CLAUDECODE` from an agent caller. It does today, and nothing here changes that.

## Risks in the build

- `workflow-manager.ts` sits at its cap. Piece 14 needs one line saved, or a cap commit.
- Piece 7 changes the signature of every engine write. It touches many test files, and its diff is the largest. If it runs long, split the notice and the trace into a piece of their own.
- Pieces 3 and 4 both change goldens. Merge them one after the other and regenerate.
- `events.jsonl` grows without end. `sous prune` could cut lines older than `keepDays`. This plan leaves it out.
- The approval seed approves whatever is there at upgrade.

## Out of scope

- The MCP server.
- Waiting on several runs, and `log --follow`.
- Interrupting a step, queued tells, and delivering a tell again after resume.
- Consent for script files and agent definitions.
- Cost in money. The budget counts tokens.
- Rotating `events.jsonl`.

## Proof from records

The proof runs each scenario with `SOUS_TRACE_CALLS=1` in an isolated home. Each check reads files, not the agent's words, except where the table says so.

| # | Scenario | Records that prove it |
| --- | --- | --- |
| 1 | Run hello for Ada | `calls.jsonl` has one `run`, one `wait`, at most six sous calls. The run's result holds "hello Ada". "No sleep" needs the transcript. |
| 2 | Run asks, people question | First turn: `events.jsonl` has no `answer` line. Second turn: one `answer` line with `by: person` and the agent through. |
| 3 | Run asks-anyone | One `answer` line with `by: agent`. |
| 4 | Run fails | No `rerun` line. `calls.jsonl` has a `step` or `wait` call that returned the `boom` error. The offer to resume needs the transcript. |
| 5 | A refused call | In `calls.jsonl`, the call after a line with a refusal code matches that refusal's `call`. |
| 6 | Write a workflow | `calls.jsonl` has `check --dry-run` before any `run`. `events.jsonl` has no `run` of it before its `approve-workflow` line. "Shows the file and asks" needs the transcript. |
| 7 | What is going on | The first line of `calls.jsonl` is `status`. The answer naming both runs needs the transcript. |
| 8 | Tell a step to stop at five | The step's activity has a `tell` line with `delivered`. The step has one call with no restart. The result stops at five. |
| 9 | Run deploy | `calls.jsonl` has a `run` with `started_by_people`, and `events.jsonl` has no `run` line. |

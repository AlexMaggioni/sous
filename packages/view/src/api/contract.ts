// What `sous serve` sends the page, and what the page sends back. The server in packages/cli
// imports these types from "@sous-run/view", so a change here fails the server's typecheck until the
// server follows. Types only: this file has no imports and no values.
//
// Every read is a GET under /api that answers JSON. Every write is a POST, except the removal of a
// run, which is a DELETE. A route that takes a project reads it from ?project=<dir>, and uses the
// project `sous serve` started in without one.

// ── Shared ──

/** The status every page shows, each with one icon (DESIGN.md, "Status icons"). "needs" is a
 *  run or step that waits on the person: a question, an approval or a breakpoint. */
export type Status = "queued" | "running" | "done" | "paused" | "stopped" | "skipped" | "failed" | "needs";

export type Harness = "claude" | "codex";

export interface Project {
  /** The absolute folder. */
  dir: string;
  /** The folder's own name, such as "orchestrator". */
  name: string;
}

/** A refusal or a failure, as sous gives it: what happened, what to change, and the call to make
 *  instead when there is one. Every non-2xx answer of the API has this body under `error`. */
export interface ApiError {
  code: string;
  message: string;
  change: string;
  call: string | null;
  /** The calls to make instead, in the order to try them, when there is more than one. The first is `call`. */
  next?: NextCall[];
}

/** A call a refusal offers, and what it does. */
export interface NextCall {
  call: string;
  does: string;
}

// ── GET /api/overview: what the shell needs on every page ──

export interface Overview {
  /** The sous home folder, ~/.sous or $SOUS_HOME. */
  home: string;
  /** The project `sous serve` started in: the default for workflows, agents, skills and MCP. */
  project: Project;
  /** Every project sous knows, the one above included, for the "Seen from" menu. */
  projects: Project[];
  service: { running: boolean };
  /** Runs with a question, an approval or a breakpoint waiting, for the rail badge. */
  needsYou: number;
  /** The sous version that serves the page. */
  version: string;
}

// ── GET /api/runs: every run, newest first ──

/** Who started a run. "view" is the person on this page, "cli" the person in a terminal. */
export type RunOrigin = "cli" | "view" | "schedule" | "rerun" | "agent" | "check";

export interface RunRow {
  id: string;
  workflow: string;
  /** What the run is about: its first input that is a short string, else the workflow name. */
  title: string;
  project: Project;
  status: Status;
  /** The status in words, such as "Running", "Needs you" or "Paused, budget". */
  statusText: string;
  startedAt: string;
  /** Set once the run ended: completed, failed or stopped. */
  endedAt?: string;
  /** When its state last changed. */
  changedAt?: string;
  tokens: number;
  /** In US dollars, when its steps reported a cost. */
  cost?: number;
  durationMs?: number;
  /** Open questions, approvals and breakpoints. */
  waiting: number;
  origin: RunOrigin;
}

// ── GET /api/runs/:id: one run with its steps, questions and graph ──

export interface RunPage extends RunRow {
  cwd: string;
  place: "worktree" | "folder" | "none";
  branch?: string;
  worktree?: string;
  args: Record<string, unknown>;
  model?: string;
  budget?: number;
  /** Why it paused: "budget", "time_limit", "usage_limit", "login", "interrupted", "step_failed"
   *  and others sous may add. */
  pauseReason?: string;
  /** When the service resumes a run paused at a usage limit. */
  resumesAt?: string;
  failure?: { step?: string; message: string };
  /** What the run returned, once it completed. */
  result?: unknown;
  questions: Question[];
  /** Every step call, in the order they started, nested runs' steps included. */
  steps: Step[];
  /** The workflows this run started inside itself. */
  nested: NestedRun[];
  /** The graph of the workflow text the run started with. Unset when sous can't read the text. */
  flow?: Flow;
  /** The graphs of the nested workflows, by workflow name, from the texts the run started with. */
  flows: Record<string, Flow>;
  /** Which actions fit the run's state now. */
  can: RunActions;
  rerunOf?: string;
  /** The Claude Code and Codex versions its steps ran on. */
  programs?: Partial<Record<Harness, { version?: string }>>;
}

export interface RunActions {
  stop: boolean;
  pause: boolean;
  resume: boolean;
  /** The workflow changed since the run started, so a resume needs --latest or --same. */
  resumeChoice: boolean;
  rerun: boolean;
  /** A run that ended may be removed from the list and the home. */
  remove: boolean;
}

export interface NestedRun {
  id: string;
  /** The run that started it: the root run or another nested run. */
  parent: string;
  workflow: string;
  /** What the script called it, such as the ticket it builds. */
  label?: string;
  branch?: string;
}

export interface Step {
  /** Unique in the run, stable across reads: "<scope>:<id>". Pages put it in ?step=. */
  key: string;
  label: string;
  /** The name `sous log` gives it, such as "ticket A: implementer". Actions on a step take it. */
  name: string;
  /** The run it ran in: the root run's id or a nested run's. */
  scope: string;
  phase?: string;
  /** Which call of this name, from 1, as `sous step --call` counts them. */
  call: number;
  kind: "agent" | "exec";
  status: Status;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  tokens?: number;
  usage?: Usage;
  error?: string;
  /** The start of its result. */
  preview?: string;
  /** How many tries it took, when more than one. */
  tries?: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** US dollars. */
  cost: number;
}

// ── GET /api/runs/:id/step?name=<name>&call=<n>: one step call, whole ──

export interface StepDetail {
  name: string;
  scope: string;
  call: number;
  calls: number;
  kind: "agent" | "exec";
  status: Status;
  model?: string;
  startedAt?: string;
  durationMs?: number;
  tokens?: number;
  /** An agent step's whole prompt. */
  prompt?: string;
  /** A code step's command and the end of what it printed. */
  command?: string;
  output?: string;
  result?: unknown;
  failure?: string;
  /** Everything the step did, oldest first, with secrets hidden. */
  activity: Activity[];
}

export interface Activity {
  seq: number;
  at: string;
  kind: "prompt" | "text" | "tool" | "tool-result" | "command" | "output" | "error" | "note";
  text: string;
  /** The tool's name, for a tool entry, such as "Read" or "Bash". */
  tool?: string;
}

// ── GET /api/questions: every open question, oldest first ──

export interface Question {
  id: string;
  runId: string;
  /** The run that asks: the root run or a nested one. */
  scope: string;
  workflow: string;
  /** The step that asks, for an agent's question. */
  step?: string;
  prompt: string;
  kind: "confirm" | "input" | "select";
  choices?: string[];
  /** A breakpoint takes approve, stop, or send back with a note. */
  breakpoint: boolean;
  /** A breakpoint's title, and the markdown it shows when it shows some. The prompt packs both,
   *  with a hint for the terminal. */
  title?: string;
  show?: string;
  answeredBy: "people" | "anyone";
  askedAt: string;
}

// ── The graph of a workflow's text, for a saved workflow and for a run ──

export interface Flow {
  nodes: FlowNode[];
  /** What the reader could not place, such as a label made at run time. Shown as a quiet note. */
  notes: string[];
}

export type FlowNode = FlowStep | FlowLoop | FlowIf | FlowEnd | FlowParallel | FlowPipeline;

export type StepKind = "agent" | "sh" | "js" | "py" | "run" | "wait" | "ask" | "checkpoint" | "breakpoint" | "workflow" | "choose";

interface FlowBase {
  /** Unique in the flow, stable while the text does not change. */
  id: string;
  /** The 1-based line of the text it starts on, for "show in source". */
  line: number;
}

export interface FlowStep extends FlowBase {
  t: "step";
  kind: StepKind;
  /** The literal label, else the title of an ask, a breakpoint or a checkpoint, else the kind. */
  label: string;
  /** The literal agentType of an agent step. */
  agent?: string;
  model?: string;
  /** The literal `retries` option. */
  retries?: number;
  /** The saved workflow a workflow() step starts. */
  workflow?: string;
  /** The step a breakpoint runs before it waits for the person. */
  body?: FlowNode[];
  /** The label was made at run time, so a run's steps can't be matched to it by name. */
  dynamic?: true;
  /** The phase it runs in: its own `phase` option, else the last phase() call before it in the text. */
  phase?: string;
  /** An agent's or a choose's prompt, as the text writes it, with each expression as {source}. */
  prompt?: string;
  /**
   * A code step's text as the text writes it, with each expression as {source}: the command of
   * sh and waitUntil, the source of js and py, the file of run.
   */
  code?: string;
  /** The name the text keeps its result under, such as "review" in `const review = await agent(...)`. */
  result?: string;
  /**
   * What it reads, in the order the text names them: the result names of earlier steps, the
   * inputs as "args.<name>", and the parameters of the callback it sits in, such as "feedback".
   */
  reads?: string[];
  /** The options the text gives it literally. One the text makes at run time is left out. */
  options?: StepOptions;
}

/** The options of a step that shape what it does, as the text writes them. */
export interface StepOptions {
  timeout?: string;
  effort?: string;
  /** The harness's permission mode. */
  mode?: string;
  isolation?: "worktree";
  skills?: string[];
  mcp?: string[];
  keepSession?: true;
  /** The label of the earlier step whose session it goes on in, from `continue`. */
  continues?: string;
  /** `ask: true`: the agent may stop with a question for the person. */
  asks?: true;
  answeredBy?: "people" | "anyone";
  /** The field names of its schema, when the text writes them. */
  schema?: string[];
  allowFail?: true;
  /** The choices of an ask or a select checkpoint. */
  choices?: string[];
  /** A checkpoint's kind. */
  answer?: "confirm" | "input" | "select";
  /** How many times a breakpoint's step can be sent back. */
  max?: number;
  /** How often waitUntil checks. */
  every?: string;
  /** The inputs a workflow() step passes, each as the text writes it. */
  inputs?: Record<string, string>;
  /** Where a workflow() step's run works. */
  place?: string;
  /** What a choose may pick from. */
  steps?: string[];
  workflows?: string[];
  any?: true;
}

/** gate() and retry() repeat their work, a for or a while loop repeats its body. */
export interface FlowLoop extends FlowBase {
  t: "loop";
  loop: "gate" | "retry" | "for" | "while";
  /** What the loop goes over or why it goes back, as the text writes it, such as "args.rounds". */
  label?: string;
  /** The attempts as the text gives them: a number, or the expression, such as "args.rounds". */
  limit?: string;
  /** A gate's check or a retry's until, as the text writes it, such as "(r) => r.ok". */
  until?: string;
  body: FlowNode[];
}

export interface FlowIf extends FlowBase {
  t: "if";
  /** The condition as the text writes it, such as "!review.ok". */
  cond: string;
  then: FlowNode[];
  else?: FlowNode[];
}

/** A return before the end of the text: the workflow ends here. */
export interface FlowEnd extends FlowBase {
  t: "end";
}

export interface FlowParallel extends FlowBase {
  t: "parallel";
  branches: FlowNode[][];
}

export interface FlowPipeline extends FlowBase {
  t: "pipeline";
  /** The items it runs over, as the text writes them, such as "tickets". */
  over: string;
  /** Each stage's steps, in order. Each item goes through every stage. */
  stages: FlowNode[][];
}

// ── GET /api/workflows: the saved workflows of the project and the home ──

export interface WorkflowRow {
  name: string;
  file: string;
  from: "project" | "home";
  description?: string;
  /** The text changed since the person's last yes. */
  changed: boolean;
  /** Problems the check finds, such as an agent that does not exist. */
  problems: number;
  startedBy: "anyone" | "people";
  lastRun?: { id: string; status: Status; startedAt: string };
}

// ── GET /api/workflows/:name ──

export interface WorkflowPage {
  name: string;
  file: string;
  from: "project" | "home" | "path";
  description?: string;
  inputs: Input[];
  place?: string;
  startedBy: "anyone" | "people";
  /** The cron and its inputs, when the meta has a schedule. */
  schedule?: { cron: string; inputs?: Record<string, unknown> };
  timeout?: string;
  approved: { by: "person" | "agent" | "sous"; at: string; changedSince: boolean; seeded?: true } | null;
  problems: string[];
  notes: string[];
  lastRuns: Array<{ id: string; status: Status; startedAt: string; durationMs?: number; tokens: number }>;
  /** The saved workflows this one starts by name. */
  calls: string[];
  /** The saved workflows that start this one. */
  usedBy: string[];
  /** Saved workflows it starts whose text has no yes yet. */
  waitsOn: string[];
  /** The whole text of the file. */
  source: string;
  flow?: Flow;
}

export interface Input {
  name: string;
  type: "string" | "number" | "boolean" | "json";
  description?: string;
  required: boolean;
  default?: unknown;
  choices?: string[];
}

// ── GET /api/workflows/:name/diff: what changed since the person's yes ──

export interface WorkflowDiff {
  /** True when the person never approved any text of this file. */
  isNew: boolean;
  lines: Array<{ op: " " | "-" | "+"; text: string }>;
  /** Set when the diff was cut at 200 lines. */
  cut?: true;
}

// ── GET /api/agents, GET /api/agents/:name ──

export interface AgentRow {
  name: string;
  description?: string;
  harness: Harness;
  /** Set when it lives in one harness's own folder, so it runs only there. */
  only?: Harness;
  model?: string;
  file: string;
  /** Why a step can't use it as it is. */
  problem?: string;
}

export interface AgentSettings {
  harness: Harness;
  model?: string;
  effort?: string;
  /** Claude Code's permission mode. */
  mode?: string;
  /** "all" when it has no allow list. */
  tools: string[] | "all";
  disallowedTools?: string[];
  skills?: string[];
  mcp?: string[];
}

export interface AgentPage {
  name: string;
  description?: string;
  /** The body of the file, the agent's prompt, in markdown. */
  prompt: string;
  /** The whole file. */
  raw: string;
  file: string;
  from: "rulesync" | Harness;
  scope: "project" | "global";
  /** The harness a step runs it on when the step names none. */
  harness: Harness;
  /** One entry per harness it can run on, the default harness first. */
  settings: AgentSettings[];
  isolation?: "worktree";
  timeout?: string;
  /** The workflow steps that name it. */
  usedBy: Array<{ workflow: string; step: string }>;
  /** Files with the same name that lose to this one. */
  copies: Array<{ file: string; from: "rulesync" | Harness; scope: "project" | "global" }>;
  problem?: string;
}

// ── GET /api/skills, GET /api/skills/:name ──

export interface SkillRow {
  name: string;
  description?: string;
  /** The harnesses that find it. */
  harnesses: Harness[];
  file: string;
}

export interface SkillPage {
  name: string;
  description?: string;
  /** SKILL.md without its front matter. */
  body: string;
  raw: string;
  file: string;
  /** Where each copy lives, one row per folder that has it. */
  copies: Array<{ harness: Harness | "rulesync"; scope: "project" | "global"; file: string }>;
  /** Harnesses that don't find it. */
  missing: Harness[];
  usedBy: Array<{ kind: "agent" | "step"; name: string; workflow?: string }>;
}

// ── GET /api/mcp, GET /api/mcp/:name ──

export interface McpRow {
  name: string;
  type: "stdio" | "http" | "sse";
  /** The harnesses whose steps can name it. */
  seenBy: Harness[];
  /** Where it is defined, such as ".rulesync/mcp.jsonc" or "~/.claude.json". */
  source: string;
}

export interface McpPage extends McpRow {
  command?: string;
  args?: string[];
  url?: string;
  /** Values that hold a secret are masked, such as "••••3f9a" or "${LINEAR_API_KEY}". */
  env: McpValue[];
  headers: McpValue[];
  /** Every file that defines it, the one that wins first. */
  files: Array<{ file: string; scope: "project" | "global"; harness: Harness | "rulesync" }>;
  usedBy: Array<{ kind: "agent" | "step"; name: string; workflow?: string }>;
  /** The server's entry as the file writes it, with secrets masked. */
  raw: string;
}

export interface McpValue {
  key: string;
  value: string;
  secret: boolean;
  /** Where sous reads it: "secrets.env", "the environment", or nothing for a literal. */
  from?: string;
}

// ── GET /api/settings ──

export interface Settings {
  home: string;
  /** config.json as sous reads it, with its defaults. */
  config: Record<string, unknown>;
  service: { running: boolean; pid?: number };
  accounts: Array<{ program: Harness; name: string; current: boolean }>;
}

// ── POST /api/call: run one sous command as the person, through the page ──

/** The commands the page may call. Each takes the words the command line takes after `sous`,
 *  such as ["answer", "q-1a2b", "yes"]. The server adds --json and records the person, through
 *  the view. */
export type CallCommand = "run" | "rerun" | "resume" | "pause" | "stop" | "answer" | "approve" | "send-back" | "tell" | "workflows";

export interface CallRequest {
  argv: string[];
}

export type CallReply =
  | { ok: true; data: Record<string, unknown>; notes: string[]; next: Array<{ call: string; does: string }> }
  | { ok: false; error: ApiError };

// ── DELETE /api/runs/:id: remove a run that ended from the list and the home ──
// ── POST /api/workflows/:name/trash: move a saved workflow file to the home's trash ──

export interface Removed {
  removed: string;
  /** Where the file went, for a workflow. */
  trash?: string;
}

// ── GET /api/live: server-sent events, one JSON object per `data:` line ──

export type LiveEvent =
  | { type: "hello"; at: string }
  /** Something changed in the home. The page reads again what it shows of it. */
  | { type: "changed"; runs: string[]; questions: boolean; workflows: boolean; catalog: boolean };

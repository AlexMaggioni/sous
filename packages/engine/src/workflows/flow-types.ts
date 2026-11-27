// The types of the graph that workflowFlow (flow.ts) reads from a workflow's text. They are the
// "Flow" section of packages/view/src/api/contract.ts, field for field. The server passes this
// tree where the contract's type is expected.

export interface Flow {
  nodes: FlowNode[];
  /** What the reader could not place, such as a label made at run time. */
  notes: string[];
}

export type FlowNode = FlowStep | FlowLoop | FlowIf | FlowEnd | FlowParallel | FlowPipeline;

export type StepKind = "agent" | "sh" | "js" | "py" | "run" | "wait" | "ask" | "breakpoint" | "workflow" | "choose";

interface FlowBase {
  /** Unique in the flow, stable while the text does not change. */
  id: string;
  /** The 1-based line of the text it starts on. */
  line: number;
}

export interface FlowStep extends FlowBase {
  t: "step";
  kind: StepKind;
  /** The literal label, else the title of an ask or a breakpoint, else the kind. */
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
  skills?: string[];
  mcp?: string[];
  /** The label of the session() or fork() handle a send() runs on. */
  session?: string;
  /** The label of the step whose session it goes on from: the handle's send before it, or for a
   *  fork's first send, the parent's last send before the fork() call. */
  continues?: string;
  /** When an agent step ends: when the agent reports done, or when its one turn ends. */
  until?: "done" | "turn";
  /** `ask: true`: the agent may stop with a question for the person. */
  asks?: true;
  /** The checks that run when the agent says done: each command as the text writes it, or
   *  "function" for a function. */
  check?: string[];
  /** The most turns sous sends in the step. */
  maxTurns?: number;
  /** The most repair turns after an answer that does not fit. */
  maxRepairs?: number;
  /** Who may answer an ask(). */
  answeredBy?: "people" | "anyone";
  /** The field names of its schema, when the text writes them. */
  schema?: string[];
  /** The input of a code step, an ask or a breakpoint, as the text writes it. */
  input?: string;
  allowFail?: true;
  /** The choices of an ask. */
  choices?: string[];
  /** How many times a breakpoint's step can be sent back. */
  max?: number;
  /** How often waitUntil checks. */
  every?: string;
  /** The inputs a workflow() step passes, each as the text writes it. */
  inputs?: Record<string, string>;
  /** Where a workflow() step's run works, or "worktree" for an agent step that works in a worktree of its own. */
  place?: string;
  /** What a choose may pick from. */
  steps?: string[];
  workflows?: string[];
  any?: true;
}

export interface FlowLoop extends FlowBase {
  t: "loop";
  loop: "for" | "while";
  /** What a for or a while loop goes over, or its condition, as the text writes it. */
  label?: string;
  /**
   * How many rounds a counted for loop runs, as the text gives them, such as "3" or "args.rounds":
   * the bound of `for (let i = 0; i < N; i++)`, or of `for (let i = 1; i <= N; i++)`.
   */
  limit?: string;
  body: FlowNode[];
}

export interface FlowIf extends FlowBase {
  t: "if";
  /** The condition as the text writes it. A catch block's is "error". */
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
  /** The items it runs over, as the text writes them. */
  over: string;
  /** Each stage's steps, in order. Each item goes through every stage. */
  stages: FlowNode[][];
}

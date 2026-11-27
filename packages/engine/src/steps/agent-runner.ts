// The seam between the engine and whatever runs an agent step: the steps module, or a
// test's fake. The engine calls route(), when the runner has one, and run(). It builds no runner
// of its own (WorkflowRunOptions.agent is required). Code steps never come here. StepRequest
// types every field the engine sends, so a renamed field fails the build.
import type { StepRequest } from "./agent-run.js";
import type { RoutePlan } from "../agents.js";

/** What the engine knows about an agent step before it routes it. */
export interface StepAsk {
  label?: string;
  agentType?: string;
  /** The step's own values, after per-run overrides. */
  model?: string;
  effort?: string;
  skills?: string[];
  mcp?: string[];
  timeout?: number | string;
  isolation?: "worktree";
  /** The run's model for this step: its phase route, else meta.model, else the run's default. */
  runModel?: string;
}

/** Where a step goes, and the parts of it the engine hashes and records. */
export interface StepRoute {
  /** The model the step asked for. It goes into the call hash, the run record and continuation. */
  requested?: string;
  /** The agent's part of the call hash, in the format agentDefinitionKey gives. Null without an agent. */
  agentKey: string | null;
  isolation?: "worktree";
  /** The agent's instructions. */
  prompt?: string;
  /** What the runner that made this route runs. The engine passes it back and never reads it. */
  plan?: RoutePlan;
  /** Why the step cannot run. The runner refuses the step when it runs it. */
  problem?: string;
}

export interface AgentRunner {
  /**
   * Run one agent step to completion. The engine relies on these rules, so changing one means
   * changing the engine's call in workflow.ts too.
   *
   *  - `prompt` is a plain string. `request` is one bag.
   *
   *  - The return is the raw value (AgentResult), never an envelope. With a schema it is the
   *    parsed and validated object. Without one it is the agent's final text. Usage goes to
   *    request.onUsage, not into the return.
   *
   *  - The return must be JSON and stable for a given resume identity, which hashAgentCall in
   *    workflow.ts computes. The engine journals the value as it is (onAgentJournal) and replays
   *    it on resume. The engine gives each call its index when the script makes the call, before
   *    the limiter, so the runner must not depend on the order calls start or finish.
   *
   *  - On failure, throw. A WorkflowError from this package keeps its code and `recoverable`
   *    flag. The engine sorts errors with wrapError: a recoverable one is retried up to
   *    agentRetries times. After the last try, or on an error a retry cannot fix, the run
   *    pauses on the step, also inside parallel() and pipeline(). The codes a runner raises are AGENT_EMPTY_OUTPUT
   *    (recoverable, no text on a call without a schema), SCHEMA_NONCOMPLIANCE (the answer
   *    never matched the schema) and PROVIDER_USAGE_LIMIT (the subscription limit, which pauses
   *    the run and carries resetHint). The engine adds AGENT_CANCELLED, WORKFLOW_ABORTED and
   *    SCRIPT_ERROR itself.
   *
   *  - The engine owns stopping. It passes request.signal, and the steps module hands that
   *    signal to the harness, which stops the step.
   *
   *  - Questions to the user are not the runner's job. The engine asks them through its
   *    options.confirm callback.
   */
  run(prompt: string, request: StepRequest): Promise<unknown>;

  /**
   * Where a step goes. It is synchronous and never throws: a step that cannot run gets a route
   * with a problem, which run() refuses. The engine calls it once per agent call, before it
   * hashes the call, and sends the route back in the request. A runner without it gets a route
   * with no agent, and the agent's name as a hint in the instructions.
   */
  route?(ask: StepAsk): StepRoute;

  /**
   * Closes the program a step's turns kept open for the session (request.hold), and settles once
   * it has exited. The engine calls it when the step ends, before a question waits, and when the
   * run ends. It never throws. A runner without it keeps no program.
   */
  release?(sessionId: string): Promise<void>;
}

// The seam between the engine and whatever runs an agent step: the steps module, or a
// test's fake. The engine calls only run(), and it builds no runner of its own
// (WorkflowRunOptions.agent is required). Code steps never come here. The field names in
// RunOptions are the real contract: the engine spreads extra fields into the same bag, so a
// renamed field can stop reaching the runner without a compile error.
import type { TSchema } from "typebox";
import type { AgentResult, RunOptions } from "./agent-run.js";

export interface AgentRunner {
  /**
   * Run one agent step to completion. The engine relies on these rules, so changing one means
   * changing the engine's call in workflow.ts too.
   *
   *  - `prompt` is a plain string. `options` is one bag and may be left out.
   *
   *  - The return is the raw value, never an envelope. With a schema it is the parsed and
   *    validated object. Without one it is the agent's final text. Usage goes to
   *    options.onUsage, not into the return.
   *
   *  - The return must be JSON and stable for a given resume identity, which hashAgentCall in
   *    workflow.ts computes. The engine journals the value as it is (onAgentJournal) and replays
   *    it on resume. The engine gives each call its index when the script makes the call, before
   *    the limiter, so the runner must not depend on the order calls start or finish.
   *
   *  - On failure, throw. A WorkflowError from this package keeps its code and `recoverable`
   *    flag. The engine sorts errors with wrapError: a recoverable one is retried up to
   *    agentRetries times, then the step returns null. Any other error stops the run, also
   *    inside parallel() and pipeline(). The codes a runner raises are AGENT_EMPTY_OUTPUT
   *    (recoverable, no text on a call without a schema), SCHEMA_NONCOMPLIANCE (the answer
   *    never matched the schema) and PROVIDER_USAGE_LIMIT (the subscription limit, which pauses
   *    the run and carries resetHint). The engine adds AGENT_CANCELLED, WORKFLOW_ABORTED and
   *    SCRIPT_ERROR itself.
   *
   *  - The engine owns stopping. It passes options.signal, and the steps module hands that
   *    signal to the harness, which stops the step.
   *
   *  - Questions to the user are not the runner's job. The engine asks them through its
   *    options.confirm callback.
   */
  run<S extends TSchema | undefined = undefined>(
    prompt: string,
    options?: RunOptions<S>,
  ): Promise<AgentResult<S>>;
}

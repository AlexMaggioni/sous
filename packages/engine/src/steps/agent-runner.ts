// The seam between the engine and whatever runs an agent step: the steps module, or a
// test's fake. The engine calls only run(), and it builds no runner of its own
// (WorkflowRunOptions.agent is required). Code steps never come here. The field names in
// RunOptions are the real contract: the engine spreads extra fields into the same bag, so a
// renamed field can stop reaching the runner without a compile error.
import type { TSchema } from "typebox";
import type { AgentResult, RunOptions } from "./agent-run.js";

export interface AgentRunner {
  /**
   * Run ONE subagent to completion.
   *
   * FROZEN CONTRACT (do not widen it without changing the engine's call site):
   *
   *  - `prompt` is a plain positional string; `options` is one optional bag that
   *    DEFAULTS TO {} (the engine's historical Pick<WorkflowAgent,"run"> seam relies
   *    on options being optional).
   *
   *  - RETURN is the RAW value, NEVER an envelope (AgentResult):
   *       schema present => Static<schema>   (a parsed + validated object)
   *       no schema       => the assistant's final text (string)
   *    Usage is delivered OUT-OF-BAND via options.onUsage; it is NOT in the return.
   *    A {result, usage} wrapper would change the frozen call — rejected.
   *
   *  - The return MUST be JSON-serializable and STABLE for a fixed resume identity
   *    (sha256{prompt, model, mode-when-set, tier, phase, agentType, agentDef, schema}, hashAgentCall
   *    workflow.ts:1045-1064): the engine journals it verbatim (onAgentJournal,
   *    workflow.ts:502) and replays it on resume (:413). callIndex is assigned at
   *    LEXICAL call time before the limiter (:391), so parallel()/pipeline() fan-out
   *    stays reproducible — the runner MUST NOT depend on invocation/completion order
   *    for identity.
   *
   *  - On failure THROW — ideally a WorkflowError{code, recoverable} from this same
   *    package (so `instanceof` holds across packages). The engine classifies via
   *    wrapError (:515): recoverable => retried up to agentRetries then resolves null;
   *    non-recoverable => rethrown and halts the run (incl. inside parallel/pipeline).
   *    Leaf codes the runner raises:
   *      AGENT_EMPTY_OUTPUT     (recoverable)      no assistant text on a no-schema call
   *      SCHEMA_NONCOMPLIANCE   (non-recoverable)  schema never satisfied after the ladder
   *      PROVIDER_USAGE_LIMIT   (non-recoverable)  quota/rate wall -> engine PAUSES, carries resetHint
   *    (AGENT_CANCELLED + WORKFLOW_ABORTED + SCRIPT_ERROR are added by the ENGINE, not the runner.)
   *
   *  - ABORT is the ENGINE's responsibility: the engine passes options.signal and calls
   *    throwIfAborted() before/after. The steps module passes options.signal to the harness,
   *    which stops the step.
   *
   *  - There is NO checkpoint method: human-in-the-loop is the engine's options.confirm
   *    callback (workflow.ts:798-829), not a runner concern.
   */
  run<S extends TSchema | undefined = undefined>(
    prompt: string,
    options?: RunOptions<S>,
  ): Promise<AgentResult<S>>;
}

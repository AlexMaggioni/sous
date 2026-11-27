// What one agent step is given and what it returns: the step request, AgentResult and usage.
import type { Static, TSchema } from "typebox";
import type { Account } from "@sous-run/harnesses";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { McpServerConfig } from "./mcp-config.js";
import type { StepRoute } from "./agent-runner.js";
import type { AgentSessionRef } from "../workflow-result.js";

/** Real token/cost usage for ONE subagent run. Delivered OUT-OF-BAND via
 *  EngineFields.onUsage — NEVER via run()'s return value. Fires on BOTH the success
 *  AND error paths (agent.ts:441-455) so partial usage is never lost. `total === 0`
 *  is the "provider reported nothing" sentinel -> the engine falls back to a chars/4
 *  estimate (workflow.ts:444). onUsage may never fire at all, so every consumer
 *  tolerates usage === undefined. The steps module fills it from the harness's usage.
 *  Codex reports no dollar cost, so its cost is 0. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export type ContinuationSkipReason =
  // engine-side gates — candidate existed at the index but a gate rejected it, no reattach
  // attempted:
  | "hash-mismatch" // recorded hash !== the live call's hash at this index (script changed)
  | "inputs-mismatch" // recorded inputsHash !== the live call's inputsHash, or either is absent
  | "worktree-isolated" // the call is worktree-isolated
  | "cwd-mismatch" // recorded cwd !== the call's resolved cwd
  | "cwd-missing" // the call's resolved cwd does not exist on disk
  // runner-side gates — reattach attempted and abandoned before the continuation turn:
  | "backend-mismatch" // recorded backendId or effective poolKey !== the resolved backend
  | "capability-missing" // the current connection advertises neither session/resume nor session/load
  | "reattach-failed" // load/resume rejected, session gone, or a spawn/auth error at reopen
  // engine-synthesized — the runner ignored continueFromSession and reported no continuation
  // provenance:
  | "runner-declined";

/** The outcome of a resume-only session continuation attempt. */
export type ContinuationAttempt =
  | { reattached: true; method: "resume" | "load" }
  | { reattached: false; reason: ContinuationSkipReason };

/** Out-of-band result provenance a wrapping/caching AgentRunner MAY report for the
 *  current attempt: whether the result it returns was produced live or replayed
 *  from a recording. Generic — any memoizing or record/replay wrapper can report it;
 *  the engine never fabricates a value; absence means an ordinary live call. */
export type AgentResultProvenance =
  | { source: "live"; overrideModel?: string; continuation?: ContinuationAttempt }
  | {
      source: "replay";
      recordedRunId?: string;
      recordedIndex?: number;
      hashMatched?: boolean;
    };

export interface PromptImage {
  readonly data: string;
  readonly mimeType: string;
  readonly uri?: string;
}

/**
 * The fields the engine sets on every agent call. A runner gets them in the step request, and a
 * test's or the dry run's runner gets them again once the steps module has planned the step.
 * Inputs go in (prompt, schema, images, cwd, signal, instructions). Reports come back through the
 * on* callbacks, never through the return value. `mcpServers`, `runId` and the session hand-off
 * fields wire the call, so none enters the resume identity hash (hashAgentCall). A kept turn's
 * hash holds the hash of its session's turn before it instead. The call identity context (`callIndex`, `callHash`,
 * `callPath`, `callInputsHash`) is scoped to one engine call and does not enter the resume
 * identity hash.
 */
export interface EngineFields<S extends TSchema | undefined = TSchema | undefined> {
  /** Human label for logs/telemetry. NOT part of the resume identity hash. */
  label?: string;
  /** typebox schema. Present => result is Static<schema>; absent => result is text.
   *  KEPT as typebox: it is JSON.stringify'd into the resume hash (hashAgentCall,
   *  workflow.ts:1062), so its exact serialization is part of journal identity AND it
   *  already IS a JSON Schema object that feeds Claude outputFormat / Codex outputSchema
   *  downstream. Freeze the exact object handed to hashAgentCall; normalize for Codex on
   *  a COPY, never mutate the hashed value. */
  schema?: S;
  /** The step's system text: its agent's prompt and its label. The engine builds it, the same for
   *  every turn of one session. NOT hashed. */
  instructions?: string;
  /** Engine-owned cancellation. The steps module joins it with the step's time limit and
   *  passes the result to the harness, which stops the step when it fires. */
  signal?: AbortSignal;
  /** The harness mode. Claude Code: a permission mode. Codex: read-only, workspace-write,
   *  agent or agent-full-access. When omitted, Claude Code uses `auto` where the model
   *  offers it, and Codex uses `agent`. A mode the harness lacks leaves its default and adds
   *  a note. */
  mode?: string;
  /** Working directory (e.g. an isolated git worktree). ABSOLUTE. The harness runs the step there. NOT hashed. */
  cwd?: string;
  /** Real usage for one runner attempt. A runner MAY invoke this multiple times within
   *  an attempt; every report is a CUMULATIVE snapshot for that attempt, and the last
   *  report received before the attempt settles wins. Fires on success AND error. May
   *  never fire. */
  onUsage?: (usage: AgentUsage) => void;
  /** Out-of-band result provenance for the current attempt. The last report received
   *  before the attempt settles wins; late reports are dropped by the engine. */
  onResultProvenance?: (provenance: AgentResultProvenance) => void;
  /** The actually-resolved concrete model id (display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /** A compact snapshot of this subagent's message/tool history (diagnostic only). */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Client-provided MCP servers for this step. The harness gets each one in place of a
   *  configured server of the same name. ADDITIVE and NOT part of the resume identity hash
   *  (hashAgentCall): it wires tools, not the logical call. */
  mcpServers?: McpServerConfig[];
  /** Engine run id. The steps module names the run with it when it takes an agent slot.
   *  NOT part of the resume identity hash (hashAgentCall): it does not identify the call. */
  runId?: string;
  /** Base64 image attachments sent with the prompt. The steps module checks each one's data
   *  and mimeType, and a bad one fails the step with SCRIPT_VALIDATION_ERROR. */
  images?: readonly PromptImage[];
  /** The step's session handle, fired once, the first time the harness reports a session id
   *  (a failure that carries one counts). It holds the sessionId, the harness, the cwd, the
   *  reopen flags and, when the step picked one, the model. Like every on* callback it is
   *  OUT-OF-BAND: run()'s return value stays the bare AgentResult. NOT part of the resume
   *  identity hash. */
  onSessionOpen?: (session: AgentSessionRef) => void;
  /** The session's latest CUMULATIVE cost gauge at release (`AgentSessionRef.costGauge`): the
   *  session's total so far, NOT this call's spend (that is `onUsage`'s `cost`). Fires at most
   *  once, next to `onUsage`, and only when the agent reported a cost. `onSessionOpen` fires
   *  before the first prompt and so cannot carry it; a host that records the ref for a later
   *  `continueFromSession` folds this value into the recorded ref. Best-effort and out-of-band
   *  like every on* callback; NOT part of the resume identity hash. */
  onSessionCostGauge?: (amount: number) => void;
  /** RESUME-ONLY. When set, the steps module resumes this session on its harness and
   *  continues the interrupted turn instead of starting a fresh session. When the harness
   *  differs, or the session is gone, the call runs fresh, which IS the fallback. ADDITIVE and
   *  NOT part of the resume identity hash (hashAgentCall) or the input fingerprint
   *  (hashCallInputs): it changes how a live call reaches its result, never the logical call.
   *  Omitted => a fresh session with the original prompt. */
  continueFromSession?: AgentSessionRef;
  /** With `continueFromSession`, this call is a kept turn of a session: send its own prompt into
   *  the reopened session instead of the resume instruction. A kept turn never runs fresh. On
   *  another program, or when the program lost the session, the step fails. */
  continueWithPrompt?: boolean;
  /** The engine's deterministic journal index for THIS agent() call — the same
   *  value as JournalEntry.index / WorkflowCallRecord.index. Assigned at lexical
   *  call time BEFORE the concurrency limiter; identical on every retry attempt.
   *  The index space is shared with checkpoint() (runner-visible indexes have gaps
   *  at checkpoint positions) and scoped to ONE engine run — `runId` is the scope
   *  discriminator at this seam; (runId, callIndex) is a cross-run key only when
   *  the caller keeps runIds unique (WorkflowManager does; bare runWorkflow
   *  callers own that precondition). ADDITIVE, not a hash input.
   *  Omitted only by callers that are not the engine. */
  callIndex?: number;
  /** The call-identity hash for THIS call — the same value as JournalEntry.hash /
   *  WorkflowCallRecord.hash. Proves the prompt and the REQUESTED (script-resolved)
   *  model spec — never the model a backend actually served, and never the unhashed
   *  inputs (label/cwd/images/mcpServers/meta). Identical across retry attempts.
   *  ADDITIVE, not itself a hash input. */
  callHash?: string;
  /** The structural call-path key for THIS call: body-relative "line:column"
   *  workflow-script frames, innermost first, joined with "<". Stable for a
   *  byte-identical script under the same call-path format + Node major. Identical
   *  across retry attempts. ABSENT when capture failed or was ambiguous — never
   *  fabricated, never truncated. ADDITIVE, not hashed. */
  callPath?: string;
  /** The input fingerprint for THIS call: sha256 of the canonical strict-JSON of
   *  the call's resolved unhashed execution inputs (cwd/isolation/images/mcpServers/
   *  label/effective timeout+retries), with keepSession always false and the meta, promptMeta
   *  and backends keys always null. Identical across retry attempts. ABSENT when any component fails
   *  strict-JSON canonicalization — never fabricated. ADDITIVE, not a hash input. */
  callInputsHash?: string;
}

/** What the engine sends the runner for one agent call. */
export interface StepRequest<S extends TSchema | undefined = TSchema | undefined> extends EngineFields<S> {
  /** Where the step goes: the runner's own route(), or the engine's route with no agent for a
   *  runner with none. The steps module runs its plan and refuses its problem. */
  route: StepRoute;
  /** route.requested, the model spec the step asked for (`harness/modelId`, a bare `modelId`,
   *  or a harness alone), for runners with no route() of their own. Omitted => the harness
   *  default. */
  model?: string;
}

/** What a test's or the dry run's runner gets once the steps module has planned the step. It
 *  gets no call identity: no stand-in reads it. */
export interface PlannedRequest extends Omit<EngineFields, "callIndex" | "callHash" | "callPath" | "callInputsHash"> {
  /** The model spec that runs, with its harness. */
  model?: string;
  effort?: string;
  skills?: string[];
  toolNames?: string[];
  disallowedToolNames?: string[];
  /** The account the step's harness runs as. */
  account?: Account;
  /** A resume's note on a slash prompt, which goes apart from the prompt. On a plain prompt the
   *  note is in the prompt, after a blank line. */
  note?: string;
}

/** The result side of the seam: schema => the validated object, no schema => text.
 *  NO wrapper. Usage is separate (onUsage). Must be JSON-round-trippable. */
export type AgentResult<S extends TSchema | undefined = undefined> = S extends TSchema ? Static<S> : string;

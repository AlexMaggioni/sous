// What one agent step is given and what it returns: RunOptions, AgentResult and usage.
import type { Static, TSchema } from "typebox";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { McpServerConfig } from "./mcp-config.js";
import type { AgentSessionRef } from "../workflow-result.js";

/** Real token/cost usage for ONE subagent run. Delivered OUT-OF-BAND via
 *  RunOptions.onUsage — NEVER via run()'s return value. Fires on BOTH the success
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
 * The opts side of the AgentRunner seam — exactly the bag the engine passes at
 * workflow.ts:465 (cast `as any` there; frozen-typed here). Inputs flow IN
 * (prompt/schema/images/model/tier/cwd/signal/instructions/tool policy); telemetry flows
 * OUT via the on* callbacks, NEVER via the return value.
 *
 * NAME = RunOptions (the Phase-1 deliverable name); `AgentRunOptions` is exported as
 * a lift-compat alias so ported pi engine code that imports the old name resolves.
 *
 * FIELD NAMES ARE FROZEN: the engine binds these by name through an `as any` cast
 * (workflow.ts:488), so a renamed field would NOT raise a compile error — it would
 * mis-bind at runtime. Engine-passed core fields: label, schema, signal, instructions,
 * images, model, mode, tier, toolNames, disallowedToolNames, cwd, onModelResolved, onModelFallback,
 * onUsage, and onHistory. Plus run inputs that wire infrastructure, so none enters the resume
 * identity hash (hashAgentCall): `mcpServers`, `runId`, and the session hand-off fields
 * `onSessionOpen` / `continueFromSession`. A script's configOptions, meta, promptMeta and
 * keepSession stay in the call's identity and inputs, but no step reads them, so they are not here.
 * `maxSchemaRetries` is runner-internal (the engine never passes it). Pi's
 * `tools?: ToolDefinition[]` is DROPPED — a pi-coding-agent type with no ACP analog (ACP
 * injects tools via session/new mcpServers, not this field) and never passed by the engine.
 * The additive call identity context (`callIndex`, `callHash`, `callPath`,
 * `callInputsHash`) is scoped to one engine call and does not enter the resume
 * identity hash.
 */
export interface RunOptions<S extends TSchema | undefined = undefined> {
  /** Human label for logs/telemetry. NOT part of the resume identity hash. */
  label?: string;
  /** typebox schema. Present => result is Static<schema>; absent => result is text.
   *  KEPT as typebox: it is JSON.stringify'd into the resume hash (hashAgentCall,
   *  workflow.ts:1062), so its exact serialization is part of journal identity AND it
   *  already IS a JSON Schema object that feeds Claude outputFormat / Codex outputSchema
   *  downstream. Freeze the exact object handed to hashAgentCall; normalize for Codex on
   *  a COPY, never mutate the hashed value. */
  schema?: S;
  /** Extra system guidance (engine builds it from phase/agentType/isolation). NOT hashed. */
  instructions?: string;
  /** Engine-owned cancellation. The runner SHOULD wire this to the backend session cancel
   *  (ACP session/cancel) but MUST NOT implement its own timeout. */
  signal?: AbortSignal;
  /** Model spec (`provider/modelId` or bare `modelId`). Runner interprets: cross-provider =>
   *  which ACP server to spawn; within-provider => ACP session config selection
   *  (`session/set_config_option`, surfaced as SessionHandle.selectModel()).
   *  Omitted => session default. */
  model?: string;
  /** Exact agent-advertised ACP session mode id. When omitted, the runner explicitly applies the
   *  built-in default (Claude `auto`, Codex `agent`; custom backends retain no host
   *  default). An authored or built-in default must be advertised or the run fails before prompt.
   *  A mode does not silently invent a client-side allow/deny policy: live permission requests are
   *  handled by the host resolver, while explicitly authored tool allow/deny lists remain binding. */
  mode?: string;
  /** Coarse tier ("small" | "medium" | "big"). Consulted only when `model` is unset; `model` wins. */
  tier?: string;
  /** Working directory (e.g. an isolated git worktree). ABSOLUTE. Maps to ACP session/new {cwd}. NOT hashed. */
  cwd?: string;
  /** Tool allow-list (agentType `tools`). Runner maps to ACP permission auto-responses / mode. */
  toolNames?: string[];
  /** Tool deny-list (agentType `disallowedTools`), applied after the allow-list. */
  disallowedToolNames?: string[];
  /** With `schema`: extra client-side repair turns before strict prose extraction. Leaf default 2.
   *  Runner-internal — the engine never passes it and it is NOT plumbed to the MCP tool. */
  maxSchemaRetries?: number;
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
  /** A requested model/tier/phase spec that wasn't found (fell back to the session default). */
  onModelFallback?: (requestedSpec: string) => void;
  /** A compact snapshot of this subagent's message/tool history (diagnostic only). */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Client-provided MCP servers to attach to this run (ACP `session/new { mcpServers }`).
   *  ADDITIVE and NOT part of the resume identity hash (hashAgentCall) — it wires tools,
   *  not the logical call. Omitted/empty => the runner sends `mcpServers: []` (the default). */
  mcpServers?: McpServerConfig[];
  /** Engine run id, stamped onto the outgoing ACP `session/new` `_meta` under
   *  META_KEYS.runId as an end-to-end correlation id for tracing/telemetry. ADDITIVE and NOT
   *  part of the resume identity hash (hashAgentCall) — it correlates, it does not identify the
   *  logical call. Omitted => no runId `_meta` is stamped. */
  runId?: string;
  /** Base64 image attachments appended to the prompt as ACP image ContentBlocks. When the
   *  connected agent does not advertise promptCapabilities.image, each attachment DEGRADES to a
   *  bracketed text note (never an error, never silently dropped) per the ACP rule that the client
   *  adapts content to the agent's advertised prompt capabilities. */
  images?: readonly PromptImage[];
  /** The run's ACP session identity, fired EXACTLY ONCE for whichever acquisition wins:
   *  `session/new`, or `session/resume`/`session/load` on a successful reattach — never
   *  twice. A failed reattach that falls to a fresh `session/new` fires it exactly once for
   *  the fresh handle. Fires before the first prompt, once the model selection settled, with the
   *  re-attach handle — sessionId, backend, cwd, the agent-advertised reopen capabilities, and the
   *  model selected on the session (a rejected selection still reports the session, without one). Best-effort observer (a
   *  throwing callback is isolated, never fails the run) and, like every on* callback,
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
  /** RESUME-ONLY reattach directive. When set, the runner attempts to reopen this exact ACP
   *  session (via session/resume, else session/load) and CONTINUE the interrupted turn instead of
   *  opening a fresh session/new. Advisory: a runner that ignores it — or any reattach failure —
   *  runs the call fresh, which IS the fallback. ADDITIVE and NOT part of the resume identity hash
   *  (hashAgentCall) or the input fingerprint (hashCallInputs): it changes how a live call reaches
   *  its result, never the logical call. Omitted => today's fresh session/new + original-prompt
   *  path. */
  continueFromSession?: AgentSessionRef;
  /** With `continueFromSession`, send this call's own prompt into the reopened
   *  session instead of the resume instruction. The engine sets it for agent({ continue }). */
  continueWithPrompt?: boolean;
  /** The engine's deterministic journal index for THIS agent() call — the same
   *  value as JournalEntry.index / WorkflowCallRecord.index. Assigned at lexical
   *  call time BEFORE the concurrency limiter; identical on every retry attempt.
   *  The index space is shared with checkpoint() (runner-visible indexes have gaps
   *  at checkpoint positions) and scoped to ONE engine run — `runId` is the scope
   *  discriminator at this seam; (runId, callIndex) is a cross-run key only when
   *  the caller keeps runIds unique (WorkflowManager and runIsolation do; bare
   *  runWorkflow callers own that precondition). ADDITIVE, not a hash input.
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
   *  meta/promptMeta/keepSession/label/effective timeout+retries/backends
   *  digest). Identical across retry attempts. ABSENT when any component fails
   *  strict-JSON canonicalization — never fabricated. ADDITIVE, not a hash input. */
  callInputsHash?: string;
}

/** The result side of the seam: schema => the validated object, no schema => text.
 *  NO wrapper — usage is separate (onUsage). Must be JSON-round-trippable.
 *  NAME = AgentResult (Phase-1 deliverable name); `AgentRunResult` is the lift-compat alias. */
export type AgentResult<S extends TSchema | undefined = undefined> = S extends TSchema ? Static<S> : string;

import { createHash } from "node:crypto";
import { captureCallPath } from "./call-path.js";
import { assertExplicitCheckpointDecision } from "./checkpoint-provenance.js";
import { fitAnswer, isSchemaObject } from "./steps/answer.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { projectRecordedError } from "./recorded-error.js";
import type { LedgerCall, Pairing, StepSlot } from "./step-ledger.js";
import { deepFreeze, hashCanonicalStrictJson, strictSnapshot } from "./strict-json.js";
import type { JournalEntry, WorkflowCheckpointTaken } from "./workflow-result.js";

/** Observable checkpoint-input fingerprint format. Bump when its inputs or encoding change. */
export const CHECKPOINT_INPUTS_FORMAT = 2;

/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
  /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
  kind?: "confirm" | "input" | "select";
  /** For kind "select". */
  choices?: string[];
  /** Per-checkpoint timeout in ms for the interactive prompt. */
  timeoutMs?: number;
  /** The shape of the answer, a JSON schema. An answer that does not fit is refused, with the
   *  reason, and the question is asked again. It goes into the hash when set. */
  schema?: Record<string, unknown>;
}

/** What marks a question, beside its call: a breakpoint, a question anyone may answer, and the
 *  label of the agent step that asks. It stays out of the hash, so a question asked before it
 *  existed keeps its hash, and a script's checkpoint() cannot set it. */
export interface CheckpointPurpose {
  breakpoint?: true;
  /** A breakpoint's title, and the text it shows when it shows one. The prompt packs both, with a
   *  hint for the terminal. */
  title?: string;
  show?: string;
  /** "anyone" lets an agent answer too. "join" is a question an agent's turn asked: the person
   *  answers it by stepping into the session, so the inbox and the page refuse it. */
  answeredBy?: "anyone" | "join";
  step?: string;
}

/** What a question shows. One an agent asked in its turn names the step that needs the person,
 *  who reads the agent's message in its session. The journal keeps the message. */
export function shownPrompt(prompt: string, purpose: CheckpointPurpose | undefined): string {
  if (purpose?.answeredBy !== "join") return prompt;
  return purpose.step ? `"${purpose.step}" needs you in its session.` : "An agent needs you in its session.";
}

/** The engine-computed identity of one checkpoint() call, handed to the confirm
 *  callback as its additive third argument. */
export interface CheckpointCallContext {
  callIndex: number;
  hash: string;
  /** The emitting engine run's runId (root, or `${root}-nested<ordinal>`). */
  scope: string;
  /** The structural call-path key, when captured. */
  path?: string;
  /** Set when breakpoint(), ask() for anyone or an asking agent asks. */
  purpose?: CheckpointPurpose;
  /** Set by the run manager. The host calls it once it has asked the question, and the run's
   *  event log gets an "asked" event. */
  asked?: () => void;
  /** Why the last answer was refused, when the question is asked again: it did not fit the
   *  question's schema. */
  refused?: string;
}

/** The host's answer to a checkpoint() question. */
export type CheckpointConfirm = (
  promptText: string,
  options: CheckpointOptions,
  context?: CheckpointCallContext,
) => Promise<unknown>;

/** What a checkpoint() call needs from the run that asks it. A run builds one for all its calls. */
export interface CheckpointRun {
  /** The asking run's id, the scope of its records. */
  runId: string;
  /** The run's stop signal, and the host's pause signal. */
  signal: AbortSignal;
  pauseSignal: AbortSignal | undefined;
  /** The run tree's shared state: the call cap's count and the latch of an unanswered question. */
  shared: { agentCount: number; pendingCheckpoint?: WorkflowError };
  /** The run's gates, the same ones an agent() call passes. */
  gates: {
    /** Refuses a new call once the run stops, waits on a question or pauses. */
    throwIfAborted(): void;
    /** Discards a value in hand once the run stops or waits on a question. */
    throwIfHalted(): void;
    pauseRequested(): boolean;
    pauseError(): WorkflowError;
    checkAgentLimit(): void;
    /** Settles a call opened while the run halts as interrupted, and refuses it. */
    interruptIfHalting(slot: StepSlot): void;
  };
  /** The host's callbacks. The run passes its own options object, so the host reads them as before. */
  host: { confirm?: CheckpointConfirm };
  /** True when the run resumes under the manager's plan. */
  resuming: boolean;
  /** The run's phase now. A question reads it when it settles. */
  phase(): string | undefined;
  /** The script realm's Object.prototype, known once the script's context exists. */
  realmObjectPrototype(): object | undefined;
  /** The script's file name and prelude length, to read the call path. */
  vmFilename: string;
  preludeLines: number;
  /** Notes an answered question in the run's result and tells the host. */
  taken(entry: WorkflowCheckpointTaken): void;
}

/**
 * One checkpoint() call, from its admission to its record. Only an explicit answer crosses a
 * human checkpoint. A missing answer pauses the run, and a replay keeps the recorded answer and
 * its versioned provenance. The run calls it straight from its start for a call, with no frame in
 * between, so the stack that captureCallPath reads keeps its depth.
 */
export async function checkpointCall(
  run: CheckpointRun,
  promptText: string,
  checkpointOptions: CheckpointOptions,
  open: (call: LedgerCall) => StepSlot,
  purpose: CheckpointCallContext["purpose"],
): Promise<unknown> {
  run.gates.throwIfAborted();
  if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
  run.gates.checkAgentLimit();
  validateCheckpointOptionKeys(checkpointOptions, run.realmObjectPrototype());
  const checkpointTimeoutMs = checkpointOptions.timeoutMs;
  const checkpointKind = checkpointOptions.kind;
  const checkpointChoices = checkpointOptions.choices;
  const checkpointSchema = checkpointOptions.schema;
  const capturedCheckpointOptions: CheckpointOptions = {
    ...(checkpointKind !== undefined ? { kind: checkpointKind } : {}),
    ...(checkpointChoices !== undefined ? { choices: checkpointChoices } : {}),
    ...(checkpointTimeoutMs !== undefined ? { timeoutMs: checkpointTimeoutMs } : {}),
    ...(checkpointSchema !== undefined ? { schema: checkpointSchema } : {}),
  };
  validateCheckpointOptions(capturedCheckpointOptions);
  const callHash = hashCheckpoint(promptText, capturedCheckpointOptions);
  const callInputsHash = hashCheckpointInputs(capturedCheckpointOptions);
  const callPath = captureCallPath(run.vmFilename, run.preludeLines);
  const slot = open({
    kind: "checkpoint",
    hash: callHash,
    ...(callPath !== undefined ? { path: callPath } : {}),
    ...(callInputsHash !== undefined ? { inputsHash: callInputsHash } : {}),
  });
  const callIndex = slot.index;
  // A halt settles the question as interrupted.
  slot.arm(() => {
    const error = run.gates.pauseRequested()
      ? new WorkflowError(
          `checkpoint "${promptText}" was not asked because the workflow paused by host request`,
          WorkflowErrorCode.PAUSE_REQUESTED,
          { recoverable: false },
        )
      : new WorkflowError(
          `checkpoint "${promptText}" interrupted because workflow execution halted`,
          WorkflowErrorCode.WORKFLOW_ABORTED,
          { recoverable: true },
        );
    slot.settle({
      outcome: "error",
      origin: "engine",
      error: projectRecordedError(error),
      aborted: true,
    });
  }, false);
  run.gates.interruptIfHalting(slot);
  run.shared.agentCount++;

  const journalEntry = (result: unknown): JournalEntry => deepFreeze({
    index: callIndex,
    hash: callHash,
    result,
    kind: "checkpoint" as const,
    checkpointDecision: "explicit-v1" as const,
    scope: run.runId,
    call: { kind: "checkpoint" as const, label: "checkpoint" as const, phase: run.phase() },
  });

  const replayCheckpoint = (pairing: Extract<Pairing<unknown>, { action: "replay" }>): unknown => {
    const { row, value: resultSnapshot } = pairing;
    // A row with no call row is the run's own journal row, which only an answer writes.
    const checkpointHostDecision = row.injected === true || row.call === undefined ||
      row.call.origin === "confirm" ||
      (row.call.origin === "journal-replay" && row.call.replay?.checkpointHostDecision === true);
    const terminalRecord = slot.settle({
      outcome: "result",
      origin: "journal-replay",
      checkpointDecision: "explicit-v1",
      replay: {
        sourceRunId: row.sourceRunId,
        recordedIndex: row.recordedIndex,
        match: pairing.match,
        ...(checkpointHostDecision ? { checkpointHostDecision: true as const } : {}),
        ...(row.injected ? { checkpointInjected: true as const } : {}),
      },
    }, pairing.journaled ? undefined : journalEntry(resultSnapshot));
    if (terminalRecord.outcome !== "result") return resultSnapshot;
    const checkpointTaken: WorkflowCheckpointTaken = deepFreeze({
      callIndex,
      kind: checkpointKind ?? "confirm",
      decision: resultSnapshot,
      source: row.injected ? "injected" : "journal-replay",
    });
    run.taken(checkpointTaken);
    return resultSnapshot;
  };

  try {
    const pairing = slot.pair((row) => {
      assertExplicitCheckpointDecision(row.entry);
      return strictSnapshot(row.entry.result, `checkpoint "${promptText}" replayed reply`);
    });
    if (pairing.action === "replay") return replayCheckpoint(pairing);
    slot.live(pairing.reason);
  } catch (error) {
    slot.settle({
      outcome: "error",
      origin: run.resuming ? "engine" : "journal-replay",
      error: projectRecordedError(error),
    });
    throw error;
  }

  const origin = run.host.confirm ? "confirm" as const : "engine" as const;
  const waiting = () => run.shared.pendingCheckpoint ??= new WorkflowError(
    `checkpoint "${promptText}" awaits an explicit human decision`,
    WorkflowErrorCode.CHECKPOINT_REQUIRED,
    {
      recoverable: false,
      checkpointContext: {
        callIndex,
        hash: callHash,
        prompt: promptText,
        kind: checkpointKind ?? "confirm",
        ...(checkpointChoices === undefined ? {} : { choices: checkpointChoices }),
        ...(checkpointTimeoutMs === undefined ? {} : { timeoutMs: checkpointTimeoutMs }),
      },
    },
  );
  try {
    const confirm = run.host.confirm;
    if (!confirm) throw waiting();
    // One ask of the question. When an answer did not fit the schema, the question is asked again
    // with the reason.
    const askOnce = async (refused: string | undefined): Promise<unknown> => {
      let reply: unknown;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      let onPause: (() => void) | undefined;
      try {
        const prompt = refused === undefined ? promptText : `${promptText}\n\nThe last answer was refused: ${refused}. Answer again.`;
        const answer = confirm.call(run.host, prompt, capturedCheckpointOptions, {
          callIndex,
          hash: callHash,
          scope: run.runId,
          path: callPath,
          ...(purpose ? { purpose } : {}),
          ...(refused === undefined ? {} : { refused }),
        });
        const interruption = new Promise<never>((_, reject) => {
          onAbort = () => reject(new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true }));
          run.signal.addEventListener("abort", onAbort, { once: true });
          if (run.signal.aborted) onAbort();
          // A pause request unwinds a waiting question the same way a stop does; the pending
          // checkpoint keeps its durable context and is asked again on resume.
          onPause = () => reject(run.gates.pauseError());
          run.pauseSignal?.addEventListener("abort", onPause, { once: true });
          if (run.gates.pauseRequested()) onPause();
          if (checkpointTimeoutMs !== undefined) timeout = setTimeout(() => reject(waiting()), checkpointTimeoutMs);
        });
        reply = await Promise.race([answer, interruption]);
      } catch {
        run.gates.throwIfAborted();
        throw waiting();
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (onAbort) run.signal.removeEventListener("abort", onAbort);
        if (onPause) run.pauseSignal?.removeEventListener("abort", onPause);
      }
      return reply;
    };
    let reply = await askOnce(undefined);
    for (;;) {
      if (reply === undefined) throw waiting();
      run.gates.throwIfHalted();
      if (checkpointSchema === undefined) break;
      const fit = fitAnswer(reply, checkpointSchema, purpose?.breakpoint === true);
      if (fit.ok) {
        reply = fit.value;
        break;
      }
      reply = await askOnce(fit.reason);
    }
    let replySnapshot: unknown;
    try {
      replySnapshot = strictSnapshot(reply, `checkpoint "${promptText}" reply`);
    } catch {
      // A value that cannot become a durable decision is still unanswered. Latch the
      // checkpoint so the script cannot catch serialization failure and cross its gate.
      throw waiting();
    }
    const terminalRecord = slot.settle(
      { outcome: "result", origin, checkpointDecision: "explicit-v1" },
      journalEntry(replySnapshot),
    );
    if (terminalRecord.outcome !== "result") return reply;
    const checkpointTaken: WorkflowCheckpointTaken = deepFreeze({
      callIndex,
      kind: checkpointKind ?? "confirm",
      decision: replySnapshot,
      source: "live",
    });
    run.taken(checkpointTaken);
    return reply;
  } catch (error) {
    const aborted = run.signal.aborted || run.gates.pauseRequested();
    slot.settle({
      outcome: "error",
      origin: aborted ? "engine" : origin,
      error: projectRecordedError(error),
      ...(aborted ? { aborted: true as const } : {}),
    });
    throw error;
  }
}

export function hashCheckpointInputs(options: CheckpointOptions): string | undefined {
  const timeoutMs = options.timeoutMs;
  return hashCanonicalStrictJson({
    checkpointDecision: "explicit-v1",
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

/** Stable identity hash for a checkpoint() call — a cache miss on resume when anything changes. */
function hashCheckpoint(promptText: string, options: CheckpointOptions): string {
  const identity = JSON.stringify({
    promptText,
    kind: options.kind ?? "confirm",
    choices: options.choices ?? null,
    // Set only when given, so a question asked before schemas existed keeps its hash.
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
  });
  return createHash("sha256").update(identity).digest("hex");
}

function validateCheckpointOptionKeys(options: CheckpointOptions, realmObjectPrototype: object | undefined): void {
  const invalid = (detail: string): never => {
    throw new WorkflowError(`checkpoint() ${detail}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
  };
  if (!options || typeof options !== "object" || Array.isArray(options)) invalid("options must be a plain object");
  const prototype = Reflect.getPrototypeOf(options);
  if (prototype !== null && prototype !== Object.prototype && prototype !== realmObjectPrototype) {
    invalid("options must be a plain object");
  }
  const allowed = new Set(["kind", "choices", "timeoutMs", "schema"]);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      invalid(`unsupported option ${String(key)}; checkpoints require an explicit answer (headless and default are retired)`);
    }
  }
}

function validateCheckpointOptions(options: CheckpointOptions): void {
  const invalid = (detail: string): never => {
    throw new WorkflowError(`checkpoint() ${detail}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
  };
  if (options.kind !== undefined && !["confirm", "input", "select"].includes(options.kind)) invalid("kind must be confirm, input, or select");
  if (options.choices !== undefined && (!Array.isArray(options.choices) || options.choices.some(choice => typeof choice !== "string"))) {
    invalid("choices must be an array of strings");
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    invalid("timeoutMs must be a positive finite number");
  }
  if (options.schema !== undefined && !isSchemaObject(options.schema)) invalid("schema must be a JSON schema object");
}

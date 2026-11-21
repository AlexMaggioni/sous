// Ambient DSL globals for AgentPrism workflow SCRIPTS — author IntelliSense only.
//
// A workflow script is a string executed inside a Node `vm` realm (see
// workflow-engine/src/workflow.ts). The orchestration primitives below are injected
// into that realm as GLOBALS — they are NOT importable functions and there is nothing
// to `import` from this SDK to obtain them. This file declares their shapes so an
// editor offers completion/parameter hints while authoring a script; it ships no
// runtime code.
//
// This is a global ambient SCRIPT (no top-level import/export), so the declarations
// below augment the global scope. Referenced option types are pulled in via inline
// `import(...)` type queries, which do NOT turn this file into a module. Signatures
// mirror workflow.ts exactly (verified against the injected vm context).

type AgentPrismAgentOptions = import("@automatalabs/workflow-engine").AgentOptions & {
  /** Legacy diagnostic annotation. New workflows should omit it.
   * @deprecated Replay is determined by recorded call correspondence, not world state. */
  resume?: { filesystem: "read-only" };
  /** Let the agent stop with a question. The run asks the user, then continues the same session with the answer. */
  ask?: boolean;
};

/** Options shared by the code steps: sh, js, py, run and waitUntil. */
type OrchestratorStepOptions = {
  label?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** sh and run: return a non-zero exit as a result instead of failing the step. */
  allowFail?: boolean;
  /** Seconds, or a string such as "90s", "10m" or "2h". */
  timeout?: number | string;
  /** Tries after the first failure. Code steps default to 0. */
  retries?: number;
  phase?: string;
};

/** What a code step returns. `result` is the value the code returned or wrote to $ORC_RESULT. */
type OrchestratorStepResult = { code: number; stdout?: string; stderr?: string; result?: unknown };

/**
 * Run ONE subagent to completion and return its result. With `options.schema` the
 * result is the validated object; otherwise it is the assistant's final text.
 * Each call is journaled under a deterministic index for resume. `options.model` may be a
 * backend-only harness name, or a registered harness prefix plus an id sent verbatim after
 * that one prefix is stripped; unregistered prefixes remain part of the id on the default.
 * `options.configOptions` passes exact agent-advertised option ids and string/boolean values;
 * validate first and use its selected-model table to choose them.
 */
declare function agent(
  prompt: string,
  options?: AgentPrismAgentOptions,
): Promise<unknown>;

/**
 * Run an array of THUNKS concurrently and resolve to their results in input order.
 * Pass functions, not promises: `parallel([() => agent("a"), () => agent("b")])`.
 * A recoverable failure becomes `null` in its slot; a non-recoverable one halts the run.
 */
declare function parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]>;

/**
 * Map `items` through one or more sequential async `stages`, concurrently across items.
 * Each stage receives `(prev, original, index)`. Resolves to the final value per item
 * (a recoverable per-item failure yields `null` for that item).
 */
declare function pipeline(
  items: unknown[],
  ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
): Promise<unknown[]>;

/**
 * Run a saved workflow (by name) or a raw script inline, sharing this run's
 * limiter/counters. Nests at most five levels deep by default. `place` asks the host
 * for the child's own folder: "worktree", "folder" or "none".
 */
declare function workflow(
  nameOrScript: string,
  args?: unknown,
  options?: { place?: string },
): Promise<unknown>;

/**
 * Adversarial verification panel: `reviewers` subagents vote on whether `item` is
 * real/correct; passes when the share voting real meets `threshold`.
 */
declare function verify(
  item: unknown,
  options?: { reviewers?: number; threshold?: number; lens?: string | string[] },
): Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real?: boolean; reason?: string }> }>;

/**
 * LLM-judge panel: score each candidate in `attempts` with `judges` graders against
 * `rubric` and return the highest mean-scoring candidate (stable tie-break by index).
 */
declare function judgePanel(
  attempts: unknown[],
  options?: { judges?: number; rubric?: string },
): Promise<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;

/**
 * Repeatedly invoke `round(i)` collecting fresh (deduped by `key`) items until it
 * yields nothing `consecutiveEmpty` rounds in a row (or `maxRounds` is hit). Returns
 * every unique item gathered.
 */
declare function loopUntilDry(options: {
  round: (roundIndex: number) => Promise<unknown[]> | unknown[];
  key?: (item: unknown) => string;
  consecutiveEmpty?: number;
  maxRounds?: number;
}): Promise<unknown[]>;

/**
 * Ask a critic subagent what is still MISSING given the task args and results so far.
 */
declare function completenessCheck(taskArgs: unknown, results: unknown): Promise<unknown>;

/**
 * Bounded retry: call `thunk(attempt)` up to `attempts` times, stopping early once
 * `until(result)` holds. Returns the last result when attempts are exhausted.
 */
declare function retry(
  thunk: (attempt: number) => Promise<unknown> | unknown,
  options?: { attempts?: number; until?: (result: unknown) => boolean },
): Promise<unknown>;

/**
 * Validation gate: call `thunk(feedback, attempt)`, validate it, and feed the
 * validator's feedback into the next attempt until it passes or `attempts` run out.
 */
declare function gate<
  TValue = unknown,
  TVerdict extends boolean | { ok: boolean; feedback?: string } | null = {
    ok: boolean;
    feedback?: string;
  },
>(
  thunk: (feedback: string | undefined, attempt: number) => Promise<TValue> | TValue,
  validator: (result: TValue) => Promise<TVerdict> | TVerdict,
  options?: { attempts?: number },
): Promise<{
  ok: boolean;
  value: TValue;
  verdict: TVerdict | null;
  attempts: number;
}>;

/**
 * Deterministic, journaled human checkpoint. Spends no tokens. Requires an explicit
 * answer through the SDK confirm callback or a durable checkpointReplies continuation.
 */
declare function checkpoint(
  promptText: string,
  options?: import("@automatalabs/workflow-engine").CheckpointOptions,
): Promise<unknown>;

/** Append a line to the run log. */
declare function log(message: string): void;

/** Open a named phase for subsequent agents. */
declare function phase(title: string): void;

/** The arguments passed into this run (the host-provided input bag). */
declare const args: unknown;

/** Run a shell command as a step. A non-zero exit fails the step unless `allowFail` is set. */
declare function sh(command: string, options?: OrchestratorStepOptions): Promise<OrchestratorStepResult>;

/** Run JavaScript as a step, in its own Node process. The code reads `input` and may `return` a value. */
declare function js(source: string, input?: unknown, options?: OrchestratorStepOptions): Promise<OrchestratorStepResult>;

/** Run Python as a step. The code reads `input` and may `return` a value. */
declare function py(source: string, input?: unknown, options?: OrchestratorStepOptions): Promise<OrchestratorStepResult>;

/** Run a script file as a step, chosen by its extension (.js .mjs .py .sh, else run directly). */
declare function run(
  file: string,
  options?: OrchestratorStepOptions & { args?: string[]; input?: unknown },
): Promise<OrchestratorStepResult>;

/** Run `command` every `every` seconds (default 60) until it exits 0. No agent runs. */
declare function waitUntil(
  command: string,
  options?: OrchestratorStepOptions & { every?: number | string },
): Promise<OrchestratorStepResult>;

/** Ask the user a question and wait for the answer. With `choices`, the answer is one of them. */
declare function ask(question: string, options?: { choices?: string[] }): Promise<string>;

/**
 * Stop for the user's approval. The user approves, stops the run, or sends the step back
 * with a note. With a step function, the step reruns with the note until approved.
 */
declare function breakpoint(
  title: string,
  options?: { show?: unknown },
): Promise<{ decision: "approve" | "send back"; note?: string }>;
declare function breakpoint<T>(
  title: string,
  step: (note?: string) => Promise<T> | T,
  options?: { show?: (result: T) => unknown; max?: number },
): Promise<T>;

/** Let an agent pick the next step or workflow among the listed ones, then run it. */
declare function choose(
  prompt: string,
  options: {
    steps?: Record<string, ((input?: unknown) => unknown) | { description?: string; run: (input?: unknown) => unknown }>;
    workflows?: Array<string | { name: string; description?: string }>;
    /** Allow any saved workflow. */
    any?: boolean;
    input?: unknown;
    /** Allow the agent to pick nothing. */
    none?: boolean;
    agentType?: string;
    model?: string;
    label?: string;
  },
): Promise<{ choice: string; reason: string; result?: unknown }>;

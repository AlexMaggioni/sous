// Script functions added on top of agent() and checkpoint().
//
// Code steps (sh, js, py, run, waitUntil) go to the engine's code() as a spec. The engine runs
// them itself, so they get the journal, resume, retries, limits and events of any step.

import type { CheckpointPurpose } from "./checkpoint-call.js";
import type { ExecSpec } from "./code-steps.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { decisionOf } from "./runs/inbox.js";
import { parseDurationSeconds } from "./duration.js";

export const DEFAULT_MAX_NESTING_DEPTH = 5;

type AgentFn = (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;
/** What a code step passes besides its spec. */
export interface CodeStepOptions {
  label: string;
  retries: number;
  timeout?: number | string;
  phase?: string;
}
type CodeFn = (spec: ExecSpec, options: CodeStepOptions) => Promise<unknown>;
type CheckpointFn = (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;
type MarkedCheckpointFn = (prompt: string, options: Record<string, unknown>, purpose: CheckpointPurpose) => Promise<unknown>;
type WorkflowFn = (name: string, args?: unknown, options?: { place?: string; label?: string }) => Promise<unknown>;

export interface SousGlobalDeps {
  agent: AgentFn;
  code: CodeFn;
  checkpoint: CheckpointFn;
  /** The checkpoint that marks its question: a breakpoint, a question anyone may answer, or an
   *  asking agent's question with its step. */
  markedCheckpoint: MarkedCheckpointFn;
  workflow: WorkflowFn;
  log: (message: string) => void;
  listSavedWorkflows?: () => Array<{ name: string; description?: string }>;
  /** Per-run changes to steps, by label, such as { reviewer: { model: "haiku" } }. */
  stepOverrides?: Record<string, Record<string, unknown>>;
}

interface StepOptions {
  label?: string;
  cwd?: string;
  env?: Record<string, string>;
  allowFail?: boolean;
  timeout?: number | string;
  retries?: number;
  phase?: string;
}

const QUESTION_PREFIX = "QUESTION:";
const ASK_INSTRUCTIONS =
  `\n\nIf you cannot go on without a decision from the user, stop and reply with one line that starts with "${QUESTION_PREFIX}" followed by your question. ` +
  "You will get the answer in this same session and can continue.";

function fail(message: string): never {
  throw new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
}

function shortLabel(prefix: string, text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return `${prefix}: ${firstLine.length > 40 ? `${firstLine.slice(0, 40)}...` : firstLine}`;
}

/** Who may answer a question: "people", the default, or "anyone". Anything else fails the script. */
function answeredByOf(value: unknown, where: string): "people" | "anyone" {
  if (value === undefined || value === "people" || value === "anyone") return value ?? "people";
  return fail(`${where}: answeredBy is "people" or "anyone", got ${JSON.stringify(value)}`);
}

function plainCopy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function createSousGlobals(deps: SousGlobalDeps) {
  let askSeq = 0;

  const exec = (spec: ExecSpec, options: StepOptions, defaultLabel: string): Promise<unknown> => {
    const fullSpec: ExecSpec = {
      ...spec,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      ...(options.allowFail ? { allowFail: true } : {}),
    };
    return deps.code(fullSpec, {
      label: options.label ?? defaultLabel,
      retries: options.retries ?? 0,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.phase === undefined ? {} : { phase: options.phase }),
    });
  };

  /** Run a shell command. Returns { code, stdout, stderr }. */
  const sh = (command: string, options: StepOptions = {}) => {
    if (typeof command !== "string" || !command.trim()) fail("sh(command) needs a command string");
    return exec({ kind: "sh", command }, options, shortLabel("sh", command));
  };

  /** Run JavaScript in Node. `input` is a variable in the code; a returned value is `result`. */
  const js = (source: string, input?: unknown, options: StepOptions = {}) => {
    if (typeof source !== "string") fail("js(source, input) needs the code as a string");
    return exec({ kind: "js", source, input: plainCopy(input) }, options, options.label ? options.label : "js");
  };

  /** Run Python. `input` is a variable in the code; a returned value is `result`. */
  const py = (source: string, input?: unknown, options: StepOptions = {}) => {
    if (typeof source !== "string") fail("py(source, input) needs the code as a string");
    return exec({ kind: "py", source, input: plainCopy(input) }, options, options.label ? options.label : "py");
  };

  /** Run a script file. It reads `input` as JSON on stdin and may write its result as JSON to $SOUS_RESULT. */
  const run = (file: string, options: StepOptions & { args?: string[]; input?: unknown } = {}) => {
    if (typeof file !== "string" || !file.trim()) fail("run(file) needs a file path");
    const { args, input, ...rest } = options;
    return exec({ kind: "file", file, ...(args ? { args: [...args] } : {}), input: plainCopy(input) }, rest, shortLabel("run", file));
  };

  /** Check a command every few seconds, with no agent, until it exits 0. */
  const waitUntil = (command: string, options: StepOptions & { every?: number | string } = {}) => {
    if (typeof command !== "string" || !command.trim()) fail("waitUntil(command) needs a command string");
    const everySeconds = parseDurationSeconds(options.every ?? 60) ?? 60;
    const timeoutSeconds = parseDurationSeconds(options.timeout);
    const { every: _every, timeout: _timeout, ...rest } = options;
    return exec(
      { kind: "wait", command, everySeconds, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) },
      rest,
      shortLabel("wait", command),
    );
  };

  /** Ask a question, marked with its purpose when it has one. */
  const asked = async (question: string, choices: string[] | undefined, purpose: CheckpointPurpose) => {
    const options = choices ? { kind: "select", choices } : { kind: "input" };
    const reply = Object.keys(purpose).length ? await deps.markedCheckpoint(question, options, purpose) : await deps.checkpoint(question, options);
    return typeof reply === "string" ? reply : reply === undefined || reply === null ? "" : JSON.stringify(reply);
  };

  /** Ask the user. With choices, the answer is one of them; without, free text. With answeredBy
   *  "anyone", an agent may answer too. */
  const ask = async (question: string, options: { choices?: string[]; answeredBy?: unknown } = {}) => {
    if (typeof question !== "string" || !question.trim()) fail("ask(question) needs a question");
    const anyone = answeredByOf(options.answeredBy, "ask()") === "anyone";
    return asked(question, options.choices ? [...options.choices] : undefined, anyone ? { answeredBy: "anyone" } : {});
  };

  /**
   * Stop for a person to check the run. They approve, stop the run, or send the step back
   * with a note. With a step function, the function runs, its result is shown, and a send
   * back runs it again with the note, until approved.
   */
  const breakpoint = async (
    title: string,
    stepOrOptions?: ((note?: string) => unknown) | { show?: unknown },
    maybeOptions: { show?: (result: unknown) => unknown; max?: number } = {},
  ): Promise<unknown> => {
    if (typeof title !== "string" || !title.trim()) fail("breakpoint(title) needs a title");
    const marked = (options: unknown) => typeof options === "object" && options !== null && (options as { answeredBy?: unknown }).answeredBy !== undefined;
    if (marked(stepOrOptions) || marked(maybeOptions)) fail("breakpoint() takes no answeredBy: a breakpoint is always for people");
    // JSON.stringify gives undefined for a function or a symbol, which shows as its String.
    const render = (value: unknown) => (value === undefined ? "" : typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value)));
    const prompt = (shown: unknown) =>
      `Breakpoint: ${title}\n${shown === undefined ? "" : `\n${render(shown)}\n`}\nReply approve, stop, or send back with a note.`;
    const decide = async (shown: unknown) => {
      const show = render(shown).trim();
      const decision = decisionOf(await deps.markedCheckpoint(prompt(shown), { kind: "input" }, { breakpoint: true, title, ...(show ? { show } : {}) }));
      if (decision.decision === "stop") {
        throw new WorkflowError(`Stopped at breakpoint "${title}"${decision.note ? `: ${decision.note}` : ""}`, WorkflowErrorCode.WORKFLOW_ABORTED, {
          recoverable: false,
        });
      }
      return decision;
    };
    if (typeof stepOrOptions !== "function") return decide(stepOrOptions?.show);
    const max = maybeOptions.max ?? 5;
    let note: string | undefined;
    for (let round = 1; ; round++) {
      const result = await stepOrOptions(note);
      const decision = await decide(maybeOptions.show ? maybeOptions.show(result) : result);
      if (decision.decision === "approve") return result;
      if (round >= max) fail(`breakpoint "${title}" was sent back ${max} times`);
      note = decision.note;
    }
  };

  type ChoiceStep = ((input?: unknown) => unknown) | { description?: string; run: (input?: unknown) => unknown };

  /**
   * Let an agent pick where the run goes next, among listed steps or workflows. The chosen
   * one runs and its result comes back as { choice, reason, result }.
   */
  const choose = async (
    prompt: string,
    options: {
      steps?: Record<string, ChoiceStep>;
      workflows?: Array<string | { name: string; description?: string }>;
      any?: boolean;
      input?: unknown;
      none?: boolean;
      agentType?: string;
      model?: string;
      label?: string;
    } = {},
  ): Promise<{ choice: string; reason: string; result?: unknown }> => {
    const entries: Array<{ name: string; description?: string; kind: "step" | "workflow" }> = [];
    for (const [name, step] of Object.entries(options.steps ?? {})) {
      entries.push({ name, description: typeof step === "function" ? undefined : step.description, kind: "step" });
    }
    const workflowEntries = [...(options.workflows ?? [])];
    if (options.any) {
      for (const saved of deps.listSavedWorkflows?.() ?? []) workflowEntries.push(saved);
    }
    for (const workflow of workflowEntries) {
      const entry = typeof workflow === "string" ? { name: workflow } : workflow;
      if (!entries.some((e) => e.name === entry.name)) entries.push({ ...entry, kind: "workflow" });
    }
    if (options.none) entries.push({ name: "none", description: "Do nothing more.", kind: "step" });
    if (entries.length === 0) fail("choose() needs at least one step or workflow");
    const listing = entries.map((e) => `- ${e.name}${e.description ? `: ${e.description}` : ""}`).join("\n");
    // Through agent(), so the run's changes for this step's label apply as they do to any step.
    const picked = (await agent(`${prompt}\n\nPick exactly one of these and say why in one sentence:\n${listing}`, {
      label: options.label ?? "choose",
      schema: {
        type: "object",
        properties: { choice: { type: "string", enum: entries.map((e) => e.name) }, reason: { type: "string" } },
        required: ["choice", "reason"],
      },
      ...(options.agentType ? { agentType: options.agentType } : {}),
      ...(options.model ? { model: options.model } : {}),
    })) as { choice: string; reason: string };
    const entry = entries.find((e) => e.name === picked.choice);
    if (!entry) fail(`choose(): the agent picked "${picked.choice}", which is not listed`);
    if (entry.name === "none" && options.none) return { choice: "none", reason: picked.reason };
    if (entry.kind === "workflow") {
      return { choice: entry.name, reason: picked.reason, result: await deps.workflow(entry.name, options.input) };
    }
    const step = options.steps![entry.name]!;
    const result = await (typeof step === "function" ? step(options.input) : step.run(options.input));
    return { choice: entry.name, reason: picked.reason, result };
  };

  /**
   * agent() with two sous additions: per-run step changes by label, and `ask: true`,
   * where the agent can stop with a question, the user answers, and the same session goes on.
   * Its questions carry the step's label, and `answeredBy` says who may answer them.
   */
  const agent = async (prompt: string, options: Record<string, unknown> = {}): Promise<unknown> => {
    const { ask: canAsk, answeredBy, ...rest } = options;
    const anyone = answeredByOf(answeredBy, "agent()") === "anyone";
    if (anyone && !canAsk) fail("agent(): answeredBy \"anyone\" works with ask: true");
    const label = typeof rest.label === "string" ? rest.label : undefined;
    const override = label ? deps.stepOverrides?.[label] : undefined;
    const merged: Record<string, unknown> = override ? { ...rest, ...override } : rest;
    if (!canAsk) return deps.agent(prompt, merged);
    if (merged.schema !== undefined) fail("agent(..., { ask: true }) works with text results only");
    const askLabel = label ?? `asking-agent-${++askSeq}`;
    let turn = 0;
    let result = await deps.agent(`${prompt}${ASK_INSTRUCTIONS}`, { ...merged, label: askLabel, keepSession: true });
    while (typeof result === "string" && result.trim().startsWith(QUESTION_PREFIX)) {
      turn++;
      if (turn > 5) fail(`agent "${askLabel}" asked more than 5 questions`);
      const question = result.trim().slice(QUESTION_PREFIX.length).trim();
      const answer = await asked(`${askLabel} asks: ${question}`, undefined, { ...(anyone ? { answeredBy: "anyone" as const } : {}), step: askLabel });
      result = await deps.agent(`The user answered: ${answer}\n\nContinue the task.${ASK_INSTRUCTIONS}`, {
        ...merged,
        label: `${askLabel} (answer ${turn})`,
        continue: turn === 1 ? askLabel : `${askLabel} (answer ${turn - 1})`,
        keepSession: true,
      });
    }
    return result;
  };

  return { agent, sh, js, py, run, waitUntil, ask, breakpoint, choose };
}

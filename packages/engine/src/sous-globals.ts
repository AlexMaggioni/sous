// Script functions added on top of agent() and checkpoint().
//
// Code steps (sh, js, py, run, waitUntil) go to the engine's code() as a spec. The engine runs
// them itself, so they get the journal, resume, retries, limits and events of any step.
// session() and agent() come from turns/session.ts, and room() from room/room.ts. Each removed
// function fails the script with what to write instead.

import type { CheckpointPurpose } from "./checkpoint-call.js";
import type { CodeStepEnv, ExecSpec } from "./code-steps.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { decisionOf, type Decision } from "./runs/inbox.js";
import { parseDurationSeconds } from "./duration.js";
import { isSchemaObject } from "./steps/answer.js";
import { cloneStrictJsonValue } from "./strict-json.js";
import { createRoom, type RoomNote } from "./room/room.js";
import { createSessions, type SessionPlaces } from "./turns/session.js";

type AgentFn = (prompt: string, options: Record<string, unknown>) => Promise<unknown>;
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
  /** The checkpoint that marks its question: a breakpoint, or a question anyone may answer. */
  markedCheckpoint: MarkedCheckpointFn;
  workflow: WorkflowFn;
  log: (message: string) => void;
  listSavedWorkflows?: () => Array<{ name: string; description?: string }>;
  /** Per-run changes to steps, by label, such as { reviewer: { model: "haiku" } }. */
  stepOverrides?: Record<string, Record<string, unknown>>;
  /** A step's folder, resolved as the engine resolves a step's cwd. A handle's cwd comes from it. */
  resolveCwd: (cwd: string | undefined) => string;
  /** Wraps a function the script calls, as the script's globals are wrapped. A handle's send() gets it. */
  track?: <F extends (...args: never[]) => unknown>(fn: F) => F;
  /** Set in a dry run: the code steps' hook for a check command's exit code. */
  onDryRunCheck?: CodeStepEnv["onDryRunCheck"];
  /** Closes the program a step in the session `key` kept open, when the step ends. */
  endSession?: (key: string) => Promise<void>;
  /** Starts the session `key` as a copy of the session `from`, for a handle's fork(). */
  forkSession?: (from: string, key: string) => boolean;
  /** Where sessions and steps with place "worktree" work. */
  places?: SessionPlaces;
  /** The script's parallel(). A room runs its turns through it. */
  parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
  /** Gets each room as it stands: at its start, after each answer and at its end. */
  onRoom?: (room: RoomNote) => void;
}

interface StepOptions {
  label?: string;
  cwd?: string;
  env?: Record<string, string>;
  allowFail?: boolean;
  timeout?: number | string;
  retries?: number;
  phase?: string;
  /** The shape of the step's value. A value that does not fit fails the step. */
  schema?: unknown;
}

/** The step's input, which must be strict JSON. The step fails the script when it is not. */
function inputOf(value: unknown, where: string): unknown {
  if (value === undefined) return undefined;
  const copy = cloneStrictJsonValue(value);
  if (!copy.ok) fail(`${where}: input must be strict JSON, and it is not at ${copy.path}`);
  return copy.clone;
}

/** The step's schema, which must be a JSON schema object. The step fails the script when it is not. */
function schemaOf(value: unknown, where: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const copy = cloneStrictJsonValue(value);
  if (!copy.ok || !isSchemaObject(copy.clone)) fail(`${where}: schema must be a JSON schema object`);
  return copy.clone as Record<string, unknown>;
}

/** An input as the question shows it, after the question and a blank line. */
function inputBlock(input: unknown): string {
  return `Input:\n${JSON.stringify(input, null, 2)}`;
}

const LOOP = "Give the step check and maxTurns, or write a plain loop.";
/** Functions a script once had. Each fails the script with what to write instead. */
const REMOVED_GLOBALS = {
  retry: `retry() is gone. ${LOOP}`,
  gate: `gate() is gone. ${LOOP}`,
  checkpoint: "checkpoint() is gone. Use ask() to ask the person.",
} as const;

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
  const { session, agent, describe, watch, inRoom } = createSessions({
    agent: deps.agent,
    resolveCwd: deps.resolveCwd,
    // A check command is a code step that may fail, as sh runs it.
    command: async (command, { step, ...options }) => {
      const ran = await exec({ kind: "sh", command }, { ...options, allowFail: true }, options.label, "check");
      if (!deps.onDryRunCheck) return ran;
      const code = (ran as { code?: unknown } | undefined)?.code;
      deps.onDryRunCheck({ step, command, code: typeof code === "number" ? code : -1 });
      return { ...(ran as object), code: 0 };
    },
    // A question waits on a join row. Only the person who steps into the session answers it.
    join: (message, label) => deps.markedCheckpoint(message, { kind: "input" }, { answeredBy: "join", step: label }),
    ...(deps.endSession ? { end: deps.endSession } : {}),
    ...(deps.forkSession ? { fork: deps.forkSession } : {}),
    ...(deps.stepOverrides ? { stepOverrides: deps.stepOverrides } : {}),
    ...(deps.track ? { track: deps.track } : {}),
    ...(deps.places ? { places: deps.places } : {}),
  });

  /** Agents that talk to each other until they reach a goal. Each member is a session handle. */
  const room = createRoom({ parallel: deps.parallel, log: deps.log, describe, watch, inRoom, ...(deps.onRoom ? { note: deps.onRoom } : {}) });

  const exec = (spec: ExecSpec, options: StepOptions, defaultLabel: string, where: string): Promise<unknown> => {
    const schema = schemaOf(options.schema, where);
    const fullSpec: ExecSpec = {
      ...spec,
      // Set only when given, so a step written before schemas keeps its hash.
      ...(schema === undefined ? {} : { schema }),
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

  /** Run a shell command. Returns { code, stdout, stderr }. `input` goes to stdin as JSON. With
   *  a schema, stdout is read as JSON, checked, and becomes `result`. */
  const sh = (command: string, options: StepOptions & { input?: unknown } = {}) => {
    if (typeof command !== "string" || !command.trim()) fail("sh(command) needs a command string");
    const { input, ...rest } = options;
    const json = inputOf(input, "sh()");
    return exec({ kind: "sh", command, ...(json === undefined ? {} : { input: json }) }, rest, shortLabel("sh", command), "sh()");
  };

  /** js and py take their input as the second argument, so an input option is a mistake. */
  const noInputOption = (options: StepOptions, name: string) => {
    if (options && typeof options === "object" && "input" in options) fail(`${name}() takes its input as its second argument, not as an option`);
  };

  /** Run JavaScript in Node. `input` is a variable in the code; a returned value is `result`. */
  const js = (source: string, input?: unknown, options: StepOptions = {}) => {
    if (typeof source !== "string") fail("js(source, input) needs the code as a string");
    noInputOption(options, "js");
    return exec({ kind: "js", source, input: plainCopy(input) }, options, options.label ? options.label : "js", "js()");
  };

  /** Run Python. `input` is a variable in the code; a returned value is `result`. */
  const py = (source: string, input?: unknown, options: StepOptions = {}) => {
    if (typeof source !== "string") fail("py(source, input) needs the code as a string");
    noInputOption(options, "py");
    return exec({ kind: "py", source, input: plainCopy(input) }, options, options.label ? options.label : "py", "py()");
  };

  /** Run a script file. It reads `input` as JSON on stdin and may write its result as JSON to $SOUS_RESULT. */
  const run = (file: string, options: StepOptions & { args?: string[]; input?: unknown } = {}) => {
    if (typeof file !== "string" || !file.trim()) fail("run(file) needs a file path");
    const { args, input, ...rest } = options;
    const json = inputOf(input, "run()");
    return exec({ kind: "file", file, ...(args ? { args: [...args] } : {}), input: json }, rest, shortLabel("run", file), "run()");
  };

  /** Check a command every few seconds, with no agent, until it exits 0. `input` goes to its
   *  stdin as JSON. With a schema, the value it prints when it exits 0 is checked. */
  const waitUntil = (command: string, options: StepOptions & { every?: number | string; input?: unknown } = {}) => {
    if (typeof command !== "string" || !command.trim()) fail("waitUntil(command) needs a command string");
    const everySeconds = parseDurationSeconds(options.every ?? 60) ?? 60;
    const timeoutSeconds = parseDurationSeconds(options.timeout);
    const { every: _every, timeout: _timeout, input, ...rest } = options;
    const json = inputOf(input, "waitUntil()");
    return exec(
      { kind: "wait", command, everySeconds, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }), ...(json === undefined ? {} : { input: json }) },
      rest,
      shortLabel("wait", command),
      "waitUntil()",
    );
  };

  /** Ask a question, marked with its purpose when it has one. With a schema, the answer is the
   *  value that fits it. */
  const asked = async (question: string, choices: string[] | undefined, purpose: CheckpointPurpose, schema?: Record<string, unknown>) => {
    const options = { ...(choices ? { kind: "select", choices } : { kind: "input" }), ...(schema ? { schema } : {}) };
    const reply = Object.keys(purpose).length ? await deps.markedCheckpoint(question, options, purpose) : await deps.checkpoint(question, options);
    if (schema) return reply;
    return typeof reply === "string" ? reply : reply === undefined || reply === null ? "" : JSON.stringify(reply);
  };

  /** Ask the user. With choices, the answer is one of them; without, free text. With answeredBy
   *  "anyone", an agent may answer too. `input` shows with the question. With a schema, the answer
   *  is read as JSON, an answer that does not fit is refused, and ask returns the value. */
  const ask = async (question: string, options: { choices?: string[]; answeredBy?: unknown; input?: unknown; schema?: unknown } = {}) => {
    if (typeof question !== "string" || !question.trim()) fail("ask(question) needs a question");
    // Each option is read once, so a getter can't give two answers.
    const { choices, answeredBy, input, schema } = options;
    const anyone = answeredByOf(answeredBy, "ask()") === "anyone";
    const json = inputOf(input, "ask()");
    const shape = schemaOf(schema, "ask()");
    const text = json === undefined ? question : `${question}\n\n${inputBlock(json)}`;
    return asked(text, choices ? [...choices] : undefined, anyone ? { answeredBy: "anyone" } : {}, shape);
  };

  /**
   * Stop for a person to check the run. They approve, stop the run, or send the step back
   * with a note. With a step function, the function runs, its result is shown, and a send
   * back runs it again with the note, until approved.
   */
  const breakpoint = async (
    title: string,
    stepOrOptions?: ((note?: string) => unknown) | { show?: unknown; input?: unknown; schema?: unknown },
    maybeOptions: { show?: (result: unknown) => unknown; max?: number; input?: unknown; schema?: unknown } = {},
  ): Promise<unknown> => {
    if (typeof title !== "string" || !title.trim()) fail("breakpoint(title) needs a title");
    const marked = (options: unknown) => typeof options === "object" && options !== null && (options as { answeredBy?: unknown }).answeredBy !== undefined;
    if (marked(stepOrOptions) || marked(maybeOptions)) fail("breakpoint() takes no answeredBy: a breakpoint is always for people");
    const structured = typeof stepOrOptions === "function" ? maybeOptions : (stepOrOptions ?? {});
    const json = inputOf(structured.input, "breakpoint()");
    const shape = schemaOf(structured.schema, "breakpoint()");
    // JSON.stringify gives undefined for a function or a symbol, which shows as its String.
    const render = (value: unknown) => (value === undefined ? "" : typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value)));
    // What the breakpoint shows: the shown value, then the input.
    const shownText = (shown: unknown): string | undefined => {
      if (json === undefined) return shown === undefined ? undefined : render(shown);
      return [...(shown === undefined ? [] : [render(shown)]), inputBlock(json)].join("\n\n");
    };
    const reply = shape ? "Reply approve, stop, or send back with a note, or approve with a JSON value that fits the schema." : "Reply approve, stop, or send back with a note.";
    const prompt = (shown: unknown) => {
      const text = shownText(shown);
      return `Breakpoint: ${title}\n${text === undefined ? "" : `\n${text}\n`}\n${reply}`;
    };
    const decide = async (shown: unknown) => {
      const show = (shownText(shown) ?? "").trim();
      const options = { kind: "input", ...(shape ? { schema: shape } : {}) };
      const decision = decisionOf(await deps.markedCheckpoint(prompt(shown), options, { breakpoint: true, title, ...(show ? { show } : {}) }));
      if (decision.decision === "stop") {
        throw new WorkflowError(`Stopped at breakpoint "${title}"${decision.note ? `: ${decision.note}` : ""}`, WorkflowErrorCode.WORKFLOW_ABORTED, {
          recoverable: false,
        });
      }
      return decision;
    };
    // With a schema, an approve may carry a value that fits it, and the breakpoint returns it.
    const approvedValue = (decision: Decision) => shape !== undefined && decision.decision === "approve" && "value" in decision;
    if (typeof stepOrOptions !== "function") {
      const decision = await decide(stepOrOptions?.show);
      return approvedValue(decision) ? decision.value : decision;
    }
    // No cap unless the script sets max.
    const max = maybeOptions.max;
    let note: string | undefined;
    for (let round = 1; ; round++) {
      const result = await stepOrOptions(note);
      const decision = await decide(maybeOptions.show ? maybeOptions.show(result) : result);
      if (decision.decision === "approve") return approvedValue(decision) ? decision.value : result;
      if (max !== undefined && round >= max) fail(`breakpoint "${title}" was sent back ${max} times`);
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

  const removed = Object.fromEntries(
    Object.entries(REMOVED_GLOBALS).map(([name, message]) => [name, (): never => fail(message)]),
  ) as Record<keyof typeof REMOVED_GLOBALS, () => never>;

  return { agent, session, room, sh, js, py, run, waitUntil, ask, breakpoint, choose, ...removed };
}

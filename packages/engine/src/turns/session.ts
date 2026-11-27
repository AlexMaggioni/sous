// Session handles. session() makes a handle and starts nothing. send() runs one turn on it, and
// each turn after the first goes on in the session the first one opened. agent() is one send on a
// session no later step uses.
//
// Each turn reaches the engine's agent() as a step with `session: { key, start }`. The key is the
// handle's label, and start is "fresh" on the first send and "kept" after. The engine keeps the
// map from key to the session, so a resume finds it again from the journal.

import { WorkflowError, WorkflowErrorCode } from "../errors.js";

type AgentFn = (prompt: string, options: Record<string, unknown>) => Promise<unknown>;

export interface SessionDeps {
  /** The engine's agent step. */
  agent: AgentFn;
  /** Per-run changes to steps, by label, such as { reviewer: { model: "claude/haiku" } }. */
  stepOverrides?: Record<string, Record<string, unknown>>;
  /** A step's folder, resolved as the engine resolves a step's cwd. */
  resolveCwd: (cwd: string | undefined) => string;
  /** Wraps a function the script calls, as the script's globals are wrapped. */
  track?: <F extends (...args: never[]) => unknown>(fn: F) => F;
}

/** What a handle holds for every turn. */
const SESSION_KEYS = ["label", "agentType", "model", "effort", "mode", "skills", "mcp", "mcpServers", "cwd"] as const;
/** What one turn may set. A model must stay on the handle's program. */
const SEND_KEYS = ["label", "schema", "until", "ask", "timeout", "retries", "images", "phase", "model"] as const;
const SESSION_KEY_SET = new Set<string>(SESSION_KEYS);
const SEND_KEY_SET = new Set<string>(SEND_KEYS);

/** A handle as the script sees it. Its label and folder are plain strings. */
export interface SessionHandle {
  readonly label: string;
  readonly cwd: string;
  send(prompt: string, options?: Record<string, unknown>): Promise<unknown>;
}

function fail(message: string): never {
  throw new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
}

function optionsOf(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${where} takes an options object`);
  return value as Record<string, unknown>;
}

/** The program a model spec names before its first "/", such as claude in "claude/haiku". */
const programOf = (model: unknown): string | undefined =>
  typeof model === "string" && model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;

/** Two models on one program. A model with no program named passes here: the engine checks it when it routes the turn. */
const sameProgram = (left: unknown, right: unknown): boolean => {
  const [a, b] = [programOf(left), programOf(right)];
  return a === undefined || b === undefined || a === b;
};

/** `ask` is accepted as a boolean and changes nothing yet. */
function checkAsk(options: Record<string, unknown>, where: string): void {
  if (options.ask !== undefined && typeof options.ask !== "boolean") fail(`${where}: ask is true or false`);
}

export function createSessions(deps: SessionDeps) {
  const labels = new Set<string>();
  const track = deps.track ?? (<F>(fn: F) => fn);

  /**
   * The model a --set change gives the steps of a session's label. It may change only the model,
   * and only to one on the session's program.
   */
  const changedModel = (label: string, sessionLabel: string, model: unknown): string | undefined => {
    const change = deps.stepOverrides?.[label];
    if (!change) return undefined;
    for (const key of Object.keys(change)) {
      if (key !== "model") fail(`--set ${label}.${key}: a turn of session "${sessionLabel}" may change only its model. Set ${key} in session() instead.`);
    }
    if (change.model === undefined) return undefined;
    if (typeof change.model !== "string") fail(`--set ${label}.model takes a model name`);
    if (!sameProgram(change.model, model)) {
      fail(`--set ${label}.model: ${change.model} is on another program than session "${sessionLabel}" (${String(model)}). A session stays on one program.`);
    }
    return change.model;
  };

  /** Makes a handle. Its label is unique among this workflow's handles. */
  const session = (given?: unknown): SessionHandle => {
    const options = optionsOf(given, "session()");
    if (options.place !== undefined) fail('session(): place is not built yet. For one step in a worktree, write agent(prompt, { place: "worktree" }).');
    for (const key of Object.keys(options)) {
      if (!SESSION_KEY_SET.has(key)) fail(`session(): ${key} is not a session option. A session takes ${SESSION_KEYS.join(", ")}. A turn's options go on send().`);
    }
    const label = typeof options.label === "string" ? options.label.trim() : "";
    if (!label) fail("session() needs a label");
    if (labels.has(label)) fail(`session(): the label "${label}" is in use by another session of this workflow`);
    if (options.cwd !== undefined && typeof options.cwd !== "string") fail(`session "${label}": cwd must be a string`);
    const held: Record<string, unknown> = {};
    for (const key of SESSION_KEYS) if (options[key] !== undefined && key !== "label") held[key] = options[key];
    const changed = changedModel(label, label, held.model);
    labels.add(label);
    const cwd = deps.resolveCwd(options.cwd as string | undefined);
    let turns = 0;
    let running = false;

    const send = async (prompt: string, sent?: unknown): Promise<unknown> => {
      if (running) fail(`session "${label}" runs one turn at a time. Wait for its send() to finish before the next.`);
      const options = optionsOf(sent, `session "${label}": send()`);
      for (const key of Object.keys(options)) {
        if (key === "session") fail(`session "${label}": send() takes no session option`);
        if (!SEND_KEY_SET.has(key) && SESSION_KEY_SET.has(key)) fail(`session "${label}": ${key} belongs to the session. Set it in session().`);
      }
      checkAsk(options, `session "${label}": send()`);
      if (options.model !== undefined && !sameProgram(options.model, held.model)) {
        fail(`session "${label}": send() asks for ${String(options.model)}, which is on another program than the session's ${String(held.model)}`);
      }
      const { ask: _ask, ...turn } = options;
      const stepLabel = typeof turn.label === "string" && turn.label.trim() ? turn.label : label;
      const model = (stepLabel === label ? undefined : changedModel(stepLabel, label, held.model)) ?? changed ?? turn.model ?? held.model;
      const step = {
        ...held,
        ...turn,
        label: stepLabel,
        ...(model === undefined ? {} : { model }),
        session: { key: label, start: turns === 0 ? "fresh" : "kept" },
      };
      running = true;
      turns++;
      try {
        return await deps.agent(prompt, step);
      } finally {
        running = false;
      }
    };

    return Object.freeze({ label, cwd, send: track(send) });
  };

  /** One send on a session no later step uses. It takes a session's options and a turn's. */
  const agent = async (prompt: string, given?: unknown): Promise<unknown> => {
    const options = optionsOf(given, "agent()");
    if (options.session !== undefined) fail("agent() takes no session option. Make a session with session() and send() each turn on it.");
    checkAsk(options, "agent()");
    if (options.place !== undefined && options.place !== "worktree") fail('agent(): place is "worktree"');
    const { ask: _ask, place, ...rest } = options;
    const label = typeof rest.label === "string" ? rest.label : undefined;
    const change = label ? deps.stepOverrides?.[label] : undefined;
    const step: Record<string, unknown> = change ? { ...rest, ...change } : rest;
    return deps.agent(prompt, place === undefined ? step : { ...step, session: { start: "fresh", place } });
  };

  return { session, agent };
}

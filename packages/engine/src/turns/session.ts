// Session handles. session() makes a handle and starts nothing. send() runs one step on it, and
// each turn after the first goes on in the session the first one opened. agent() is one send on a
// session no later step uses.
//
// Each turn reaches the engine's agent() as a step with `session: { key, start }`. The key is the
// handle's label, and start is "fresh" on the first send and "kept" after. The engine keeps the
// map from key to the session, so a resume finds it again from the journal.
//
// A step runs until its agent says "done", unless it sets `until: "turn"`. turns/loop.ts sends its
// turns. agent() gets a key no script can name, so its later turns go on in its own session.

import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import { LOOP_KEYS, checkLoopOptions, runUntilDone, type Check, type LoopDeps } from "./loop.js";
import type { StepUntil, Until } from "./until.js";

type AgentFn = (prompt: string, options: Record<string, unknown>) => Promise<unknown>;

export interface SessionDeps {
  /** The engine's agent step. */
  agent: AgentFn;
  /** Runs a check command as a code step that may fail, and gives { code, stdout, stderr }. */
  command: LoopDeps["command"];
  /** Waits on a join row with an agent's question, for the session or step `label`. */
  join: (message: string, label: string) => Promise<unknown>;
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
const SEND_KEYS = ["label", "schema", "until", "check", "maxTurns", "maxRepairs", "ask", "timeout", "retries", "images", "phase", "model"] as const;
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

/** A step's options without the ones the loop reads, which never reach the engine. */
function engineOptions(options: Record<string, unknown>): Record<string, unknown> {
  const { ask: _ask, until: _until, ...rest } = options;
  for (const key of LOOP_KEYS) delete rest[key];
  return rest;
}

export function createSessions(deps: SessionDeps) {
  const labels = new Set<string>();
  const track = deps.track ?? (<F>(fn: F) => fn);
  let agents = 0;

  /**
   * Runs one step: its one turn with `until: "turn"`, else the loop's turns until "done". `turn`
   * sends one turn with the until the engine reads. `joinLabel` names the session a question
   * waits on. A check command runs in `cwd`.
   */
  const runStep = (prompt: string, options: Record<string, unknown>, label: string, joinLabel: string, cwd: unknown, turn: (prompt: string, until: Until) => Promise<unknown>) => {
    const maxTurns = options.maxTurns as number | undefined;
    const maxRepairs = options.maxRepairs as number | undefined;
    if (options.until === "turn") {
      if (options.check !== undefined) fail(`step "${label}": check runs when the agent says done. A step with until "turn" has no check.`);
      const limits: StepUntil = { end: "turn", ...(maxRepairs === undefined ? {} : { maxRepairs }), ...(maxTurns === undefined ? {} : { maxTurns, turnsLeft: maxTurns }) };
      return turn(prompt, Object.keys(limits).length > 1 ? limits : "turn");
    }
    return runUntilDone(
      prompt,
      {
        label,
        ...(options.check === undefined ? {} : { check: options.check as Check }),
        ...(maxTurns === undefined ? {} : { maxTurns }),
        ...(maxRepairs === undefined ? {} : { maxRepairs }),
        ...(options.ask === undefined ? {} : { ask: options.ask as boolean }),
        ...(typeof cwd === "string" ? { cwd } : {}),
        ...(typeof options.phase === "string" ? { phase: options.phase } : {}),
      },
      { send: turn, command: deps.command, join: (message) => deps.join(message, joinLabel) },
    );
  };

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
      checkLoopOptions(options, `session "${label}": send()`);
      if (options.model !== undefined && !sameProgram(options.model, held.model)) {
        fail(`session "${label}": send() asks for ${String(options.model)}, which is on another program than the session's ${String(held.model)}`);
      }
      const turn = engineOptions(options);
      const stepLabel = typeof turn.label === "string" && turn.label.trim() ? turn.label : label;
      const model = (stepLabel === label ? undefined : changedModel(stepLabel, label, held.model)) ?? changed ?? turn.model ?? held.model;
      const step = { ...held, ...turn, label: stepLabel, ...(model === undefined ? {} : { model }) };
      running = true;
      try {
        return await runStep(prompt, options, stepLabel, label, held.cwd, (text, until) => {
          const start = turns === 0 ? "fresh" : "kept";
          turns++;
          return deps.agent(text, { ...step, until, session: { key: label, start } });
        });
      } finally {
        running = false;
      }
    };

    return Object.freeze({ label, cwd, send: track(send) });
  };

  /** One send on a session no later step uses. It takes a session's options and a turn's. */
  const agent = async (prompt: string, given?: unknown): Promise<unknown> => {
    const written = optionsOf(given, "agent()");
    if (written.session !== undefined) fail("agent() takes no session option. Make a session with session() and send() each turn on it.");
    const label = typeof written.label === "string" ? written.label : undefined;
    const change = label ? deps.stepOverrides?.[label] : undefined;
    const options: Record<string, unknown> = change ? { ...written, ...change } : written;
    checkLoopOptions(options, "agent()");
    const { place, ...rest } = options;
    if (place !== undefined && place !== "worktree") fail('agent(): place is "worktree"');
    const step = engineOptions(rest);
    const name = label ?? "agent";
    if (place !== undefined) {
      // A worktree step runs in a worktree of its own that goes when its call ends, so it has no
      // session a second turn could go on in. Sessions take places in a later phase.
      if (options.check !== undefined) fail(`agent(): a step with place "worktree" takes no check yet. Run the check in the script after it.`);
      let sent = 0;
      return runStep(prompt, options, name, name, rest.cwd, (text, until) => {
        if (sent++ > 0) {
          fail(`step "${name}" has place "worktree" and needs another turn, which only a session can run. Give it until: "turn", or run it without place.`);
        }
        return deps.agent(text, { ...step, until, session: { start: "fresh", place } });
      });
    }
    // A key no script can name: a session label is trimmed, and this one starts with a space.
    const key = options.until === "turn" ? undefined : ` agent ${++agents}`;
    let turns = 0;
    return runStep(prompt, options, name, name, rest.cwd, (text, until) => {
      const start = turns++ === 0 ? "fresh" : "kept";
      return deps.agent(text, key === undefined ? { ...step, until } : { ...step, until, session: { key, start } });
    });
  };

  return { session, agent };
}

// Session handles. session() makes a handle and starts nothing. send() runs one step on it, and
// each turn after the first goes on in the session the first one opened. agent() is one send on a
// session no later step uses.
//
// Each turn reaches the engine's agent() as a step with `session: { key, start }`. The key is the
// handle's label, and start is "fresh" on the first send and "kept" after. The engine keeps the
// map from key to the session, so a resume finds it again from the journal. A step in a worktree
// adds the worktree's folder to it, and its cwd is read under that folder.
//
// fork() makes a handle whose session starts as a copy of its parent's, as the parent's last
// finished turn left it. deps.fork copies the parent's entry in the engine's map at the fork()
// call, and the fork's first send has start "fork". Nothing the fork does reaches the parent.
//
// A step runs until its agent says "done", unless it sets `until: "turn"`. turns/loop.ts sends its
// turns. agent() gets a key no script can name, so its later turns go on in its own session.
// When a keyed step ends, deps.end closes the program its turns kept open. A step with
// `until: "turn"` sends one turn more, "Continue the task.", after a turn the person stepped into
// or the agent ended with a question, as the loop does, so its value is the agent's answer.
//
// A room watches its members' handles. watch() tells it when a member's turn waits for the person:
// the agent asked, the person stepped into the turn, or the turn waits because the person holds
// the session. The room then goes on without that member until its turn ends.
//
// A handle with place "worktree" gets its worktree when session() is called, and the workflow
// that made it closes it when it returns. agent() with place "worktree" gets one for its step,
// which closes when the step ends. A run that stops or pauses keeps both, for a resume. A fork
// works in its parent's folder, or with place "worktree" in a worktree of its own, made from the
// last commit of its parent's folder.

import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import type { RoomTag } from "../run-events.js";
import type { Worktree } from "../places/places.js";
import { LOOP_KEYS, checkLoopOptions, runUntilDone, type Check, type LoopDeps } from "./loop.js";
import { CONTINUE_PROMPT, readStatus } from "./status.js";
import type { StepUntil, Until } from "./until.js";

type AgentFn = (prompt: string, options: Record<string, unknown>) => Promise<unknown>;

/** What names one agent() step's worktree: its prompt, and its count among the calls with the same
 *  label and prompt, which stays the same on a resume whatever order the calls come in. */
export interface StepPlace {
  prompt: string;
  occurrence: number;
}

/** The worktrees of the sessions and steps with place "worktree". The engine gives one per workflow. */
export interface SessionPlaces {
  /**
   * Makes or finds the worktree of the session `label`, or of one agent() step when `step` gives
   * its prompt and how many calls before it had the same label and prompt. It starts from the
   * workflow's folder, or from the last commit of `from`, a fork's parent's folder. Undefined when
   * there can be none, after the log says why.
   */
  open(label: string, step?: StepPlace, from?: string): Worktree | undefined;
  /** Ends a step's worktree: commits the work left in it, removes the folder and keeps a branch that moved. */
  close(tree: Worktree, label: string): void;
  /** True while the run stops or pauses. A worktree stays then, for a resume. */
  halting(): boolean;
  /** The place the agent `agentType` names in its definition. */
  placeOf(agentType: string | undefined): "worktree" | undefined;
}

export interface SessionDeps {
  /** The engine's agent step. */
  agent: AgentFn;
  /** Runs a check command as a code step that may fail, and gives { code, stdout, stderr }. */
  command: LoopDeps["command"];
  /** Waits on a join row with an agent's question, for the session or step `label`. */
  join: (message: string, label: string) => Promise<unknown>;
  /** The label the engine gave the last turn in the session `key`, as the run's log names the step. */
  labelOf?: (key: string) => string | undefined;
  /** Per-run changes to steps, by label, such as { reviewer: { model: "claude/haiku" } }. */
  stepOverrides?: Record<string, Record<string, unknown>>;
  /** A step's folder, resolved as the engine resolves a step's cwd. */
  resolveCwd: (cwd: string | undefined) => string;
  /** Closes the program the turns of a step in the session `key` kept open. */
  end?: (key: string) => Promise<void>;
  /**
   * Starts the session `key` as a copy of the session `from` as its last finished turn left it.
   * False when `from` has no session yet. Without it, fork() fails.
   */
  fork?: (from: string, key: string) => boolean;
  /** Wraps a function the script calls, as the script's globals are wrapped. */
  track?: <F extends (...args: never[]) => unknown>(fn: F) => F;
  /** Where steps with place "worktree" work. Without it, they work in the workflow's folder. */
  places?: SessionPlaces;
}

/** What a handle holds for every turn. */
const SESSION_KEYS = ["label", "agentType", "model", "effort", "mode", "skills", "mcp", "mcpServers", "cwd", "place"] as const;
/** What one turn may set. A model must stay on the handle's program. */
const SEND_KEYS = ["label", "schema", "until", "check", "maxTurns", "maxRepairs", "ask", "timeout", "retries", "images", "phase", "model"] as const;
const SESSION_KEY_SET = new Set<string>(SESSION_KEYS);
const SEND_KEY_SET = new Set<string>(SEND_KEYS);

/** A handle as the script sees it. Its label, folder and branch are plain strings. */
export interface SessionHandle {
  readonly label: string;
  readonly cwd: string;
  /** The branch of the handle's worktree, when it has one. */
  readonly branch?: string;
  send(prompt: string, options?: Record<string, unknown>): Promise<unknown>;
  /** A new handle whose session starts as a copy of this one's. It takes session options. */
  fork(options?: Record<string, unknown>): SessionHandle;
}

/** What a handle holds: its options for every turn, its place, and the model a --set gives it. */
interface HandleState {
  label: string;
  held: Record<string, unknown>;
  /** The cwd the handle was given, as written. */
  cwdOption: unknown;
  tree?: Worktree;
  /** The handle's folder: its cwd under its worktree, else resolved as a step's. */
  cwd: string;
  placed: { place?: "worktree"; worktree?: string };
  changed?: string;
  /** The start of the handle's first turn: "fresh", or "fork" for a fork. */
  first: "fresh" | "fork";
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

/** The place a step asked for, else the one its agent's definition names. */
function placeOf(options: Record<string, unknown>, where: string, places: SessionPlaces | undefined): "worktree" | undefined {
  if (options.place !== undefined && options.place !== "worktree") fail(`${where}: place is "worktree"`);
  return (options.place as "worktree" | undefined) ?? places?.placeOf(typeof options.agentType === "string" ? options.agentType : undefined);
}

/** What a step's session says of its place: the place it asked for, and its worktree's folder when sous made one. */
function placeFields(place: "worktree" | undefined, tree: Worktree | undefined): { place?: "worktree"; worktree?: string } {
  if (place === undefined) return {};
  return tree ? { place, worktree: tree.dir } : { place };
}

/** A step's folder in its worktree: its cwd under the worktree's folder. */
const cwdIn = (tree: Worktree, cwd: unknown): string => resolve(tree.dir, typeof cwd === "string" ? cwd : ".");

/**
 * A one-turn step's value when the turn did not finish: the steps module's row for a turn the
 * person stepped into ("working"), or for a question the agent asked. Both have exactly the keys
 * status, result and message, with result null. A schema whose own answers look like this would
 * read as one too, so such a step should run until done.
 */
function unfinished(value: unknown): { status: "working" | "question"; message: string | null } | undefined {
  const status = readStatus(value);
  if (!status || (status.status !== "working" && status.status !== "question") || status.result !== null) return undefined;
  const keys = Object.keys(value as object).sort().join(",");
  return keys === "message,result,status" ? { status: status.status, message: status.message ?? null } : undefined;
}

/** A step's options without the ones the loop reads, which never reach the engine. */
function engineOptions(options: Record<string, unknown>): Record<string, unknown> {
  const { ask: _ask, until: _until, ...rest } = options;
  for (const key of LOOP_KEYS) delete rest[key];
  return rest;
}

/** What a room reads of a handle: its label and the model its turns run on. */
export interface HandleInfo {
  label: string;
  model?: string;
}

export function createSessions(deps: SessionDeps) {
  const labels = new Set<string>();
  /** The labels of this workflow's agent() steps. A handle may not share one, so sous join, which
   *  takes either, never has to guess which session a name means. */
  const stepLabels = new Set<string>();
  /** The handles of this workflow, for describe(). */
  const handles = new WeakMap<object, HandleInfo>();
  /** What watches each session key, for watch(). */
  const watchers = new Map<string, Set<() => void>>();
  /** Tells the watchers of the session `key` that its turn waits for the person. */
  const away = (key: string) => {
    for (const watcher of [...(watchers.get(key) ?? [])]) watcher();
  };
  /** The room whose turn a send runs in, so the step records it. */
  const roomTurn = new AsyncLocalStorage<RoomTag>();
  const track = deps.track ?? (<F>(fn: F) => fn);
  let agents = 0;
  /** How many agent() calls with place "worktree" each label and prompt had. */
  const occurrences = new Map<string, number>();

  /**
   * Runs one step: its one turn with `until: "turn"`, else the loop's turns until "done". `turn`
   * sends one turn with the until the engine reads. `joinLabel` names the session a question
   * waits on, or gives that name once a turn has run. A check command runs in `cwd`. `key` is the session the turns go on in, whose
   * program closes when the step ends.
   */
  const runStep = async (prompt: string, options: Record<string, unknown>, label: string, joinLabel: string | (() => string), cwd: unknown, key: string | undefined, turn: (prompt: string, until: Until) => Promise<unknown>) => {
    const end = key === undefined || !deps.end ? undefined : () => deps.end!(key);
    const asker = () => (typeof joinLabel === "string" ? joinLabel : joinLabel());
    const maxTurns = options.maxTurns as number | undefined;
    const maxRepairs = options.maxRepairs as number | undefined;
    if (options.until === "turn") {
      if (options.check !== undefined) fail(`step "${label}": check runs when the agent says done. A step with until "turn" has no check.`);
      const limits: StepUntil = { end: "turn", ...(options.ask === false ? { ask: false } : {}), ...(maxRepairs === undefined ? {} : { maxRepairs }), ...(maxTurns === undefined ? {} : { maxTurns, turnsLeft: maxTurns }) };
      const until = Object.keys(limits).length > 1 ? limits : "turn";
      try {
        let value = await turn(prompt, until);
        for (let stopped = unfinished(value); stopped; stopped = unfinished(value)) {
          if (key !== undefined) away(key);
          if (stopped.status === "question") {
            await end?.();
            await deps.join(stopped.message ?? "The agent has a question.", asker());
          }
          value = await turn(CONTINUE_PROMPT, until);
        }
        return value;
      } finally {
        await end?.();
      }
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
      { send: turn, command: deps.command, join: (message) => deps.join(message, asker()), ...(end ? { end } : {}) },
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

  /** Checks a handle's options: only session options, and a label no handle of this workflow has. */
  const checkHandle = (options: Record<string, unknown>, where: string): string => {
    for (const key of Object.keys(options)) {
      if (!SESSION_KEY_SET.has(key)) fail(`${where}: ${key} is not a session option. A session takes ${SESSION_KEYS.join(", ")}. A turn's options go on send().`);
    }
    const label = typeof options.label === "string" ? options.label.trim() : "";
    if (!label) fail(`${where} needs a label`);
    if (labels.has(label)) fail(`${where}: the label "${label}" is in use by another session of this workflow`);
    if (stepLabels.has(label)) fail(`${where}: the label "${label}" is in use by an agent() step of this workflow, so sous join could not tell them apart`);
    if (options.cwd !== undefined && typeof options.cwd !== "string") fail(`session "${label}": cwd must be a string`);
    return label;
  };

  /** The options a handle holds for every turn: its session options without its label and place. */
  const heldOf = (options: Record<string, unknown>): Record<string, unknown> => {
    const held: Record<string, unknown> = {};
    for (const key of SESSION_KEYS) if (options[key] !== undefined && key !== "label" && key !== "place") held[key] = options[key];
    return held;
  };

  /** Makes a handle. Its label is unique among this workflow's handles. */
  const session = (given?: unknown): SessionHandle => {
    const options = optionsOf(given, "session()");
    const label = checkHandle(options, "session()");
    const place = placeOf(options, `session "${label}"`, deps.places);
    const held = heldOf(options);
    const changed = changedModel(label, label, held.model);
    labels.add(label);
    const tree = place === undefined ? undefined : deps.places?.open(label);
    const cwd = tree ? cwdIn(tree, options.cwd) : deps.resolveCwd(options.cwd as string | undefined);
    return handle({ label, held, cwdOption: options.cwd, ...(tree ? { tree } : {}), cwd, placed: placeFields(place, tree), ...(changed ? { changed } : {}), first: "fresh" });
  };

  /** A handle on its state. Its first send starts the session, fresh or as a fork. */
  const handle = (state: HandleState): SessionHandle => {
    const { label, held, tree, cwd, placed, changed } = state;
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
        return await runStep(prompt, options, stepLabel, label, tree ? cwd : held.cwd, label, (text, until) => {
          const start = turns === 0 ? state.first : "kept";
          turns++;
          const room = roomTurn.getStore();
          return deps.agent(text, { ...step, until, session: { key: label, start, ...placed, waits: () => away(label), ...(room === undefined ? {} : { room }) } });
        });
      } finally {
        running = false;
      }
    };

    /**
     * A handle whose session starts as a copy of this one's. Its options are a session's, over
     * this handle's. Without its own place or cwd it works in this handle's folder. Its label is
     * new, and its model stays on this handle's program.
     */
    const fork = (given?: unknown): SessionHandle => {
      const where = `session "${label}": fork()`;
      const options = optionsOf(given, where);
      const forkLabel = checkHandle(options, where);
      if (options.model !== undefined && !sameProgram(options.model, held.model)) {
        fail(`${where} asks for ${String(options.model)}, which is on another program than the session's ${String(held.model)}. A fork stays on its parent's program.`);
      }
      if (running) fail(`${where}: the session runs a turn. Fork it once its send() finishes, so the fork starts from a finished turn.`);
      const place = placeOf(options, `session "${forkLabel}"`, deps.places);
      const forkHeld = { ...held, ...heldOf(options) };
      const forkChanged = changedModel(forkLabel, forkLabel, forkHeld.model);
      if (!deps.fork || turns === 0 || !deps.fork(label, forkLabel)) fail(`${where}: the session has no finished turn yet, so there is nothing to fork`);
      labels.add(forkLabel);
      // With place "worktree", a worktree of its own from the parent's folder. Else the parent's
      // folder, with the fork's own cwd under it when it gives one.
      const ownTree = place === undefined ? undefined : deps.places?.open(forkLabel, undefined, tree?.dir ?? cwd);
      const forkTree = place === undefined ? tree : ownTree;
      const cwdOption = options.cwd ?? state.cwdOption;
      const forkCwd = forkTree ? cwdIn(forkTree, cwdOption) : options.cwd === undefined ? cwd : deps.resolveCwd(options.cwd as string);
      const forkPlaced = place === undefined ? placed : placeFields(place, ownTree);
      return handle({ label: forkLabel, held: forkHeld, cwdOption, ...(forkTree ? { tree: forkTree } : {}), cwd: forkCwd, placed: forkPlaced, ...(forkChanged ? { changed: forkChanged } : {}), first: "fork" });
    };

    const made = Object.freeze({ label, cwd, ...(tree ? { branch: tree.branch } : {}), send: track(send), fork: track(fork) });
    const model = changed ?? held.model;
    handles.set(made, { label, ...(typeof model === "string" ? { model } : {}) });
    return made;
  };

  /** One send on a session no later step uses. It takes a session's options and a turn's. */
  const agent = async (prompt: string, given?: unknown): Promise<unknown> => {
    const written = optionsOf(given, "agent()");
    if (written.session !== undefined) fail("agent() takes no session option. Make a session with session() and send() each turn on it.");
    const label = typeof written.label === "string" ? written.label : undefined;
    if (label !== undefined && labels.has(label.trim())) {
      fail(`agent(): the label "${label}" is in use by a session of this workflow, so sous join could not tell them apart. Give the step another label.`);
    }
    if (label !== undefined) stepLabels.add(label.trim());
    const change = label ? deps.stepOverrides?.[label] : undefined;
    // The label names the step in sous log and sous join, so --set may not change it.
    if (change?.label !== undefined) fail(`--set ${label}.label: a step's label cannot be changed. Change it in the workflow.`);
    const options: Record<string, unknown> = change ? { ...written, ...change } : written;
    checkLoopOptions(options, "agent()");
    const place = placeOf(options, "agent()", deps.places);
    const { place: _place, ...rest } = options;
    const step = engineOptions(rest);
    const name = label ?? "agent";
    let tree: Worktree | undefined;
    if (place !== undefined) {
      const same = `${name}\n${prompt}`;
      const occurrence = (occurrences.get(same) ?? 0) + 1;
      occurrences.set(same, occurrence);
      tree = deps.places?.open(name, { prompt, occurrence });
    }
    const placed = placeFields(place, tree);
    // A key no script can name: a session label is trimmed, and this one starts with a space. A
    // one-turn step has one too, for the turn after a person steps in.
    const key = ` agent ${++agents}`;
    let turns = 0;
    try {
      // An unlabeled step asks as the log names it, such as "agent 3", which the engine picks.
      const asker = label ?? (() => deps.labelOf?.(key) ?? name);
      return await runStep(prompt, options, name, asker, tree ? cwdIn(tree, rest.cwd) : rest.cwd, key, (text, until) => {
        const start = turns++ === 0 ? "fresh" : "kept";
        return deps.agent(text, { ...step, until, session: { key, start, ...(options.until === "turn" ? { once: true } : {}), ...placed } });
      });
    } finally {
      // The step's worktree ends with the step, unless the run stops or pauses.
      if (tree && !deps.places!.halting()) deps.places!.close(tree, name);
    }
  };

  /** The label and model of a handle this workflow made, else undefined. */
  const describe = (value: unknown): HandleInfo | undefined =>
    value !== null && typeof value === "object" ? handles.get(value) : undefined;

  /** Calls `fn` each time a turn of the session `label` waits for the person. Gives the call that stops it. */
  const watch = (label: string, fn: () => void): (() => void) => {
    const set = watchers.get(label) ?? new Set();
    watchers.set(label, set);
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) watchers.delete(label);
    };
  };

  /** Runs `fn` as a turn of the room `tag`: each step its sends start records the room. */
  const inRoom = <T>(tag: RoomTag, fn: () => T): T => roomTurn.run(tag, fn);

  return { session, agent, describe, watch, inRoom };
}

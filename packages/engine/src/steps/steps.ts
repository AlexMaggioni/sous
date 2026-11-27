// The steps module. It turns a workflow's agent call into one step on Claude Code or Codex.
// It routes the step with routeStep, finds the program once per run, names the MCP servers, takes
// a slot, sets the time limit and runs the step. The prompt goes as written. A slash prompt runs
// with no schema, and a step with a schema then sends a report turn for its value. A schema answer
// that does not fit gets repair turns in the same session. Code steps never come here: the engine
// runs them.
// A test or the dry run gives `inner`, a runner of its own, and then no program starts.

import type { TSchema } from "typebox";
import {
  createHarness,
  type Failure,
  type FindOptions,
  type Found,
  type Harness as Adapter,
  type HarnessFailure,
  type HarnessId,
  type HistoryEntry,
  type Step,
  type StepEvents,
  type StepResult,
  type Usage,
  type Account,
} from "@sous-run/harnesses";
import type { AgentHistoryEntry } from "./agent-history.js";
import { activityStep, type ActivityEntry, type ActivityStep, type OnActivity } from "./activity.js";
import type { LiveCall, SteeringBoard } from "./steering.js";
import type { AgentResultProvenance, AgentUsage, ContinuationAttempt, PlannedRequest, StepRequest } from "./agent-run.js";
import type { AgentRunner, StepAsk, StepRoute } from "./agent-runner.js";
import type { AgentSessionRef } from "../workflow-result.js";
import type { McpServerConfig } from "./mcp-config.js";
import { harnessName, missingServer, routeStep, stepModel, withHarness, type AgentLookup, type McpLookup, type RoutePlan } from "../agents.js";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import { hostStopError, type HostPause } from "../host-pause.js";
import type { SlotPool } from "../runs/slots.js";
import { checkImages, CONTINUATION_INSTRUCTION, extractValidated, isSlash, REPORT_PROMPT, REPROMPT_TEXT, toMcpServer, validateValue, withNote } from "./answer.js";

/** The runner a test or the dry run gives instead of the programs. It gets the planned step. */
export interface InnerRunner {
  run(prompt: string, request: PlannedRequest): Promise<unknown>;
  dispose?: () => Promise<void> | void;
}

export interface StepsOptions {
  /** The run's folder, for steps that don't name one. */
  cwd: string;
  inner?: InnerRunner;
  /** The agent cap. A dry run passes none. */
  slots?: SlotPool;
  /** The agents a step can name with `agentType`. */
  agents?: AgentLookup;
  /** The MCP servers a step can list with `mcp: [...]`. */
  mcp?: McpLookup;
  /** The account each harness's steps run as. None keeps the caller's login. */
  accounts?: Partial<Record<HarnessId, Account>>;
  /** Where to look for each program. With `inner` and no `programs`, no lookup runs. */
  programs?: (harness: HarnessId) => FindOptions;
  onSlot?: (event: { label?: string; state: "waiting" | "running" }) => void;
  /** Called once per program, before the first step that runs on it. */
  onProgram?: (found: { program: HarnessId; name: string; path: string; version?: string }) => void;
  /** Called when a step hits its program's usage limit, before the run pauses. */
  onLimit?: (event: { program: HarnessId; label?: string }) => void;
  /** Called once per step with what its program could not do as asked, such as a mode it lacks. */
  onNotes?: (event: { label?: string; notes: string[] }) => void;
  /** Called with the step's prompt, then with each thing its program does, as it happens. */
  onActivity?: OnActivity;
  /** The board each agent call opens on while its turn runs, so `sous tell` reaches it. */
  steering?: SteeringBoard;
  /** Asked before each agent step starts. A stop, such as the run's budget reached, makes the
   *  step throw AGENT_CANCELLED with the stop's pauseReason, and the run pauses on it. */
  gate?: () => HostPause | undefined;
  /** Called while an attempt of a step on a program runs, with the tokens it spent so far, and
   *  once more with `ended` when the attempt ends, failed or not. The program says when: Claude
   *  Code at each message, Codex at each token count it sends. A runner in place of the programs
   *  reports through the call's onUsage, and its tokens come only with `ended`. */
  onUsage?: (step: ActivityStep, usage: AgentUsage, ended?: boolean) => void;
  /** A note from `sous resume --note`. It goes to the first agent call that runs, or to the first
   *  with the label `step`, in one of the runs or nested runs `scopes` when given. */
  note?: StepsNote;
}

/** A note a resume gives one agent call. `step` is a label, and `scopes` the runs or nested runs
 *  its calls may run in. `taken` is called when a call takes it. */
export interface StepsNote {
  text: string;
  step?: string;
  scopes?: string[];
  taken?: () => void;
}


/** Repair turns for a schema answer that does not fit. */
const REPAIRS = 2;

const isFailure = (error: unknown): error is HarnessFailure => error instanceof Error && "failure" in error;
const failureOf = (error: unknown): Failure | undefined => (isFailure(error) ? error.failure : undefined);

/** The tokens of two turns. Cost is counted apart, since a resumed reading includes the turns before it. */
function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, total: a.total + b.total };
}

const NO_USAGE: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
const agentUsage = (spent: Usage, cost: number): AgentUsage => ({ input: spent.input, output: spent.output, cacheRead: spent.cacheRead, cacheWrite: spent.cacheWrite, total: spent.total, cost });

/** The activity entry of a history item. A turn's own prompt is left out: the steps module
 *  reports the prompt itself, and a repair turn is its own text. A user message after it is a tell. */
const ACTIVITY_KINDS: Record<HistoryEntry["kind"], ActivityEntry["kind"]> = { text: "text", toolCall: "tool", toolResult: "tool-result", error: "error" };

/**
 * Which call gets the note: the first that asks and fits its step and scope. The call keeps it,
 * so its retries get it too. A call with no run or call index gets it only when it asks first.
 */
function noteTaker(note: StepsNote | undefined): (call: StepRequest) => string | undefined {
  let taker: string | undefined;
  let taken = false;
  return (call) => {
    if (!note) return undefined;
    const key = call.runId !== undefined && call.callIndex !== undefined ? `${call.runId}#${call.callIndex}` : undefined;
    if (taken) return key !== undefined && key === taker ? note.text : undefined;
    if (note.step !== undefined && call.label !== note.step) return undefined;
    if (note.scopes !== undefined && (call.runId === undefined || !note.scopes.includes(call.runId))) return undefined;
    taken = true;
    taker = key;
    note.taken?.();
    return note.text;
  };
}

const toHistory = (entry: HistoryEntry): AgentHistoryEntry => ({
  role: entry.role,
  kind: entry.kind,
  text: entry.text,
  ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
  ...(entry.isError === undefined ? {} : { isError: entry.isError }),
  timestamp: entry.at,
});

export function createSteps(options: StepsOptions): AgentRunner & { route(ask: StepAsk): StepRoute; dispose(): Promise<void> } {
  const lookup = options.programs ?? (options.inner ? undefined : () => ({}));
  const programs = new Map<HarnessId, Promise<Adapter | { problem: string }>>();
  const noteFor = noteTaker(options.note);

  /** Find the harness's program and check its version, once per run. */
  async function prepare(harness: HarnessId, where: FindOptions): Promise<Adapter | { problem: string }> {
    const finder = createHarness(harness, where);
    const found: Found = finder.find();
    if ("problem" in found) return { problem: found.problem };
    const { version, problem } = await finder.version(found.path);
    options.onProgram?.({ program: harness, name: harnessName(harness), path: found.path, ...(version ? { version } : {}) });
    if (problem) return { problem };
    // Every later step runs on this same file.
    return createHarness(harness, { path: found.path, env: {}, usualDirs: [] });
  }

  function programFor(harness: HarnessId): Promise<Adapter | { problem: string }> | undefined {
    if (!lookup) return undefined;
    let pending = programs.get(harness);
    if (!pending) programs.set(harness, (pending = prepare(harness, lookup(harness))));
    return pending;
  }

  const run = async (prompt: string, call: StepRequest): Promise<unknown> => {
    const stop = (message: string) =>
      new WorkflowError(`step "${call.label ?? "agent"}": ${message}`, WorkflowErrorCode.INVALID_ARGUMENT, { recoverable: false, agentLabel: call.label });
    // The route comes from route() below, which the engine calls before it hashes the step.
    const { problem, plan: step } = call.route;
    if (problem) throw stop(problem);
    if (!step) throw stop("the step has no plan. The engine routes each step with route() before it runs it.");
    // A session stays on one program. A kept turn routed to another fails before any program runs.
    const keptOn = call.continueWithPrompt ? call.continueFromSession : undefined;
    const keptHarness = keptOn && (keptOn.backendId !== step.harness ? keptOn.backendId : keptOn.poolKey ?? keptOn.backendId);
    if (keptOn && keptHarness !== step.harness) {
      throw stop(`the session runs on ${keptHarness}, and this turn asks for ${step.harness}. A session stays on one program.`);
    }
    const limit = options.gate?.();
    if (limit) throw hostStopError(limit, call.label);
    const where = options.onActivity && activityStep(call.runId, call.callIndex, call.label);
    const report = where && ((entry: ActivityEntry) => options.onActivity!(where, entry));
    report?.({ kind: "prompt", text: prompt });

    const program = await programFor(step.harness);
    if (program && "problem" in program) throw stop(program.problem);

    const servers: McpServerConfig[] = [...(call.mcpServers ?? [])];
    for (const name of step.mcp ?? []) {
      const found = options.mcp?.find(name, step.harness);
      if (!found) throw stop(options.mcp ? missingServer(name, step.harness, options.mcp) : `no MCP server "${name}". Add it to .rulesync/mcp.jsonc.`);
      if (!servers.some((existing) => existing.name === found.server.name)) servers.push(found.server);
    }

    let release: (() => void) | undefined;
    if (options.slots) {
      options.onSlot?.({ label: call.label, state: "waiting" });
      release = await options.slots.acquire({ runId: call.runId, label: call.label }, call.signal);
      options.onSlot?.({ label: call.label, state: "running" });
    }
    // The note goes to the first call that holds a slot, once the checks above let it run.
    const note = noteFor(call);
    if (note !== undefined) report?.({ kind: "note", text: note });

    // The step's time limit counts from here, once it holds a slot, not while it waits for one.
    const timeout = step.timeoutMs ? AbortSignal.timeout(step.timeoutMs) : undefined;
    const signals = [call.signal, timeout].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    // The attempt's tokens so far. A program's go to onUsage as it runs. A runner's are kept for
    // the end of the attempt.
    const usageTo = options.onUsage;
    const usageStep = usageTo && activityStep(call.runId, call.callIndex, call.label);
    let spent: AgentUsage | undefined;
    const usage = usageStep && ((now: AgentUsage) => usageTo(usageStep, (spent = now)));
    const counted: StepRequest = usageStep
      ? {
          ...call,
          onUsage: (now) => {
            spent = now;
            call.onUsage?.(now);
          },
        }
      : call;
    try {
      const account = options.accounts?.[step.harness];
      if (options.inner) return await runInner(options.inner, withNote(prompt, note), counted, step, { signal, servers, account });
      const notesTo = options.onNotes;
      const onNotes = notesTo && ((notes: string[]) => notesTo({ label: call.label, notes }));
      const steering = options.steering && activityStep(call.runId, call.callIndex, call.label);
      const board = steering ? { board: options.steering!, call: steering } : undefined;
      return await runOnHarness(program ?? createHarness(step.harness), prompt, call, step, { cwd: call.cwd ?? options.cwd, signal, servers, stop, account, onNotes, activity: report, board, usage, note });
    } catch (error) {
      if ((error as { code?: unknown } | undefined)?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT) {
        options.onLimit?.({ program: step.harness, label: call.label });
      }
      if (timeout?.aborted && !call.signal?.aborted) {
        throw new WorkflowError(`timed out after ${Math.round(step.timeoutMs! / 1000)}s`, WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
          recoverable: true,
          agentLabel: call.label,
        });
      }
      throw error;
    } finally {
      if (usageStep) usageTo!(usageStep, spent ?? NO_USAGE, true);
      release?.();
    }
  };

  return {
    route: (ask) => routeStep(options.agents, ask),
    run,
    async dispose() {
      await options.inner?.dispose?.();
    },
  };
}

/** A test's or the dry run's runner gets the planned step with the engine's own fields, and the
 *  account. A slash prompt's note goes apart from the prompt, in the request. It gets one call, with
 *  the schema: a runner keeps no session for a report turn. */
async function runInner(
  inner: InnerRunner,
  { prompt, note }: { prompt: string; note?: string },
  call: StepRequest,
  step: RoutePlan,
  given: { signal?: AbortSignal; servers: McpServerConfig[]; account?: Account },
): Promise<unknown> {
  const { signal, servers, account } = given;
  const { route, model: _model, callIndex: _index, callHash: _hash, callPath: _path, callInputsHash: _inputs, ...rest } = call;
  const resolved = call.onModelResolved;
  const onModelResolved = resolved && ((id: string) => resolved(withHarness(step.harness, id)));
  if (step.model && step.model !== route.requested) onModelResolved?.(step.model);
  const request: PlannedRequest = {
    ...rest,
    ...(onModelResolved ? { onModelResolved } : {}),
    ...(step.model ? { model: step.model } : {}),
    ...(step.effort ? { effort: step.effort } : {}),
    ...(step.skills ? { skills: step.skills } : {}),
    ...(step.tools ? { toolNames: step.tools } : {}),
    ...(step.disallowedTools ? { disallowedToolNames: step.disallowedTools } : {}),
    ...(signal ? { signal } : {}),
    ...(servers.length ? { mcpServers: servers } : {}),
    ...(account ? { account } : {}),
    ...(note === undefined ? {} : { note }),
  };
  return inner.run(prompt, request);
}

/** One step on a harness, with its continuation, its schema repairs and what it reports. */
async function runOnHarness(
  adapter: Adapter,
  prompt: string,
  call: StepRequest,
  step: RoutePlan,
  given: {
    cwd: string;
    signal?: AbortSignal;
    servers: McpServerConfig[];
    stop: (message: string) => WorkflowError;
    account?: Account;
    onNotes?: (notes: string[]) => void;
    activity?: (entry: ActivityEntry) => void;
    board?: { board: SteeringBoard; call: LiveCall };
    /** Gets the attempt's tokens so far while a turn runs. */
    usage?: (spent: AgentUsage) => void;
    /** The resume's note, with the prompt or the continuation instruction. Report and repair turns go without it. */
    note?: string;
  },
): Promise<unknown> {
  const { cwd, signal, servers, stop, account, onNotes, activity, board, usage, note } = given;
  const harness = step.harness;
  const label = call.label;
  const schema = call.schema;
  const model = stepModel(step.model);
  const images = checkImages(call.images, label);
  const mcpServers = servers.map((server) => {
    const converted = toMcpServer(server);
    if ("problem" in converted) throw stop(converted.problem);
    return converted;
  });
  const tools = step.tools || step.disallowedTools ? { tools: { ...(step.tools ? { allow: step.tools } : {}), ...(step.disallowedTools ? { deny: step.disallowedTools } : {}) } } : {};
  const base: Omit<Step, "prompt"> = {
    cwd,
    ...(account ? { account } : {}),
    ...(model ? { model } : {}),
    ...(step.effort ? { effort: step.effort } : {}),
    ...(call.instructions ? { instructions: call.instructions } : {}),
    ...tools,
    ...(step.skills ? { skills: step.skills } : {}),
    ...(mcpServers.length ? { mcpServers } : {}),
    ...(call.mode ? { mode: call.mode } : {}),
    ...(signal ? { signal } : {}),
  };

  // What the attempt reports once, at the end.
  let spent: Usage | undefined;
  // Claude Code restores a session's cost total on resume, so a resumed turn's reading includes what came before.
  // gauge is the session's latest reading, and cost what this step spent.
  let gauge: number | undefined;
  let cost: number | undefined;
  // Whether the turn that runs resumed a session.
  let resuming = false;
  // The step's cost with a turn's reading. A reading below the gauge means the program started the total over.
  const costWith = (reading: number | undefined, resumed: boolean) =>
    reading === undefined ? cost : (cost ?? 0) + (resumed && gauge !== undefined && reading >= gauge ? reading - gauge : reading);
  const count = (usage: Usage, resumed: boolean) => {
    spent = spent ? addUsage(spent, usage) : usage;
    if (usage.costUsd === undefined) return;
    cost = costWith(usage.costUsd, resumed);
    gauge = usage.costUsd;
  };
  const history: AgentHistoryEntry[] = [];
  // Each turn repeats what the program could not do as asked, so the step reports each note once.
  const notes = new Set<string>();
  let opened: string | undefined;
  const open = (sessionId: string) => {
    if (opened) return;
    opened = sessionId;
    const ref: AgentSessionRef = {
      sessionId,
      backendId: harness,
      poolKey: harness,
      cwd,
      reopen: { load: true, resume: true, list: true, fork: true },
      ...(model ? { model: `${harness}/${model}` } : {}),
    };
    call.onSessionOpen?.(ref);
  };
  // The attempt's tokens as the program last reported them while a turn ran.
  let running: AgentUsage | undefined;
  // The step's signal aborts on a stop the host asks for (the budget, the run's time limit,
  // `sous stop --step`), on the step's own time limit, and when the run is aborted. A host's stop
  // settles the step as soon as it asks, before the program's last count arrives. So an abort
  // reports the larger of the running and the counted totals at once, and the record keeps at
  // least what the budget saw. The report at the attempt's end follows, as for any attempt.
  const stopped = () => {
    const counted = spent && agentUsage(spent, cost ?? 0);
    const now = running && (!counted || running.total > counted.total) ? running : counted;
    try {
      if (now) call.onUsage?.(now);
    } catch {
      // The abort's listener has no caller to throw to. The report at the attempt's end tries again.
    }
  };
  signal?.addEventListener("abort", stopped, { once: true });
  // Each turn's first user entry is its prompt. A later one is a tell the program read.
  let prompted = false;
  const events: StepEvents = {
    session: open,
    history: (entry) => {
      if (entry.role === "user") {
        if (prompted) activity?.({ kind: "tell", text: entry.text });
        prompted = true;
        return;
      }
      history.push(toHistory(entry));
      activity?.({ kind: ACTIVITY_KINDS[entry.kind], ...(entry.toolName === undefined ? {} : { tool: entry.toolName }), text: entry.text });
    },
    ...(board ? { steer: (send) => (send ? board.board.open(board.call, send) : board.board.close(board.call)) } : {}),
    // The turn's running total, on top of the turns of this attempt before it.
    usage: (turn) => {
      running = agentUsage(spent ? addUsage(spent, turn) : turn, costWith(turn.costUsd, resuming) ?? 0);
      usage?.(running);
    },
  };
  const once = async (turn: Step): Promise<StepResult> => {
    prompted = false;
    resuming = turn.resume !== undefined;
    try {
      const result = await adapter.run(turn, events);
      count(result.usage, turn.resume !== undefined);
      for (const note of result.notes ?? []) notes.add(note);
      return result;
    } catch (error) {
      if (isFailure(error)) {
        if (error.usage) count(error.usage, turn.resume !== undefined);
        for (const note of error.notes ?? []) notes.add(note);
        if (error.sessionId) open(error.sessionId);
      }
      throw error;
    }
  };
  const report = (provenance: AgentResultProvenance) => {
    try {
      call.onResultProvenance?.(provenance);
    } catch {
      // Provenance is for the record only.
    }
  };

  const recorded = call.continueFromSession;
  try {
    // The record names the model, or the harness alone when the step picks none.
    if (model) call.onModelResolved?.(withHarness(harness, model));
    else if (step.model && step.model !== call.route.requested) call.onModelResolved?.(withHarness(harness, step.model));
    const fresh = { ...withNote(prompt, note), ...(images.length ? { images } : {}) };
    const turns = stepTurns(prompt, schema);
    let answer: Answer | undefined;
    // A schema answer the program refused still has text to read.
    const turn = async (input: Step): Promise<Answer> => {
      try {
        const result = await once(input);
        return { text: result.text, value: result.value, sessionId: result.sessionId };
      } catch (error) {
        const failure = failureOf(error);
        if (schema && failure?.kind === "schema") return { text: failure.text, sessionId: (error as HarnessFailure).sessionId ?? opened };
        throw error;
      }
    };

    if (recorded) {
      let continuation: ContinuationAttempt;
      if (recorded.backendId !== harness || (recorded.poolKey ?? recorded.backendId) !== harness) {
        continuation = { reattached: false, reason: "backend-mismatch" };
      } else {
        try {
          const text = call.continueWithPrompt ? fresh : withNote(CONTINUATION_INSTRUCTION, note);
          if (typeof recorded.costGauge === "number" && Number.isFinite(recorded.costGauge)) gauge = recorded.costGauge;
          answer = await turn({ ...base, ...text, ...turns.work, resume: recorded.sessionId });
          continuation = { reattached: true, method: "resume" };
        } catch (error) {
          if (failureOf(error)?.kind !== "no_session" || signal?.aborted) throw error;
          // A kept turn goes on in its session or fails. A new session would not hold the turns before.
          if (call.continueWithPrompt) {
            throw new WorkflowError(
              `step "${label ?? "agent"}": the program could not find session ${recorded.sessionId} to go on in. The session's earlier turns are gone, so the step stops.`,
              WorkflowErrorCode.AGENT_EXECUTION_ERROR,
              { recoverable: false, agentLabel: label },
            );
          }
          gauge = undefined;
          continuation = { reattached: false, reason: "reattach-failed" };
        }
      }
      report({ source: "live", continuation });
    }
    answer ??= await turn({ ...base, ...fresh, ...turns.work });
    if (turns.report) {
      signal?.throwIfAborted();
      answer = await turn({ ...base, ...turns.report, resume: answer.sessionId ?? opened });
    }

    if (!schema) {
      const text = answer.text.trim();
      if (!text) throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true, agentLabel: label });
      return text;
    }
    for (let repair = 0; ; repair++) {
      const value = fits(answer, schema);
      if (value !== undefined) return value;
      if (repair >= REPAIRS || !answer.sessionId) break;
      signal?.throwIfAborted();
      answer = await turn({ ...base, prompt: REPROMPT_TEXT, schema: schema as unknown as Record<string, unknown>, resume: answer.sessionId });
    }
    throw new WorkflowError("Subagent did not produce valid structured output after repair attempts", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, {
      recoverable: false,
      agentLabel: label,
    });
  } catch (error) {
    throw mapFailure(error, harness, label, call.signal);
  } finally {
    signal?.removeEventListener("abort", stopped);
    // The adapter closes the seam at the end of each turn. A turn that threw may not have.
    if (board) board.board.close(board.call);
    if (spent) {
      call.onUsage?.(agentUsage(spent, cost ?? 0));
      if (gauge !== undefined) call.onSessionCostGauge?.(gauge);
    }
    if (history.length) call.onHistory?.(history);
    if (notes.size) onNotes?.([...notes]);
  }
}

/** A turn's answer: its text, the schema's value when the program gave one, and its session. */
type Answer = { text: string; value?: unknown; sessionId?: string };

/**
 * The schema of a step's work turn, and the report turn after it. A plain prompt's turn carries
 * the schema. A slash prompt's turn carries none, since a schema cuts a command such as /goal
 * short. A slash step with a schema then sends the report turn, with the schema, in the same
 * session. The step's own prompt decides, so a continued slash step reports too.
 */
function stepTurns(prompt: string, schema: TSchema | undefined): { work: Pick<Step, "schema">; report?: Pick<Step, "prompt" | "schema"> } {
  if (!schema) return { work: {} };
  const json = schema as unknown as Record<string, unknown>;
  return isSlash(prompt) ? { work: {}, report: { prompt: REPORT_PROMPT, schema: json } } : { work: { schema: json } };
}

/** The answer's value when it fits the schema: the program's own value, else JSON in its text. */
function fits(answer: { text: string; value?: unknown }, schema: TSchema): unknown {
  let value = answer.value;
  if (value === undefined) {
    try {
      value = JSON.parse(answer.text);
    } catch {
      value = undefined;
    }
  }
  if (value !== undefined) {
    const fitted = validateValue(value, schema);
    if (fitted !== undefined) return fitted;
  }
  return extractValidated(answer.text, schema);
}

/** A harness failure as the error the engine records. Anything else passes as it is. */
function mapFailure(error: unknown, harness: HarnessId, label: string | undefined, caller: AbortSignal | undefined): unknown {
  const failure = failureOf(error);
  if (!failure) return error;
  const message = (error as Error).message;
  switch (failure.kind) {
    case "usage_limit": {
      const resetAt = failure.resetAt;
      return new WorkflowError(message || "Provider usage/quota limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable: false,
        agentLabel: label,
        ...(resetAt ? { resetHint: `Resets at ${resetAt}` } : {}),
        providerUsageLimitContext: { backendId: harness, source: "provider", ...(resetAt ? { resetAt } : {}) },
      });
    }
    case "auth":
      return new WorkflowError(message, WorkflowErrorCode.AUTH_REQUIRED, { recoverable: false, agentLabel: label, authContext: { backendId: harness, methods: [] } });
    case "stopped":
      // The engine stopped the step, or its time ran out. The caller turns a timeout into its error.
      if (caller?.aborted) return error;
      return new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: false, agentLabel: label });
    case "program":
      return new WorkflowError(`step "${label ?? "agent"}": ${failure.problem}`, WorkflowErrorCode.INVALID_ARGUMENT, { recoverable: false, agentLabel: label });
    case "failed":
      return new WorkflowError(message, WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: failure.retry, agentLabel: label });
    case "no_session":
    case "schema":
      return new WorkflowError(message, WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true, agentLabel: label });
  }
}

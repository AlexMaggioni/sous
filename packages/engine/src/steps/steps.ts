// The steps module. It turns a workflow's agent call into one step on Claude Code or Codex.
// It routes the step with routeStep, finds the program once per run, names the MCP servers, takes
// a slot, sets the time limit and runs the step. A schema answer that does not fit gets repair turns
// in the same session. Code steps never come here: the engine runs them.
// A test or the dry run gives `inner`, a runner of its own, and then no program starts.

import type { TSchema } from "typebox";
import {
  createClaudeHarness,
  createCodexHarness,
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
} from "@orchestrator/harnesses";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { AgentResultProvenance, AgentUsage, ContinuationAttempt, PlannedRequest, StepRequest } from "./agent-run.js";
import type { AgentRunner, StepAsk, StepRoute } from "./agent-runner.js";
import type { AgentSessionRef } from "../workflow-result.js";
import type { McpServerConfig } from "./mcp-config.js";
import { harnessName, isHarness, missingServer, routeStep, type AgentLookup, type McpLookup, type RoutePlan } from "../agents.js";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import type { SlotPool } from "../runs/slots.js";
import { buildPrompt, checkImages, CONTINUATION_INSTRUCTION, extractValidated, REPROMPT_TEXT, toMcpServer, validateValue } from "./answer.js";

/** The runner a test or the dry run gives instead of the programs. It gets the planned step. */
export interface InnerRunner {
  run(prompt: string, request: PlannedRequest): Promise<unknown>;
  dispose?: () => Promise<void> | void;
  auth?: LoginCheck;
}

/** The engine asks it before it resumes a run that paused for a lost login. */
interface LoginCheck {
  canResume(harness: string): boolean;
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
}

const ADAPTERS: Record<HarnessId, (lookup: FindOptions) => Adapter> = { claude: createClaudeHarness, codex: createCodexHarness };

/** Schema repair turns when the step sets none. */
const REPAIRS = 2;

/**
 * The model a harness takes: the spec without its harness. A harness alone gives none. An agent
 * file whose model names its harness, such as `model: claude/haiku`, gives the spec
 * claude/claude/haiku, which the journal and the run record keep, so the harness is dropped twice.
 */
export function stepModel(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  const [first, ...rest] = spec.split("/");
  if (!isHarness(first!.toLowerCase())) return spec;
  const model = rest[0]?.toLowerCase() === first!.toLowerCase() ? rest.slice(1) : rest;
  return model.length ? model.join("/") : undefined;
}

const isFailure = (error: unknown): error is HarnessFailure => error instanceof Error && "failure" in error;
const failureOf = (error: unknown): Failure | undefined => (isFailure(error) ? error.failure : undefined);

/** The tokens of two turns. Cost is counted apart, since a resumed reading includes the turns before it. */
function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, total: a.total + b.total };
}

const toHistory = (entry: HistoryEntry): AgentHistoryEntry => ({
  role: entry.role,
  kind: entry.kind,
  text: entry.text,
  ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
  ...(entry.isError === undefined ? {} : { isError: entry.isError }),
  timestamp: entry.at,
});

export function createSteps(options: StepsOptions): AgentRunner & { route(ask: StepAsk): StepRoute; dispose(): Promise<void>; auth: LoginCheck } {
  const lookup = options.programs ?? (options.inner ? undefined : () => ({}));
  const programs = new Map<HarnessId, Promise<Adapter | { problem: string }>>();

  /** Find the harness's program and check its version, once per run. */
  async function prepare(harness: HarnessId, where: FindOptions): Promise<Adapter | { problem: string }> {
    const finder = ADAPTERS[harness](where);
    const found: Found = finder.find();
    if ("problem" in found) return { problem: found.problem };
    const { version, problem } = await finder.version(found.path);
    options.onProgram?.({ program: harness, name: harnessName(harness), path: found.path, ...(version ? { version } : {}) });
    if (problem) return { problem };
    // Every later step runs on this same file.
    return ADAPTERS[harness]({ path: found.path, env: {}, usualDirs: [] });
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

    // The step's time limit counts from here, once it holds a slot, not while it waits for one.
    const timeout = step.timeoutMs ? AbortSignal.timeout(step.timeoutMs) : undefined;
    const signals = [call.signal, timeout].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    try {
      const account = options.accounts?.[step.harness];
      if (options.inner) return await runInner(options.inner, prompt, call, step, { signal, servers, account });
      return await runOnHarness(program ?? ADAPTERS[step.harness]({}), prompt, call, step, { cwd: call.cwd ?? options.cwd, signal, servers, stop, account });
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
      release?.();
    }
  };

  return {
    route: (ask) => routeStep(options.agents, ask),
    run,
    // A run paused for a lost login may resume: each step starts its program, which reads the
    // login again. If it is still gone, the step fails the same way and the run pauses again.
    // A runner that stands in for the programs answers for its own login.
    auth: { canResume: (harness) => options.inner?.auth?.canResume(harness) ?? true },
    async dispose() {
      for (const pending of programs.values()) {
        const program = await pending;
        if (!("problem" in program)) await program.close();
      }
      await options.inner?.dispose?.();
    },
  };
}

/** The step's record shows the harness with the model, such as claude/haiku. */
const withHarness = (harness: HarnessId, id: string) => (isHarness(id.split("/")[0]!.toLowerCase()) ? id : `${harness}/${id}`);

/** A test's or the dry run's runner gets the planned step with the engine's own fields, and the account. */
async function runInner(
  inner: InnerRunner,
  prompt: string,
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
  };
  return inner.run(prompt, request);
}

/** One step on a harness, with its continuation, its schema repairs and what it reports. */
async function runOnHarness(
  adapter: Adapter,
  prompt: string,
  call: StepRequest,
  step: RoutePlan,
  given: { cwd: string; signal?: AbortSignal; servers: McpServerConfig[]; stop: (message: string) => WorkflowError; account?: Account },
): Promise<unknown> {
  const { cwd, signal, servers, stop, account } = given;
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
    ...(schema ? { schema: schema as unknown as Record<string, unknown> } : {}),
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
  const count = (usage: Usage, resumed: boolean) => {
    spent = spent ? addUsage(spent, usage) : usage;
    const reading = usage.costUsd;
    if (reading === undefined) return;
    // A reading below the gauge means the program started the total over.
    cost = (cost ?? 0) + (resumed && gauge !== undefined && reading >= gauge ? reading - gauge : reading);
    gauge = reading;
  };
  const history: AgentHistoryEntry[] = [];
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
  const events: StepEvents = {
    session: open,
    history: (entry) => {
      if (entry.role !== "user") history.push(toHistory(entry));
    },
  };
  const once = async (turn: Step): Promise<StepResult> => {
    try {
      const result = await adapter.run(turn, events);
      count(result.usage, turn.resume !== undefined);
      return result;
    } catch (error) {
      if (isFailure(error)) {
        if (error.usage) count(error.usage, turn.resume !== undefined);
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
    const fresh = { prompt: buildPrompt(prompt, label, schema), ...(images.length ? { images } : {}) };
    let answer: { text: string; value?: unknown; sessionId?: string } | undefined;
    // A schema answer the program refused still has text to read.
    const turn = async (input: Step) => {
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
          const text = call.continueWithPrompt ? fresh : { prompt: buildPrompt(CONTINUATION_INSTRUCTION, label, schema) };
          if (typeof recorded.costGauge === "number" && Number.isFinite(recorded.costGauge)) gauge = recorded.costGauge;
          answer = await turn({ ...base, ...text, resume: recorded.sessionId });
          continuation = { reattached: true, method: "resume" };
        } catch (error) {
          if (failureOf(error)?.kind !== "no_session" || signal?.aborted) throw error;
          gauge = undefined;
          continuation = { reattached: false, reason: "reattach-failed" };
        }
      }
      report({ source: "live", continuation });
    }
    answer ??= await turn({ ...base, ...fresh });

    if (!schema) {
      const text = answer.text.trim();
      if (!text) throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true, agentLabel: label });
      return text;
    }
    const repairs = Math.max(0, call.maxSchemaRetries ?? REPAIRS);
    for (let repair = 0; ; repair++) {
      const value = fits(answer, schema);
      if (value !== undefined) return value;
      if (repair >= repairs || !answer.sessionId) break;
      signal?.throwIfAborted();
      answer = await turn({ ...base, prompt: REPROMPT_TEXT, resume: answer.sessionId });
    }
    throw new WorkflowError("Subagent did not produce valid structured output after repair attempts", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, {
      recoverable: false,
      agentLabel: label,
    });
  } catch (error) {
    throw mapFailure(error, harness, label, call.signal);
  } finally {
    if (spent) {
      const usage: AgentUsage = { input: spent.input, output: spent.output, cacheRead: spent.cacheRead, cacheWrite: spent.cacheWrite, total: spent.total, cost: cost ?? 0 };
      call.onUsage?.(usage);
      if (gauge !== undefined) call.onSessionCostGauge?.(gauge);
    }
    if (history.length) call.onHistory?.(history);
  }
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

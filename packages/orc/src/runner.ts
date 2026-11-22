// The runner orc gives the engine. Code steps (model "exec") run locally. Agent steps take a
// slot from the machine-wide cap, then run through the ACP runner from acp-agents with the step's
// effort, skills, MCP servers and time limit. A step that names an agent runs on the harness
// agents.ts picks for it, with that harness's settings, or stops when the agent can't run there.
// A Claude Code or Codex step runs on the installed program programs.ts finds, or stops when
// there is none.

import { createAcpRunner } from "@orchestrator/acp-agents";
import { WorkflowError, WorkflowErrorCode, type AgentRunner, type McpServerConfig } from "@orchestrator/shared-types";
import { EXEC_MODEL, type ExecSpec } from "@orchestrator/engine";
import { isHarness, missingServer, planStep, removedHarness, routeHarness, type AgentLookup, type Harness, type McpLookup, type StepGiven } from "./agents.js";
import { runExecSpec } from "./exec.js";
import { findProgram, isProgram, PROGRAM_INFO, programVersion, type FoundProgram, type Program, type ProgramLookup } from "./programs.js";
import type { SlotPool } from "./slots.js";

export interface OrcRunnerOptions {
  /** The run's folder, for steps that don't name one. */
  cwd: string;
  /** The agent runner. Defaults to the ACP runner from acp-agents, made on the first agent step. */
  inner?: AgentRunner & { dispose?: () => Promise<void> | void };
  slots?: SlotPool;
  /** The agents a step can name with `agentType`, from rulesync and the harnesses' own folders. */
  agents?: AgentLookup;
  /** The MCP servers a step can list with `mcp: [...]`, for the step's harness. */
  mcp?: McpLookup;
  /** Extra environment for code steps. */
  env?: Record<string, string>;
  /** Called when an agent step waits for a slot and when it gets one. */
  onSlot?: (event: { label?: string; state: "waiting" | "running" }) => void;
  /** Finds the installed program a Claude Code or Codex step runs on. With the ACP runner
   *  the default looks as programs.ts says. A runner given as `inner` brings its own programs,
   *  so no lookup runs unless this is set. */
  programs?: (program: Program) => ProgramLookup;
  /** Called once per program, before the first step that runs on it. */
  onProgram?: (found: FoundProgram & { version?: string }) => void;
  /** Called when a step hits its program's usage limit, before the run pauses. */
  onLimit?: (event: { program: Program; label?: string }) => void;
}

interface OrcRunExtras {
  label?: string;
  model?: string;
  cwd?: string;
  signal?: AbortSignal;
  runId?: string;
  meta?: Record<string, unknown>;
  mcpServers?: McpServerConfig[];
  timeoutMs?: number;
  effort?: string;
  skills?: string[];
  mcpNames?: string[];
  agentType?: string;
  stepGiven?: StepGiven;
  toolNames?: string[];
  disallowedToolNames?: string[];
}

/** What an agent step runs with, after its agent is looked up. */
interface StepRun {
  harness: Harness;
  model?: string;
  effort?: string;
  skills?: string[];
  mcpNames?: string[];
  tools?: string[];
  disallowedTools?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface ClaudeOptions {
  effort?: string;
  skills?: string[];
  /** The agent's allow list. Only the built-in tools in it exist for the agent. */
  tools?: string[];
  /** The agent's deny list. */
  disallowedTools?: string[];
}

/** A tool name without its rule, such as Bash for "Bash(git *)". */
const toolName = (entry: string) => entry.replace(/\(.*\)$/, "").trim();

/**
 * Put effort, skills and the agent's tool lists where the Claude adapter reads them:
 * _meta.claudeCode.options. The tool lists go there because the adapter answers permission
 * requests itself when the user's Claude Code settings allow a tool or bypass permissions, so
 * orc's own answers never see them. Claude Code applies a deny list in every permission mode.
 */
export function claudeMeta(meta: Record<string, unknown> | undefined, given: ClaudeOptions = {}) {
  const { effort, skills, tools, disallowedTools } = given;
  if (effort === undefined && skills === undefined && tools === undefined && !disallowedTools?.length) return meta;
  const base = isRecord(meta) ? meta : {};
  const claudeCode = isRecord(base.claudeCode) ? base.claudeCode : {};
  const options = isRecord(claudeCode.options) ? claudeCode.options : {};
  const builtIn = tools?.filter((entry) => !entry.startsWith("mcp__")).map(toolName);
  return {
    ...base,
    claudeCode: {
      ...claudeCode,
      options: {
        ...options,
        ...(effort === undefined ? {} : { effort }),
        ...(skills === undefined ? {} : { skills: [...skills] }),
        ...(builtIn === undefined ? {} : { tools: [...new Set(builtIn)], allowedTools: [...tools!] }),
        ...(disallowedTools?.length ? { disallowedTools: [...disallowedTools] } : {}),
      },
    },
  };
}

export function createOrcRunner(options: OrcRunnerOptions): AgentRunner & { dispose(): Promise<void> } {
  let inner = options.inner;
  const innerRunner = () => (inner ??= createAcpRunner() as unknown as NonNullable<OrcRunnerOptions["inner"]>);
  const lookup = options.programs ?? (options.inner ? undefined : (program: Program) => findProgram(program));
  const ready = new Set<Program>();
  /** Point the adapter at the installed program. Returns the problem when there is none. */
  const useProgram = (program: Program): string | undefined => {
    if (!lookup || ready.has(program)) return undefined;
    const found = lookup(program);
    if ("problem" in found) return found.problem;
    // The adapters read these each time they start, so every later session gets the same program.
    process.env[PROGRAM_INFO[program].variable] = found.path;
    ready.add(program);
    options.onProgram?.({ ...found, version: programVersion(found.path) });
    return undefined;
  };

  const run = async (prompt: string, runOptions: Record<string, unknown> = {}): Promise<unknown> => {
    const extras = runOptions as OrcRunExtras;
    if (extras.model === EXEC_MODEL) {
      let spec: ExecSpec;
      try {
        spec = JSON.parse(prompt) as ExecSpec;
      } catch {
        throw new WorkflowError("a code step's spec is not valid JSON", WorkflowErrorCode.INVALID_ARGUMENT, { recoverable: false, agentLabel: extras.label });
      }
      return runExecSpec(spec, { cwd: extras.cwd ?? options.cwd, signal: extras.signal, timeoutMs: extras.timeoutMs, env: options.env });
    }

    const stop = (message: string) =>
      new WorkflowError(`step "${extras.label ?? "agent"}": ${message}`, WorkflowErrorCode.INVALID_ARGUMENT, { recoverable: false, agentLabel: extras.label });
    const removed = removedHarness(extras.model);
    if (removed) throw stop(removed);
    const env = options.agents?.settings.env ?? process.env;
    let step: StepRun = {
      harness: routeHarness(extras.model, env) ?? options.agents?.settings.defaultHarness ?? "claude",
      ...(extras.model ? { model: extras.model } : {}),
      effort: extras.effort,
      skills: extras.skills,
      mcpNames: extras.mcpNames,
      tools: extras.toolNames,
      disallowedTools: extras.disallowedToolNames,
    };
    if (extras.agentType && options.agents) {
      const planned = planStep(options.agents, extras.agentType, extras.stepGiven, extras.model);
      if ("problem" in planned) throw stop(planned.problem);
      const { plan } = planned;
      step = { harness: plan.harness, model: plan.model, effort: plan.effort, skills: plan.skills, mcpNames: plan.mcp, tools: plan.tools, disallowedTools: plan.disallowedTools };
    }

    if (isProgram(step.harness)) {
      const problem = useProgram(step.harness);
      if (problem) throw stop(problem);
    }

    const servers = [...(extras.mcpServers ?? [])];
    for (const name of step.mcpNames ?? []) {
      const found = options.mcp?.find(name, step.harness);
      if (!found) throw stop(options.mcp ? missingServer(name, step.harness, options.mcp) : `no MCP server "${name}". Add it to .rulesync/mcp.jsonc.`);
      if (!servers.some((existing) => existing.name === found.server.name)) servers.push(found.server);
    }

    const signals: AbortSignal[] = [];
    if (extras.signal) signals.push(extras.signal);
    const timeout = extras.timeoutMs ? AbortSignal.timeout(extras.timeoutMs) : undefined;
    if (timeout) signals.push(timeout);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    let release: (() => void) | undefined;
    if (options.slots) {
      options.onSlot?.({ label: extras.label, state: "waiting" });
      release = await options.slots.acquire({ runId: extras.runId, label: extras.label }, extras.signal);
      options.onSlot?.({ label: extras.label, state: "running" });
    }
    try {
      const { timeoutMs: _t, effort: _e, skills: _s, mcpNames: _m, agentType: _a, stepGiven: _g, model: _model, toolNames: _tn, disallowedToolNames: _dn, ...rest } = extras as OrcRunExtras &
        Record<string, unknown>;
      // The step's record shows the harness and model it runs on, such as claude/haiku, also when
      // the agent's block picked the model. The ACP runner reports the model without its harness.
      const resolved = (extras as { onModelResolved?: (id: string) => void }).onModelResolved;
      const withHarness = (id: string) => (isHarness(id.split("/")[0]!.toLowerCase()) ? id : `${step.harness}/${id}`);
      const onModelResolved = resolved && ((id: string) => resolved(withHarness(id)));
      if (step.model && step.model !== extras.model) onModelResolved?.(step.model);
      // Codex takes effort as a session setting, where Claude Code takes it in its options.
      const configOptions = step.harness === "codex" && step.effort ? { reasoning_effort: step.effort, ...(rest.configOptions as Record<string, string | boolean> | undefined) } : rest.configOptions;
      return await innerRunner().run(prompt, {
        ...rest,
        ...(configOptions ? { configOptions } : {}),
        ...(onModelResolved ? { onModelResolved } : {}),
        ...(step.model ? { model: step.model } : {}),
        ...(step.tools ? { toolNames: step.tools } : {}),
        ...(step.disallowedTools ? { disallowedToolNames: step.disallowedTools } : {}),
        ...(signal ? { signal } : {}),
        ...(servers.length ? { mcpServers: servers } : {}),
        meta: claudeMeta(extras.meta, { effort: step.effort, skills: step.skills, tools: step.tools, disallowedTools: step.disallowedTools }),
      } as never);
    } catch (error) {
      if ((error as { code?: unknown } | undefined)?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT && isProgram(step.harness)) {
        options.onLimit?.({ program: step.harness, label: extras.label });
      }
      if (timeout?.aborted && !extras.signal?.aborted) {
        throw new WorkflowError(`timed out after ${Math.round(extras.timeoutMs! / 1000)}s`, WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
          recoverable: true,
          agentLabel: extras.label,
        });
      }
      throw error;
    } finally {
      release?.();
    }
  };

  return {
    run: run as AgentRunner["run"],
    async dispose() {
      await inner?.dispose?.();
    },
  };
}

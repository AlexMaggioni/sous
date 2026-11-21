// The runner orc gives the engine. Code steps (model "exec") run locally. Agent steps take a
// slot from the machine-wide cap, then run through AgentPrism's ACP runner with the step's
// effort, skills, MCP servers and time limit.

import { createAcpRunner } from "@automatalabs/acp-agents";
import { WorkflowError, WorkflowErrorCode, type AgentRunner, type McpServerConfig } from "@automatalabs/shared-types";
import { EXEC_MODEL, type ExecSpec } from "@automatalabs/workflow-engine";
import { runExecSpec } from "./exec.js";
import type { SlotPool } from "./slots.js";

export interface OrcRunnerOptions {
  /** The run's folder, for steps that don't name one. */
  cwd: string;
  /** The agent runner. Defaults to AgentPrism's ACP runner, made on the first agent step. */
  inner?: AgentRunner & { dispose?: () => Promise<void> | void };
  slots?: SlotPool;
  /** Named MCP servers a step can list with `mcp: [...]`. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Extra environment for code steps. */
  env?: Record<string, string>;
  /** Called when an agent step waits for a slot and when it gets one. */
  onSlot?: (event: { label?: string; state: "waiting" | "running" }) => void;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Put effort and skills where the Claude adapter reads them: _meta.claudeCode.options. */
export function claudeMeta(meta: Record<string, unknown> | undefined, effort: string | undefined, skills: string[] | undefined) {
  if (effort === undefined && skills === undefined) return meta;
  const base = isRecord(meta) ? meta : {};
  const claudeCode = isRecord(base.claudeCode) ? base.claudeCode : {};
  const options = isRecord(claudeCode.options) ? claudeCode.options : {};
  return {
    ...base,
    claudeCode: {
      ...claudeCode,
      options: {
        ...options,
        ...(effort === undefined ? {} : { effort }),
        ...(skills === undefined ? {} : { skills: [...skills] }),
      },
    },
  };
}

export function createOrcRunner(options: OrcRunnerOptions): AgentRunner & { dispose(): Promise<void> } {
  let inner = options.inner;
  const innerRunner = () => (inner ??= createAcpRunner() as unknown as NonNullable<OrcRunnerOptions["inner"]>);

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

    const servers = [...(extras.mcpServers ?? [])];
    for (const name of extras.mcpNames ?? []) {
      const server = options.mcpServers?.[name];
      if (!server) {
        throw new WorkflowError(
          `step "${extras.label ?? "agent"}" lists the MCP server "${name}", which is not in mcp.json. Add it to ~/.orchestrator/mcp.json or the project's .orchestrator/mcp.json.`,
          WorkflowErrorCode.INVALID_ARGUMENT,
          { recoverable: false, agentLabel: extras.label },
        );
      }
      if (!servers.some((existing) => existing.name === server.name)) servers.push(server);
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
      const { timeoutMs: _t, effort: _e, skills: _s, mcpNames: _m, agentType: _a, ...rest } = extras as OrcRunExtras & Record<string, unknown>;
      return await innerRunner().run(prompt, {
        ...rest,
        ...(signal ? { signal } : {}),
        ...(servers.length ? { mcpServers: servers } : {}),
        meta: claudeMeta(extras.meta, extras.effort, extras.skills),
      } as never);
    } catch (error) {
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

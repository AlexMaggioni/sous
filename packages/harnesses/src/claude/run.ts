// One step on Claude Code: one query() of the Claude Agent SDK.

import { randomUUID } from "node:crypto";
import {
  query,
  type EffortLevel,
  type McpServerConfig,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { addUsage, noUsage, StepFailure, usage } from "../failure.js";
import { toAnthropicJsonSchema } from "../schema.js";
import { refusal, toolName } from "../tools.js";
import type { Failure, HistoryEntry, McpServer, Step, StepEvents, StepResult, Usage } from "../types.js";
import { claudeEnv } from "./program.js";
import { Tells } from "./tells.js";

const MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];
const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
// Questions go through the engine's QUESTION: reply, never through the program's own tool.
const ASK = "AskUserQuestion";

/** The SDK options for a step, and the notes on what it could not honor. */
function claudeOptions(path: string, step: Step, sessionId: string, abort: AbortController, stderr: (text: string) => void) {
  const notes: string[] = [];
  const allow = step.tools?.allow;
  const deny = step.tools?.deny ?? [];
  const options: Options = {
    pathToClaudeCodeExecutable: path,
    cwd: step.cwd,
    env: claudeEnv(step.account),
    settingSources: ["user", "project", "local"],
    systemPrompt: step.instructions ? { type: "preset", preset: "claude_code", append: step.instructions } : { type: "preset", preset: "claude_code" },
    disallowedTools: [...new Set([...deny, ASK])],
    canUseTool: async (tool, input) => {
      const why = tool === ASK ? "Ask the question in your answer instead." : refusal(step.tools, tool);
      return why ? { behavior: "deny", message: why } : { behavior: "allow", updatedInput: input };
    },
    abortController: abort,
    stderr,
  };
  if (step.resume) options.resume = step.resume;
  else options.sessionId = sessionId;
  if (step.model) options.model = step.model;
  if (step.effort) {
    if ((EFFORTS as string[]).includes(step.effort)) options.effort = step.effort as EffortLevel;
    else notes.push(`Claude Code has no effort ${step.effort}, so the model's default stays.`);
  }
  if (step.skills) options.skills = [...step.skills];
  if (step.schema) options.outputFormat = { type: "json_schema", schema: toAnthropicJsonSchema(step.schema) };
  if (step.mcpServers?.length) {
    options.mcpServers = Object.fromEntries(step.mcpServers.map((server) => [server.name, mcpConfig(server)]));
    options.mcpServersDelivery = "initialize";
  }
  // An allow list names the only built-in tools the step has.
  if (allow) {
    options.tools = [...new Set(allow.filter((entry) => !entry.startsWith("mcp__")).map(toolName))];
    options.allowedTools = [...allow];
  }
  if (step.mode) {
    if ((MODES as string[]).includes(step.mode)) {
      options.permissionMode = step.mode as PermissionMode;
      if (step.mode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    } else notes.push(`Claude Code has no permission mode ${step.mode}, so the user's default stays.`);
  }
  return { options, notes };
}

function mcpConfig(server: McpServer): McpServerConfig {
  if (server.type === "http") return { type: "http", url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
  return { type: "stdio", command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}) };
}

/** Auto mode applies when the model's row offers it, or when no row names the model. */
function offersAuto(models: ModelInfo[], model: string | undefined): boolean {
  const wanted = model ?? "default";
  const row = models.find((info) => info.value === wanted || info.resolvedModel === wanted);
  return row === undefined || row.supportsAutoMode === true;
}

function userMessage(step: Step): SDKUserMessage {
  const images = (step.images ?? []).map((image) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: image.mimeType as "image/png", data: image.data },
  }));
  return {
    type: "user",
    message: { role: "user", content: [...(step.note === undefined ? [] : [{ type: "text" as const, text: step.note }]), { type: "text", text: step.prompt }, ...images] },
    parent_tool_use_id: null,
  };
}

/** A frame on the way of a user message that carries a uuid. The SDK's types leave it out. */
interface Lifecycle {
  type: "command_lifecycle";
  command_uuid: string;
  state: "queued" | "started" | "completed" | "cancelled";
}

const LIMIT_ERRORS = new Set(["rate_limit", "billing_error"]);

/** The stop reasons that end a turn without a whole answer. */
const STOPS: Record<string, string> = {
  refusal: "The model refused to answer.",
  max_tokens: "The answer was cut off at the model's output limit (stop reason max_tokens).",
};

export async function runClaude(path: string, step: Step, events: StepEvents = {}): Promise<StepResult> {
  const sessionId = step.resume ?? randomUUID();
  const abort = new AbortController();
  let stderr = "";
  const { options, notes } = claudeOptions(path, step, sessionId, abort, (text) => {
    stderr = (stderr + text).slice(-8000);
  });
  if (step.signal?.aborted) throw new StepFailure("The step was stopped before it started.", { kind: "stopped" }, { notes });
  const stop = () => abort.abort();
  step.signal?.addEventListener("abort", stop, { once: true });

  const history = (entry: Omit<HistoryEntry, "at">) => events.history?.({ ...entry, at: Date.now() });
  history({ role: "user", kind: "text", text: step.prompt });

  // The prompt stays open until the first result, so the SDK keeps answering permission requests
  // and the step's tells reach the turn. The result closes it.
  const tells = new Tells((told) => history({ role: "user", kind: "text", text: told }));
  /** Closes the seam. True when a tell was still unread, so the query must end now. */
  const release = () => {
    const { open, unread } = tells.close();
    if (open) events.steer?.(undefined);
    return unread;
  };
  let started!: (query: Query) => void;
  const ready = new Promise<Query>((resolve) => (started = resolve));
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    // The SDK may ask for the first message before query() returns, so this waits for it.
    const q = await ready;
    if (!step.mode) {
      // "auto" only when the session offers it. Otherwise the user's own default mode stays.
      const models = await q.supportedModels().catch(() => undefined);
      if (models && offersAuto(models, step.model)) await q.setPermissionMode("auto").catch(() => undefined);
    }
    yield userMessage(step);
    yield* tells.messages();
  }

  // Usage per assistant message, since the SDK repeats a message once per content block.
  const perMessage = new Map<string, Usage>();
  let spent = noUsage();
  let finalUsage: Usage | undefined;
  const total = () => finalUsage ?? spent;
  let model = step.model ?? "";
  let opened = false;
  let text = "";
  let limit: { resetAt?: string } | undefined;
  let limitSeen = false;
  let authFailed = false;
  let answer: StepResult | undefined;
  let failure: Failure | undefined;
  let failureText = "";
  let resulted = false;
  let unreadTell = false;

  const fail = (message: string, failure: Failure): never => {
    throw new StepFailure(message, failure, { usage: total(), ...(opened ? { sessionId } : {}), notes });
  };

  let q: Query | undefined;
  try {
    q = query({ prompt: prompt(), options });
    started(q);
    for await (const message of q as AsyncIterable<SDKMessage | Lifecycle>) {
      // The step ends at the first result. A later frame belongs to no turn of this step.
      if (resulted) continue;
      switch (message.type) {
        case "command_lifecycle":
          tells.lifecycle(message.command_uuid, message.state);
          break;
        case "system":
          if (message.subtype === "init") {
            opened = true;
            model = message.model;
            events.session?.(message.session_id);
            events.model?.(message.model);
            const send = tells.open();
            if (send) events.steer?.(send);
          }
          break;
        case "rate_limit_event":
          if (message.rate_limit_info.status === "rejected") {
            const at = message.rate_limit_info.resetsAt;
            limit = at ? { resetAt: new Date(at * 1000).toISOString() } : {};
          }
          break;
        case "assistant": {
          const body = message.message;
          if (message.error && LIMIT_ERRORS.has(message.error)) limitSeen = true;
          if (message.error === "authentication_failed") authFailed = true;
          if (body.model !== "<synthetic>" && body.usage) {
            const u = body.usage;
            perMessage.set(body.id, usage(u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0));
            spent = [...perMessage.values()].reduce(addUsage, noUsage());
            events.usage?.(spent);
          }
          for (const block of body.content ?? []) {
            if (block.type === "text") {
              if (!message.error) text = block.text;
              history({ role: "assistant", kind: message.error ? "error" : "text", text: block.text, ...(message.error ? { isError: true } : {}) });
            } else if (block.type === "tool_use") {
              history({ role: "assistant", kind: "toolCall", text: JSON.stringify(block.input ?? {}), toolName: block.name });
            }
          }
          break;
        }
        case "user": {
          const content = message.message.content;
          if (!Array.isArray(content)) break;
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            const body = typeof block.content === "string" ? block.content : (block.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
            history({ role: "tool", kind: "toolResult", text: body, ...(block.is_error ? { isError: true } : {}) });
          }
          break;
        }
        case "result": {
          const u = message.usage;
          finalUsage = usage(u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, message.total_cost_usd);
          events.usage?.(finalUsage);
          if (message.subtype === "success" && !message.is_error) {
            const said = message.result || text;
            const cut = message.stop_reason ? STOPS[message.stop_reason] : undefined;
            if (cut) {
              // A refused or cut-off answer fails the same way on every try.
              failure = { kind: "failed", retry: false };
              failureText = cut;
            } else if (step.schema && message.structured_output === undefined) {
              failure = { kind: "schema", text: said };
              failureText = "Claude Code gave no value for the schema.";
            } else {
              answer = { sessionId, model, text: said, usage: finalUsage, ...(step.schema ? { value: message.structured_output } : {}), ...(notes.length ? { notes } : {}) };
            }
          } else if (message.subtype === "error_max_structured_output_retries") {
            failure = { kind: "schema", text };
            failureText = "Claude Code could not give a value that fits the schema.";
          } else if (message.subtype === "success") {
            failureText = message.result;
            if (message.api_error_status === 401) authFailed = true;
          } else {
            failureText = message.errors.join("\n");
          }
          tells.consumed(message.user_message_uuids);
          resulted = true;
          // Claude Code would run a tell it never read as a turn of its own, unseen and unpaid
          // for here. Closing the query stops it.
          unreadTell = release();
          break;
        }
      }
      if (unreadTell) break;
    }
  } catch (error) {
    if (!abort.signal.aborted) failureText ||= stderr.trim() || (error instanceof Error ? error.message : String(error));
  } finally {
    release();
    step.signal?.removeEventListener("abort", stop);
    q?.close();
  }

  // A stop after the result keeps the answer.
  if (answer) return answer;
  if (step.signal?.aborted) fail("The step was stopped.", { kind: "stopped" });
  if (failure) fail(failureText, failure);
  if (/No conversation found/i.test(stderr)) fail(`No Claude Code session ${sessionId} to resume.`, { kind: "no_session", sessionId });
  if (limit || limitSeen) fail(failureText || "Claude Code hit its usage limit.", { kind: "usage_limit", ...limit });
  if (authFailed) fail(failureText || "Claude Code is not logged in.", { kind: "auth" });
  return fail(failureText || "Claude Code ended the step without an answer.", { kind: "failed", retry: true });
}

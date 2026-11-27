// One turn on Claude Code. A program is one query() of the Claude Agent SDK, whose prompt stream
// stays open between turns. A turn with hold keeps it for the session's next turn, which sends its
// prompt into the same stream. The SDK takes outputFormat once per query, so a turn whose settings
// differ from the kept program's closes it and resumes the session in a new one.

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
import { addAsked, ASKED_REFUSAL, questionText } from "../ask.js";
import { addUsage, checkStep, noUsage, StepFailure, usage } from "../failure.js";
import { toAnthropicJsonSchema } from "../schema.js";
import { refusal, toolName } from "../tools.js";
import type { Failure, HistoryEntry, McpServer, Step, StepEvents, StepResult, Usage } from "../types.js";
import type { Held, HeldProgram } from "../held.js";
import { claudeEnv, spawnClaude } from "./program.js";
import { Tells } from "./tells.js";

export const MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];
export const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
// The program's own question tool. Only a step with ask has it.
const ASK = "AskUserQuestion";

/** Where the program's question tool reports to the turn that runs now. */
interface Asking {
  record?(question: string): void;
}

/** The SDK options for a step, and the notes on what it could not honor. */
function claudeOptions(path: string, step: Step, sessionId: string, asking: Asking) {
  const notes: string[] = [];
  const allow = step.tools?.allow;
  const deny = step.tools?.deny ?? [];
  const options: Options = {
    pathToClaudeCodeExecutable: path,
    cwd: step.cwd,
    env: claudeEnv(step.account),
    settingSources: ["user", "project", "local"],
    systemPrompt: step.instructions ? { type: "preset", preset: "claude_code", append: step.instructions } : { type: "preset", preset: "claude_code" },
    disallowedTools: [...new Set(step.ask ? deny : [...deny, ASK])],
    canUseTool: async (tool, input) => {
      // The deny with interrupt ends the turn. The person answers in the session later.
      if (tool === ASK && step.ask) {
        asking.record?.(questionText(input));
        return { behavior: "deny", message: ASKED_REFUSAL, interrupt: true };
      }
      const why = tool === ASK ? "Ask the question in your answer instead." : refusal(step.tools, tool);
      return why ? { behavior: "deny", message: why } : { behavior: "allow", updatedInput: input };
    },
  };
  // A fork resumes the session into a new one, which sessionId names.
  if (step.resume) options.resume = step.resume;
  if (step.resume && step.fork) options.forkSession = true;
  if (!step.resume || step.fork) options.sessionId = sessionId;
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
    options.tools = [...new Set([...allow.filter((entry) => !entry.startsWith("mcp__")).map(toolName), ...(step.ask ? [ASK] : [])])];
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

export function mcpConfig(server: McpServer): McpServerConfig {
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

/** An open Claude Code program: one query whose prompt stream waits for each turn's messages. */
export interface ClaudeProgram extends HeldProgram {
  readonly sessionId: string;
  readonly query: Query;
  readonly abort: AbortController;
  readonly notes: string[];
  /** The running turn sets record, since a kept program's canUseTool outlives its first turn. */
  readonly asking: Asking;
  model: string;
  /** The tail of the program's stderr. */
  stderr: string;
  /** Sends a turn's messages into the prompt stream, after the turns before it. */
  send(turn: AsyncIterable<SDKUserMessage>): void;
}

/** The settings a turn must share with a kept program to run in it. */
function claudeFits(path: string, step: Step): string {
  const { cwd, account, model, effort, instructions, schema, tools, skills, mcpServers, mode, ask } = step;
  return JSON.stringify({ path, cwd, account, model, effort, instructions, schema, tools, skills, mcpServers, mode, ask: ask === true });
}

/** Starts Claude Code for a step's session. Its first turn still has to send. */
function openProgram(step: Step, sessionId: string, options: Options, notes: string[], fits: string, asking: Asking): ClaudeProgram {
  const abort = new AbortController();
  const turns: AsyncIterable<SDKUserMessage>[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let child: ReturnType<typeof spawnClaude> | undefined;
  let exited: Promise<void> = Promise.resolve();
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
    while (!ended) {
      const turn = turns.shift();
      if (turn) yield* turn;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  const q = query({
    prompt: prompt(),
    options: {
      ...options,
      abortController: abort,
      spawnClaudeCodeProcess: (spawnOptions) => {
        const spawned = spawnClaude(spawnOptions, (text) => (program.stderr = (program.stderr + text).slice(-8000)));
        exited = new Promise<void>((resolve) => {
          spawned.once("exit", () => resolve());
          spawned.once("error", () => resolve());
        });
        child = spawned;
        return spawned;
      },
    },
  });
  started(q);
  let closing: Promise<void> | undefined;
  const program: ClaudeProgram = {
    fits,
    sessionId,
    query: q,
    abort,
    notes,
    asking,
    model: step.model ?? "",
    stderr: "",
    send(turn) {
      turns.push(turn);
      wake?.();
    },
    alive: () => !ended && !abort.signal.aborted && child !== undefined && child.exitCode === null && child.signalCode === null,
    close() {
      closing ??= (async () => {
        ended = true;
        wake?.();
        q.close();
        // The SDK ends stdin and kills the program after its grace. This waits for it to exit.
        const kill = setTimeout(() => child?.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(kill);
      })();
      return closing;
    },
  };
  return program;
}

export async function runClaude(path: string, step: Step, events: StepEvents, held: Held<ClaudeProgram>): Promise<StepResult> {
  const fits = claudeFits(path, step);
  const asking: Asking = {};
  const { options, notes } = claudeOptions(path, step, step.resume && !step.fork ? step.resume : randomUUID(), asking);
  checkStep(step, notes);
  if (step.signal?.aborted) throw new StepFailure("The step was stopped before it started.", { kind: "stopped" }, { notes });
  // A fork always opens a program of its own, and the resumed session's kept program stays kept.
  const kept = step.fork ? undefined : await held.take(step.resume, fits);
  const program = kept ?? openProgram(step, options.sessionId ?? step.resume!, options, notes, fits, asking);
  const { sessionId, abort } = program;
  program.stderr = "";
  let asked: string | undefined;
  program.asking.record = (question) => (asked = addAsked(asked, question));

  const history = (entry: Omit<HistoryEntry, "at">) => events.history?.({ ...entry, at: Date.now() });
  history({ role: "user", kind: "text", text: step.prompt });

  // The turn's messages stay open until its result, so the SDK keeps answering permission requests
  // and the step's tells reach the turn. The result closes them.
  const tells = new Tells((told) => history({ role: "user", kind: "text", text: told }));
  /** Closes the seam. True when a tell was still unread, so the query must end now. */
  const release = () => {
    const { open, unread } = tells.close();
    if (open) events.steer?.(undefined);
    return unread;
  };
  // A stopped step takes no message, so the seam closes before the query ends.
  const stop = () => {
    release();
    abort.abort();
  };
  step.signal?.addEventListener("abort", stop, { once: true });
  /** The turn has started: names its session and model, and opens the seam. */
  const opening = () => {
    opened = true;
    events.session?.(sessionId);
    events.model?.(program.model);
    const send = tells.open();
    if (send) events.steer?.(send);
    if (heard) delivered();
  };
  /**
   * Claude Code writes the prompt into the session file before its first assistant, user or result
   * frame of the turn. The mark waits until the turn named its session.
   */
  const delivered = () => {
    heard = true;
    if (!opened || marked) return;
    marked = true;
    events.delivered?.();
  };
  program.send(
    (async function* turn(): AsyncGenerator<SDKUserMessage> {
      yield userMessage(step);
      yield* tells.messages();
    })(),
  );

  // Usage per assistant message, since the SDK repeats a message once per content block.
  const perMessage = new Map<string, Usage>();
  let spent = noUsage();
  let finalUsage: Usage | undefined;
  // A turn that sous ends on a question gets a result that counts nothing, though its messages
  // spent tokens. The larger count wins, with the result's cost.
  const total = (): Usage => {
    if (finalUsage === undefined || finalUsage.total >= spent.total) return finalUsage ?? spent;
    return finalUsage.costUsd === undefined ? spent : { ...spent, costUsd: finalUsage.costUsd };
  };
  let opened = false;
  let heard = false;
  let marked = false;
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

  // A kept program sends its init again, but the turn starts as its prompt goes in.
  if (kept) opening();
  try {
    // Frames come by hand, since leaving a for await loop would end the query.
    while (!resulted) {
      const next = await program.query.next();
      if (next.done) break;
      const message = next.value as SDKMessage | Lifecycle;
      if (message.type === "assistant" || message.type === "user" || message.type === "result") delivered();
      switch (message.type) {
        case "command_lifecycle":
          tells.lifecycle(message.command_uuid, message.state);
          break;
        case "system":
          if (message.subtype === "init" && !opened) {
            program.model = message.model;
            opening();
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
          // usage is this turn's own. total_cost_usd runs on across the program's turns, from the
          // cost a resume restored, as it did when each turn resumed in a program of its own.
          const u = message.usage;
          finalUsage = usage(u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, message.total_cost_usd);
          events.usage?.(finalUsage);
          if (asked !== undefined) {
            // sous ended the turn on the question, so the turn answers whatever the subtype says.
            const ok = message.subtype === "success" && !message.is_error;
            const value = ok && step.schema ? message.structured_output : undefined;
            const said = (ok && message.result) || text;
            answer = { sessionId, model: program.model, text: said, usage: total(), asked, ...(value !== undefined ? { value } : {}), ...(notes.length ? { notes } : {}) };
          } else if (message.subtype === "success" && !message.is_error) {
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
              answer = { sessionId, model: program.model, text: said, usage: finalUsage, ...(step.schema ? { value: message.structured_output } : {}), ...(notes.length ? { notes } : {}) };
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
          // for here. Closing the program stops it.
          unreadTell = release();
          break;
        }
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) failureText ||= program.stderr.trim() || (error instanceof Error ? error.message : String(error));
  } finally {
    release();
    step.signal?.removeEventListener("abort", stop);
    program.asking.record = undefined;
    // A held turn that answered, or gave no value for its schema, keeps the program for the
    // step's next turn. Any other end closes it. A turn that asked closes it too, since the person
    // answers in the session by hand, in a program of their own.
    const keep = step.hold && resulted && !unreadTell && !abort.signal.aborted && asked === undefined && (answer !== undefined || failure?.kind === "schema");
    if (keep) await held.keep(sessionId, program);
    else await program.close();
  }

  // A stop after the result keeps the answer.
  if (answer) return answer;
  if (step.signal?.aborted) fail("The step was stopped.", { kind: "stopped" });
  // The question is in the session even when the program ended before its result.
  if (asked !== undefined) return { sessionId, model: program.model, text, usage: total(), asked, ...(notes.length ? { notes } : {}) };
  if (failure) fail(failureText, failure);
  if (/No conversation found/i.test(program.stderr)) {
    const missing = step.resume ?? sessionId;
    fail(`No Claude Code session ${missing} to ${step.fork ? "fork" : "resume"}.`, { kind: "no_session", sessionId: missing });
  }
  if (limit || limitSeen) fail(failureText || "Claude Code hit its usage limit.", { kind: "usage_limit", ...limit });
  if (authFailed) fail(failureText || "Claude Code is not logged in.", { kind: "auth" });
  return fail(failureText || "Claude Code ended the step without an answer.", { kind: "failed", retry: true });
}

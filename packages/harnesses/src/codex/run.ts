// One turn on Codex: one turn/start on a thread of an app-server. A turn with hold keeps the
// server and its thread open for the session's next turn, which then sends only its turn/start.
// A prompt that starts with a slash command Codex has goes to its own method: /goal to
// thread/goal/set, whose turns run until the goal stops, /review, /compact, a skill as a skill
// item, and /prompts:<name> as the prompt file's text.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ASKED_REFUSAL, addAsked, questionText } from "../ask.js";
import { addUsage, checkStep, noUsage, StepFailure } from "../failure.js";
import { toStrictJsonSchema } from "../schema.js";
import { refusal } from "../tools.js";
import type { Held, HeldProgram } from "../held.js";
import type { Failure, HistoryEntry, Step, StepEvents, StepResult } from "../types.js";
import { configuredServers, DEFAULT_MODE, MODES, type Mode, mergeLimits, resetAt, threadConfig, toolNotes, turnUsage } from "./config.js";
import type { AccountRateLimitsUpdatedNotification } from "./generated/v2/AccountRateLimitsUpdatedNotification.js";
import type { CommandExecutionRequestApprovalResponse } from "./generated/v2/CommandExecutionRequestApprovalResponse.js";
import type { ErrorNotification } from "./generated/v2/ErrorNotification.js";
import type { FileChangeRequestApprovalResponse } from "./generated/v2/FileChangeRequestApprovalResponse.js";
import type { ItemCompletedNotification } from "./generated/v2/ItemCompletedNotification.js";
import type { ItemStartedNotification } from "./generated/v2/ItemStartedNotification.js";
import type { McpServerElicitationRequestParams } from "./generated/v2/McpServerElicitationRequestParams.js";
import type { McpServerElicitationRequestResponse } from "./generated/v2/McpServerElicitationRequestResponse.js";
import type { PermissionsRequestApprovalParams } from "./generated/v2/PermissionsRequestApprovalParams.js";
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse.js";
import type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot.js";
import type { ThreadGoalUpdatedNotification } from "./generated/v2/ThreadGoalUpdatedNotification.js";
import type { ThreadTokenUsageUpdatedNotification } from "./generated/v2/ThreadTokenUsageUpdatedNotification.js";
import type { Turn } from "./generated/v2/Turn.js";
import type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification.js";
import type { TurnError } from "./generated/v2/TurnError.js";
import type { UserInput } from "./generated/v2/UserInput.js";
import { codexEnv, codexLogin } from "./program.js";
import { AppServer, RpcError, type ThreadOpened } from "./rpc.js";
import { expandPrompt, goalReport, readSlash, type Slash } from "./slash.js";
import { steerTurn } from "./steer.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

/** Starts an app-server and does the handshake. */
export async function openServer(path: string, env: Record<string, string | undefined>, cwd?: string): Promise<AppServer> {
  const server = new AppServer(path, env, cwd);
  try {
    await server.request("initialize", {
      clientInfo: { name: "sous", title: "sous", version: pkg.version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
  } catch (error) {
    await server.close();
    throw error;
  }
  server.notify("initialized");
  return server;
}

// Codex names a thread it cannot load only in the message text.
const THREAD_ERRORS = ["no rollout found for thread id", "thread not loaded:", "invalid thread id:", "invalid session id:"];
const isThreadError = (error: unknown) => error instanceof Error && THREAD_ERRORS.some((text) => error.message.includes(text));

// Failures that fail the same way again.
const FINAL_ERRORS = new Set(["contextWindowExceeded", "sessionBudgetExceeded", "modelNotFound", "badRequest", "cyberPolicy", "misalignmentPolicyViolation", "inferenceHookDenied", "tooManyDenials"]);

// How long a stop waits for Codex to end the turn before it closes the server.
const STOP_WAIT_MS = 10_000;

/** The turn's input: the note as its own text item, then the prompt, then the images. */
function turnInput(step: Step): UserInput[] {
  return [
    ...(step.note === undefined ? [] : [{ type: "text", text: step.note, text_elements: [] } satisfies UserInput]),
    { type: "text", text: step.prompt, text_elements: [] },
    ...(step.images ?? []).map((image): UserInput => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` })),
  ];
}

/** The params of item/tool/requestUserInput. The generated types leave this experimental request out. */
interface UserInputRequest {
  threadId: string;
  turnId: string;
  questions: { id: string; question: string; options: { label: string }[] | null }[];
}

/**
 * Answers what the server asks during a turn: approvals by the step's tool lists, and questions to
 * a person. A step without ask answers a question with an error. A step with ask hands it to ask,
 * which ends the turn, and refuses it. running holds the tool each MCP server runs now, since an
 * MCP approval names only the server.
 */
function requestHandler(step: Step, history: (entry: Omit<HistoryEntry, "at">) => void, running: Map<string, string>, ask: (request: UserInputRequest) => void) {
  function decline(tool: string, why: string) {
    history({ role: "tool", kind: "toolResult", text: `Declined: ${why}`, toolName: tool, isError: true });
  }

  return function onRequest(method: string, params: unknown): unknown {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const why = refusal(step.tools, "Bash");
        if (why) decline("Bash", why);
        return { decision: why ? "decline" : "accept" } satisfies CommandExecutionRequestApprovalResponse;
      }
      case "item/fileChange/requestApproval": {
        const why = refusal(step.tools, "Edit") ?? refusal(step.tools, "Write");
        if (why) decline("Edit", why);
        return { decision: why ? "decline" : "accept" } satisfies FileChangeRequestApprovalResponse;
      }
      case "item/permissions/requestApproval": {
        // Extra sandbox rights for this turn only. The deny list acts on the actions themselves.
        const { permissions } = params as PermissionsRequestApprovalParams;
        return {
          permissions: { ...(permissions.network ? { network: permissions.network } : {}), ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}) },
          scope: "turn",
        } satisfies PermissionsRequestApprovalResponse;
      }
      case "mcpServer/elicitation/request": {
        const p = params as McpServerElicitationRequestParams;
        const meta = p._meta as { codex_approval_kind?: string } | null;
        // A tool approval runs unless the lists refuse it. A form wants a person, so it is declined.
        if (meta?.codex_approval_kind !== "mcp_tool_call") return { action: "decline", content: null, _meta: null } satisfies McpServerElicitationRequestResponse;
        const tool = `mcp__${p.serverName}__${running.get(p.serverName) ?? ""}`;
        const why = refusal(step.tools, tool);
        if (why) decline(tool, why);
        return { action: why ? "decline" : "accept", content: null, _meta: null } satisfies McpServerElicitationRequestResponse;
      }
      case "item/tool/requestUserInput": {
        if (!step.ask) throw new RpcError("No one answers questions during a step. Ask the question in your answer instead.", -32000);
        const request = params as UserInputRequest;
        ask(request);
        return { answers: Object.fromEntries((request.questions ?? []).map((question) => [question.id, { answers: [ASKED_REFUSAL] }])) };
      }
      case "currentTime/read":
        return { currentTimeAt: Math.floor(Date.now() / 1000) };
      default:
        throw new RpcError(`sous does not answer ${method}.`, -32601);
    }
  };
}

type Item = ItemStartedNotification["item"];
type Log = (entry: Omit<HistoryEntry, "at">) => void;

/** Records a tool call when its item starts. An MCP call also notes the tool its server runs now. */
function itemStarted(item: Item, history: Log, running: Map<string, string>): void {
  if (item.type === "commandExecution") history({ role: "assistant", kind: "toolCall", text: item.command, toolName: "Bash" });
  else if (item.type === "fileChange") history({ role: "assistant", kind: "toolCall", text: item.changes.map((change) => change.path).join("\n"), toolName: "Edit" });
  else if (item.type === "mcpToolCall") {
    running.set(item.server, item.tool);
    history({ role: "assistant", kind: "toolCall", text: JSON.stringify(item.arguments ?? {}), toolName: `mcp__${item.server}__${item.tool}` });
  }
}

/** Records an item that completed, and gives the text of the answer or the review it carries. */
function itemCompleted(item: Item, history: Log, running: Map<string, string>): string | undefined {
  if (item.type === "agentMessage") {
    history({ role: "assistant", kind: "text", text: item.text });
    return item.text;
  }
  if (item.type === "exitedReviewMode") {
    history({ role: "assistant", kind: "text", text: item.review });
    return item.review;
  }
  if (item.type === "commandExecution") {
    const failed = item.status !== "completed" || (item.exitCode !== null && item.exitCode !== 0);
    history({ role: "tool", kind: "toolResult", text: item.aggregatedOutput ?? "", ...(failed ? { isError: true } : {}) });
  } else if (item.type === "fileChange") {
    history({ role: "tool", kind: "toolResult", text: item.status, ...(item.status !== "completed" ? { isError: true } : {}) });
  } else if (item.type === "mcpToolCall") {
    running.delete(item.server);
    const failed = item.error !== null || item.status !== "completed";
    history({ role: "tool", kind: "toolResult", text: JSON.stringify(item.error ?? item.result ?? null), ...(failed ? { isError: true } : {}) });
  }
  return undefined;
}

export async function runCodex(path: string, step: Step, events: StepEvents, held: Held<CodexProgram>): Promise<StepResult> {
  const notes: string[] = [...toolNotes(step)];
  if (step.skills?.length) notes.push(`Codex gets no skills from a step, so ${step.skills.join(", ")} did not reach it.`);
  let mode = MODES[DEFAULT_MODE]!;
  if (step.mode) {
    if (MODES[step.mode]) mode = MODES[step.mode]!;
    else notes.push(`Codex has no mode ${step.mode}, so the step runs in ${DEFAULT_MODE} mode.`);
  }
  checkStep(step, notes);
  if (step.signal?.aborted) throw new StepFailure("The step was stopped before it started.", { kind: "stopped" }, { notes });

  const history = (entry: Omit<HistoryEntry, "at">) => events.history?.({ ...entry, at: Date.now() });
  let threadId: string | undefined;
  let turnId: string | undefined;
  let model = step.model ?? "";
  let text = "";
  let spent = noUsage();
  let lastTotal: number | undefined;
  let lastError: TurnError | undefined;
  const limits = new Map<string, RateLimitSnapshot>();
  // The tool each MCP server runs now, since an MCP approval names only the server.
  const running = new Map<string, string>();

  const slash = readSlash(step.prompt);
  // The command each kind of slash prompt is, as the person typed it.
  const command = slash.kind === "goal-show" ? "/goal" : slash.kind === "goal-clear" ? "/goal clear" : `/${slash.kind}`;
  if (step.note !== undefined && (slash.kind === "compact" || slash.kind === "goal-show" || slash.kind === "goal-clear" || (slash.kind === "review" && slash.instructions === undefined))) {
    notes.push(`Codex's ${command} takes no note, so the note did not reach it.`);
  }
  if (step.images?.length && (slash.kind === "goal" || slash.kind === "goal-show" || slash.kind === "goal-clear" || slash.kind === "compact" || slash.kind === "review")) {
    notes.push(`Codex's ${command} takes no images, so the images did not reach it.`);
  }
  // A goal runs turns until its status leaves active. goalTurn is true while one of them runs.
  const goal = slash.kind === "goal";
  let goalStatus = "active";
  let goalTurn = false;

  // The seam onto the turn, from turn/start to turn/completed or a stop.
  let seam: ReturnType<typeof steerTurn> | undefined;
  // The turn can end before the turn/start reply comes. The seam then never opens.
  let turnEnded = false;
  // A stopped step takes no message, so no seam opens after the stop.
  let stopped = false;
  const closeSeam = () => seam?.close() && events.steer?.(undefined);
  const openSeam = (id: string) => {
    closeSeam();
    if (stopped) return;
    seam = steerTurn({ server: server!, threadId: threadId!, turnId: id, delivered: (told) => history({ role: "user", kind: "text", text: told }), note: (note) => notes.push(note) });
    events.steer?.(seam.send);
  };
  let finish!: (turn: Pick<Turn, "status" | "error">) => void;
  const turnDone = new Promise<Pick<Turn, "status" | "error">>((resolve) => (finish = resolve));

  const fail = (message: string, failure: Failure): never => {
    throw new StepFailure(message, failure, { usage: spent, ...(threadId ? { sessionId: threadId } : {}), notes });
  };

  function onNotification(method: string, params: unknown) {
    switch (method) {
      case "turn/started": {
        const p = params as { threadId: string; turn: Turn };
        if (p.threadId !== threadId) break;
        if (!goal) turnId ??= p.turn.id;
        else {
          // Each turn of a goal has an id and a seam of its own. A turn that starts after a stop,
          // as when the pause came after the turn had ended, gets the interrupt the stop sent.
          turnId = p.turn.id;
          goalTurn = true;
          if (stopped) server?.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          openSeam(turnId);
        }
        break;
      }
      case "thread/goal/updated":
      case "thread/goal/cleared": {
        const p = params as Partial<ThreadGoalUpdatedNotification> & { threadId: string };
        if (!goal || p.threadId !== threadId) break;
        goalStatus = p.goal?.status ?? "cleared";
        // A goal that stops between its turns ends the step with the last turn's answer.
        if (goalStatus !== "active" && !goalTurn) finish({ status: "completed", error: null });
        break;
      }
      case "thread/tokenUsage/updated": {
        const p = params as ThreadTokenUsageUpdatedNotification;
        // A repeat with the same total carries the same response's usage.
        if (p.threadId !== threadId || p.turnId !== turnId || p.tokenUsage.total.totalTokens === lastTotal) break;
        lastTotal = p.tokenUsage.total.totalTokens;
        spent = addUsage(spent, turnUsage(p.tokenUsage.last));
        events.usage?.(spent);
        break;
      }
      case "account/rateLimits/updated": {
        const { rateLimits } = params as AccountRateLimitsUpdatedNotification;
        const id = rateLimits.limitId ?? "codex";
        limits.set(id, mergeLimits(limits.get(id), rateLimits));
        break;
      }
      case "item/started": {
        const { item, threadId: thread } = params as ItemStartedNotification;
        if (thread === threadId) itemStarted(item, history, running);
        break;
      }
      case "item/completed": {
        const { item, threadId: thread } = params as ItemCompletedNotification;
        if (thread === threadId) text = itemCompleted(item, history, running) ?? text;
        break;
      }
      case "error": {
        const p = params as ErrorNotification;
        if (p.threadId !== threadId) break;
        if (!p.willRetry) lastError = p.error;
        history({ role: "assistant", kind: "error", text: p.error.message, isError: true });
        break;
      }
      case "turn/completed": {
        const p = params as TurnCompletedNotification;
        if (p.threadId !== threadId || (turnId && p.turn.id !== turnId)) break;
        goalTurn = false;
        closeSeam();
        // An active goal goes on to its next turn. A turn that failed or stopped ends it.
        if (goal && goalStatus === "active" && p.turn.status === "completed") break;
        turnEnded = true;
        finish(p.turn);
        break;
      }
    }
  }

  // A fork always opens a server of its own, and the resumed thread's kept server stays kept.
  const kept = step.fork ? undefined : await held.take(step.resume, codexFits(path, step));
  let server: AppServer | undefined = kept?.server;
  let stopTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    stopped = true;
    closeSeam();
    if (threadId && turnId) server?.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    if (goal && threadId) {
      // A paused goal starts no turn after this one. Between turns the step ends now.
      server?.request("thread/goal/set", { threadId, status: "paused" }).catch(() => undefined);
      if (!goalTurn) finish({ status: "interrupted", error: null });
    }
    // A stop before turn/start answered runs again after it, with the same deadline.
    stopTimer ??= setTimeout(() => finish({ status: "interrupted", error: null }), STOP_WAIT_MS);
  };
  step.signal?.addEventListener("abort", stop, { once: true });
  history({ role: "user", kind: "text", text: step.prompt });

  // The question the agent asked through requestUserInput, on a step with ask.
  let asked: string | undefined;
  const ask = (request: UserInputRequest) => {
    asked = addAsked(asked, questionText(request));
    history({ role: "assistant", kind: "toolCall", text: questionText(request), toolName: "request_user_input" });
    // The interrupt goes after the refusal, which the server writes once this handler returns.
    setImmediate(() => server?.request("turn/interrupt", { threadId: request.threadId, turnId: request.turnId }).catch(() => undefined));
    stopTimer ??= setTimeout(() => finish({ status: "interrupted", error: null }), STOP_WAIT_MS);
  };

  let turn: Pick<Turn, "status" | "error"> | undefined;
  let answer: StepResult | undefined;
  // What config/read gave that the step could not honor. A kept program brings its own.
  let configNotes: string[] = kept?.notes ?? [];
  try {
    const handlers = { notification: onNotification, request: requestHandler(step, history, running, ask) };
    if (kept) {
      threadId = kept.threadId;
      model = step.model || kept.model;
      kept.server.handlers = handlers;
    } else {
      server = await openServer(path, codexEnv(step.account), step.cwd);
      server.handlers = handlers;
      const opened = await openThread(server, step, mode, (found) => (configNotes = found), fail);
      threadId = opened.thread.id;
      model = opened.model || model;
    }
    notes.push(...configNotes);
    events.session?.(threadId);
    events.model?.(model);
    if (step.signal?.aborted) fail("The step was stopped.", { kind: "stopped" });

    const started = await startWork(server!, step, threadId, mode, slash, fail);
    // The thread holds the prompt once its request has returned.
    events.delivered?.();
    if (started.text !== undefined) {
      // A goal's report or clear runs no turn.
      text = started.text;
      history({ role: "assistant", kind: "text", text });
      finish({ status: "completed", error: null });
    } else if (started.turnId) {
      turnId ??= started.turnId;
      if (!turnEnded) openSeam(turnId);
    }
    if (step.signal?.aborted) stop();
    const exited = server!.exited.then((why): never => {
      throw new RpcError(server?.stderr.trim() || why, -32000);
    });
    turn = await Promise.race([turnDone, exited]);
    // A stop after the turn completed keeps the answer, as on Claude Code.
    if (!step.signal?.aborted || turn.status === "completed") {
      const base = { sessionId: threadId, model, text, usage: spent, ...(asked !== undefined ? { asked } : {}), ...(notes.length ? { notes } : {}) };
      answer = answerOf(base, turn, Boolean(step.schema));
    }
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    if (step.signal?.aborted) fail("The step was stopped.", { kind: "stopped" });
    const message = error instanceof Error ? error.message : String(error);
    const stderr = server?.stderr.trim();
    // A program that exited already has its error output as the message.
    return fail(stderr && !message.includes(stderr) ? `${message}\n${stderr}` : message, { kind: "failed", retry: true });
  } finally {
    closeSeam();
    clearTimeout(stopTimer);
    step.signal?.removeEventListener("abort", stop);
    // A turn that completed keeps its program when it asked to, also when its answer missed the
    // schema, since the repair turn goes on in it. Any other turn closes it. A turn that asked
    // closes it too, since the person answers in the session by hand, in a program of their own.
    const completed = turn?.status === "completed" && !step.signal?.aborted && asked === undefined;
    if (server && threadId && completed && step.hold) {
      await held.keep(threadId, codexProgram(server, threadId, model, configNotes, codexFits(path, step)));
    } else if (server) {
      await shut(server, threadId);
    }
  }

  if (answer) return answer;
  // The try returns or throws unless the turn ended.
  turn = turn!;
  if (turn.status === "interrupted" || step.signal?.aborted) {
    return fail("The step was stopped.", step.signal?.aborted ? { kind: "stopped" } : { kind: "failed", retry: true });
  }
  if (turn.status === "completed") return fail("Codex gave an answer that is not JSON, so it has no value for the schema.", { kind: "schema", text });
  const error = turn.error ?? lastError;
  const info = error?.codexErrorInfo;
  const message = error?.message ?? "Codex ended the turn without an answer.";
  if (info === "usageLimitExceeded") {
    const at = resetAt(limits.values()) ?? (await readReset(path, step));
    return fail(message, { kind: "usage_limit", ...(at ? { resetAt: at } : {}) });
  }
  if (info === "unauthorized") return fail(message, { kind: "auth" });
  return fail(message, { kind: "failed", retry: !(typeof info === "string" && FINAL_ERRORS.has(info)) });
}

/**
 * The step's answer once its turn ended, or none. A turn that asked answers with its question,
 * since sous ended the turn on it, and with a value only when the turn completed with JSON. Any
 * other turn answers only when it completed, and with a schema only when its text is JSON, so a
 * step whose answer is not JSON goes on to the repair.
 */
function answerOf(base: StepResult, turn: Pick<Turn, "status">, schema: boolean): StepResult | undefined {
  const fallback = base.asked !== undefined ? base : undefined;
  if (turn.status !== "completed") return fallback;
  if (!schema) return base;
  try {
    return { ...base, value: JSON.parse(base.text) };
  } catch {
    return fallback;
  }
}

/**
 * Starts the step's work on the thread. A plain prompt, a skill and a prompt file go as a turn, and
 * /review as a review turn: each answers with its turn's id. A goal's turns and a compact turn
 * start by themselves, so their ids come with turn/started. /goal alone and /goal clear run no
 * turn and answer with their text.
 */
async function startWork(server: AppServer, step: Step, threadId: string, mode: Mode, slash: Slash, fail: (message: string, failure: Failure) => never): Promise<{ turnId?: string; text?: string }> {
  const settings = {
    approvalPolicy: mode.approvalPolicy,
    approvalsReviewer: mode.approvalsReviewer,
    sandboxPolicy: mode.sandboxPolicy,
    ...(step.model ? { model: step.model } : {}),
    ...(step.effort ? { effort: step.effort } : {}),
  };
  switch (slash.kind) {
    case "goal-show":
      return { text: goalReport((await server.request("thread/goal/get", { threadId })).goal) };
    case "goal-clear":
      return { text: (await server.request("thread/goal/clear", { threadId })).cleared ? "Goal cleared" : "No goal set" };
    case "goal": {
      // The goal's turns take the thread's settings, so the step's go first. A note goes after
      // the objective, since the goal has no other input.
      await server.request("thread/settings/update", { threadId, ...settings });
      await server.request("thread/goal/set", { threadId, objective: withNote(slash.objective, step.note) });
      return {};
    }
    case "compact":
      await server.request("thread/compact/start", { threadId });
      return {};
    case "review": {
      await server.request("thread/settings/update", { threadId, ...settings });
      // A review's own instructions take the note after them. A review of the changes takes none.
      const target = slash.instructions === undefined ? { type: "uncommittedChanges" as const } : { type: "custom" as const, instructions: withNote(slash.instructions, step.note) };
      return { turnId: (await server.request("review/start", { threadId, target, delivery: "inline" })).turn.id };
    }
    default: {
      const input = await commandInput(server, step, slash, fail);
      const outputSchema = step.schema ? { outputSchema: toStrictJsonSchema(step.schema) as Record<string, never> } : {};
      return { turnId: (await server.request("turn/start", { threadId, input, ...settings, ...outputSchema })).turn.id };
    }
  }
}

/** The text with the note after a blank line, for an input that has no other place for it. */
const withNote = (text: string, note: string | undefined) => (note === undefined ? text : `${text}\n\n${note}`);

/**
 * A turn's input: the prompt as text, a skill as the text "$name" and the skill item, or a prompt
 * file's text. A command that is none of these fails the step.
 */
async function commandInput(server: AppServer, step: Step, slash: Slash, fail: (message: string, failure: Failure) => never): Promise<UserInput[]> {
  if (slash.kind === "prompt") {
    const file = join(codexLogin(codexEnv(step.account)).folder, "prompts", `${slash.name}.md`);
    if (!existsSync(file)) fail(`Codex has no prompt /prompts:${slash.name}, since ${file} does not exist.`, { kind: "failed", retry: false });
    return turnInput({ ...step, prompt: expandPrompt(readFileSync(file, "utf8"), slash.args) });
  }
  if (slash.kind !== "command") return turnInput(step);
  const listed = await server.request("skills/list", { cwds: [step.cwd] });
  const skill = listed.data.flatMap((entry) => entry.skills).find((found) => found.name === slash.name && found.enabled);
  if (!skill) {
    const known = "/goal, /review, /compact, /prompts:<name> and the skills it finds";
    fail(`Codex has no command or skill /${slash.name}. A Codex step runs ${known}.`, { kind: "failed", retry: false });
  }
  // The text names the skill with $, as a person types it in Codex, and the item loads it.
  const said = `$${slash.name}${slash.rest ? ` ${slash.rest}` : ""}`;
  return [...turnInput({ ...step, prompt: said }), { type: "skill", name: skill!.name, path: skill!.path }];
}

/** A Codex app-server a turn kept open, with its thread. */
export interface CodexProgram extends HeldProgram {
  server: AppServer;
  threadId: string;
  /** The model of the turn that kept it. */
  model: string;
  /** What config/read gave that the step could not honor, for each later turn's notes. */
  notes: string[];
}

/**
 * The settings a turn must share with a kept program to run in it. Each turn/start carries its own
 * model, effort and schema, so those stay out.
 */
function codexFits(path: string, step: Step): string {
  return JSON.stringify([path, step.cwd, step.account ?? null, step.instructions ?? null, step.tools ?? null, step.skills ?? null, step.mcpServers ?? null, step.mode ?? null, step.ask === true]);
}

function codexProgram(server: AppServer, threadId: string, model: string, notes: string[], fits: string): CodexProgram {
  return { fits, server, threadId, model, notes, alive: () => server.running, close: () => shut(server, threadId) };
}

/** Leaves the thread and stops the server, and settles once it has exited. */
async function shut(server: AppServer, threadId: string | undefined): Promise<void> {
  if (threadId && server.running) await withTimeout(server.request("thread/unsubscribe", { threadId }), 2000);
  await server.close();
}

/** Reads the config, then starts the step's thread, or resumes or forks its session. */
async function openThread(
  server: AppServer,
  step: Step,
  mode: Mode,
  found: (notes: string[]) => void,
  fail: (message: string, failure: Failure) => never,
): Promise<ThreadOpened> {
  const read = await server.request("config/read", { includeLayers: true, cwd: step.cwd });
  const { config, notes } = threadConfig(step, configuredServers(read));
  found(notes);
  const thread = {
    cwd: step.cwd,
    approvalPolicy: mode.approvalPolicy,
    approvalsReviewer: mode.approvalsReviewer,
    sandbox: mode.sandbox,
    config,
    ...(step.model ? { model: step.model } : {}),
    ...(step.instructions ? { developerInstructions: step.instructions } : {}),
  };
  if (!step.resume) return server.request("thread/start", thread);
  try {
    // A fork answers with the new thread, which starts with the resumed thread's messages.
    if (step.fork) return await server.request("thread/fork", { threadId: step.resume, ...thread });
    return await server.request("thread/resume", { threadId: step.resume, ...thread });
  } catch (error) {
    if (isThreadError(error)) fail(`No Codex thread ${step.resume} to ${step.fork ? "fork" : "resume"}.`, { kind: "no_session", sessionId: step.resume });
    throw error;
  }
}

/** The reset time from account/rateLimits/read, on a fresh server since the step's has closed. */
async function readReset(path: string, step: Step): Promise<string | undefined> {
  let server: AppServer | undefined;
  try {
    server = await openServer(path, codexEnv(step.account), step.cwd);
    const read = await withTimeout(server.request("account/rateLimits/read", undefined), 5000);
    if (!read) return undefined;
    const snapshots = Object.values(read.rateLimitsByLimitId ?? {}).filter((snapshot) => snapshot !== undefined);
    return resetAt(snapshots.length ? snapshots : [read.rateLimits]);
  } catch {
    return undefined;
  } finally {
    await server?.close();
  }
}

/** The promise's value, or undefined after ms or on a failure. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  return Promise.race([promise.catch(() => undefined), late]).finally(() => clearTimeout(timer));
}

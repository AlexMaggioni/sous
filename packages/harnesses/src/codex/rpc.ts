// JSON-RPC with `codex app-server` over stdio: one JSON message per line, without the
// "jsonrpc" field.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { InitializeParams } from "./generated/InitializeParams.js";
import type { InitializeResponse } from "./generated/InitializeResponse.js";
import type { ConfigReadParams } from "./generated/v2/ConfigReadParams.js";
import type { ConfigReadResponse } from "./generated/v2/ConfigReadResponse.js";
import type { GetAccountRateLimitsResponse } from "./generated/v2/GetAccountRateLimitsResponse.js";
import type { ModelListParams } from "./generated/v2/ModelListParams.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadUnsubscribeParams } from "./generated/v2/ThreadUnsubscribeParams.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.js";
import type { TurnSteerResponse } from "./generated/v2/TurnSteerResponse.js";

/** The thread fields the adapter reads from thread/start and thread/resume. */
export interface ThreadOpened {
  thread: { id: string };
  model: string;
}

/** The client requests the adapter sends, with their params and results. */
export interface Methods {
  initialize: [InitializeParams, InitializeResponse];
  "config/read": [ConfigReadParams, ConfigReadResponse];
  "model/list": [ModelListParams, ModelListResponse];
  "thread/start": [ThreadStartParams, ThreadOpened];
  "thread/resume": [ThreadResumeParams, ThreadOpened];
  "turn/start": [TurnStartParams, TurnStartResponse];
  "turn/steer": [TurnSteerParams, TurnSteerResponse];
  "turn/interrupt": [TurnInterruptParams, unknown];
  "thread/unsubscribe": [ThreadUnsubscribeParams, unknown];
  "account/rateLimits/read": [undefined, GetAccountRateLimitsResponse];
}

/** An error answer. data is the server's own detail, such as Codex's codexErrorInfo. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type ErrorAnswer = { code: number; message: string; data?: unknown };

/** What the adapter does with messages the server starts. A request handler's throw becomes an error answer. */
export interface Handlers {
  notification?(method: string, params: unknown): void;
  request?(method: string, params: unknown): unknown;
}

export class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  private buffer = "";
  private ended?: string;
  private exit!: (why: string) => void;
  /** Settles with the reason once the server has exited or failed to start. */
  readonly exited = new Promise<string>((resolve) => (this.exit = resolve));
  /** The end of what the server printed on stderr. */
  stderr = "";
  handlers: Handlers = {};

  constructor(path: string, env: Record<string, string | undefined>, cwd?: string) {
    this.child = spawn(path, ["app-server"], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
    });
    // Writes after the server exits fail with EPIPE. The pending requests already failed.
    this.child.stdin.on("error", () => undefined);
    this.child.on("error", (error) => this.end(`Codex could not start: ${error.message}`));
    this.child.on("exit", (code, signal) => this.end(`Codex app-server exited with ${signal ?? `code ${code}`}.`));
  }

  request<M extends keyof Methods>(method: M, params: Methods[M][0]): Promise<Methods[M][1]> {
    if (this.ended) return Promise.reject(new RpcError(this.ended, -32000));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown) {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /** Whether the server still runs. */
  get running(): boolean {
    return this.ended === undefined;
  }

  /**
   * Stops the server: stdin closes, then SIGTERM if it is still running a second later, and
   * SIGKILL a second after that. Settles once it has exited.
   */
  close(): Promise<void> {
    if (!this.ended) {
      this.child.stdin.end();
      const term = setTimeout(() => this.child.kill("SIGTERM"), 1000);
      const kill = setTimeout(() => this.child.kill("SIGKILL"), 2000);
      term.unref();
      kill.unref();
      void this.exited.then(() => {
        clearTimeout(term);
        clearTimeout(kill);
      });
    }
    return this.exited.then(() => undefined);
  }

  private write(message: object) {
    if (!this.ended) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private end(why: string) {
    if (this.ended) return;
    this.ended = why;
    this.exit(why);
    for (const call of this.pending.values()) call.reject(new RpcError(why, -32000));
    this.pending.clear();
  }

  private read(chunk: string) {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: ErrorAnswer };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.method !== undefined && message.id !== undefined) void this.answer(message.id, message.method, message.params);
      else if (message.method !== undefined) this.handlers.notification?.(message.method, message.params);
      else if (typeof message.id === "number") this.settle(message.id, message.result, message.error);
    }
  }

  private settle(id: number, result: unknown, error?: ErrorAnswer) {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    if (error) call.reject(new RpcError(error.message, error.code, error.data));
    else call.resolve(result);
  }

  private async answer(id: number | string, method: string, params: unknown) {
    try {
      if (!this.handlers.request) throw new RpcError(`The client does not handle ${method}.`, -32601);
      this.write({ id, result: await this.handlers.request(method, params) });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32603;
      this.write({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}

// The one interface the engine runs a step through, on Claude Code or on Codex.

export type HarnessId = "claude" | "codex";

/** The installed program an adapter found, or why it found none. */
export type Found =
  | {
      path: string;
      source: "variable" | "config" | "path" | "usual folder";
      /** Wrapper scripts passed over on the way. */
      skipped: string[];
      /** Other copies further on, which the adapter does not use. */
      others: string[];
    }
  | { problem: string; skipped: string[] };

/** Where an adapter looks for its program. */
export interface FindOptions {
  /** A path the caller's settings give. It comes after the adapter's own variable. */
  path?: string;
  /** Where the caller's settings set path, such as "claudePath in config.json". The messages name it. */
  setting?: string;
  /** The environment the lookup reads. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Looked at after PATH. Default ~/.local/bin, /opt/homebrew/bin and /usr/local/bin. */
  usualDirs?: string[];
}

/**
 * Who the step runs as. The adapter turns it into its program's variables for that step only.
 * A step without an account keeps the caller's environment as it is.
 */
export interface Account {
  /** The program's own folder. Undefined removes the variable, so the program uses its default. */
  folder?: string;
  /** A Claude Code login token. Undefined removes it. Codex ignores it. */
  token?: string;
  /** The token is one of the caller's named logins, so API keys that win over it are removed. */
  named?: boolean;
}

export type McpServer =
  | { name: string; type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; type: "http"; url: string; headers?: Record<string, string> };

/** An image the prompt carries, as base64. */
export interface Image {
  mimeType: string;
  data: string;
}

export interface Step {
  prompt: string;
  images?: Image[];
  cwd: string;
  account?: Account;
  model?: string;
  effort?: string;
  /** Added after the program's own system prompt. */
  instructions?: string;
  /** A JSON Schema the answer must match. */
  schema?: Record<string, unknown>;
  /** Tool names, such as Bash, Bash(git *) or mcp__server__tool. */
  tools?: { allow?: string[]; deny?: string[] };
  /** Undefined leaves the program's own default. */
  skills?: string[];
  /** Each one replaces a configured server of the same name, for this step only. */
  mcpServers?: McpServer[];
  /** Claude: a permission mode. Codex: read-only, workspace-write, agent or agent-full-access. */
  mode?: string;
  /** Continue this session instead of starting one. */
  resume?: string;
  signal?: AbortSignal;
}

/** Tokens the step spent. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cacheRead + cacheWrite, never a context gauge. */
  total: number;
  costUsd?: number;
}

export interface StepResult {
  sessionId: string;
  model: string;
  /** The last answer text. */
  text: string;
  /** The schema's value, when the step gave a schema. */
  value?: unknown;
  usage: Usage;
  /** What the adapter could not honor and did not refuse, such as a deny entry Codex has no form for. */
  notes?: string[];
}

export type Failure =
  | { kind: "usage_limit"; resetAt?: string } // ISO time
  | { kind: "auth" }
  | { kind: "stopped" }
  | { kind: "no_session"; sessionId: string }
  | { kind: "schema"; text: string }
  | { kind: "program"; problem: string }
  | { kind: "failed"; retry: boolean };

/** What run() throws. */
export interface HarnessFailure extends Error {
  failure: Failure;
  usage?: Usage;
  sessionId?: string;
  notes?: string[];
}

export interface HistoryEntry {
  role: "user" | "assistant" | "tool";
  kind: "text" | "toolCall" | "toolResult" | "error";
  text: string;
  toolName?: string;
  isError?: boolean;
  /** Milliseconds since the epoch. */
  at: number;
}

export interface StepEvents {
  session?(sessionId: string): void;
  model?(model: string): void;
  /** The step's running total. */
  usage?(usage: Usage): void;
  history?(entry: HistoryEntry): void;
}

export interface Harness {
  readonly id: HarnessId;
  find(): Found;
  /** The program's version, and a problem when this adapter does not support it. */
  version(path?: string): Promise<{ version?: string; problem?: string }>;
  /** The models the program offers. Calls no model. */
  models(account?: Account): Promise<string[]>;
  run(step: Step, events?: StepEvents): Promise<StepResult>;
  /**
   * The program's login in env, for callers that start no step, such as an account list.
   * variable moves the program's folder, value is what env sets it to, folder is the folder the
   * program uses, and token is a Claude Code login token.
   */
  login(env?: Record<string, string | undefined>): { variable: string; value?: string; folder: string; token?: string };
  /** base with the account's variables set, for the program started outside run(). Default base process.env. */
  env(account: Account | undefined, base?: Record<string, string | undefined>): Record<string, string | undefined>;
}

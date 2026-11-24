// The two drivers: a real Claude Code session through `claude -p`, and a real Codex session
// through `codex exec`. Each turn runs the program once, keeps its whole event stream, and reads
// from it the session id, the shell commands, the final answer and the tokens. A second turn
// resumes the same session.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The real binaries. The `claude` and `codex` on PATH may be shell functions or wrappers.
export const CLAUDE_BIN = process.env.PROOF_CLAUDE_BIN ?? join(homedir(), ".local/bin/claude");
export const CODEX_BIN = process.env.PROOF_CODEX_BIN ?? "/opt/homebrew/bin/codex";

export const DEFAULTS = {
  claude: { model: "sonnet" },
  codex: { model: "gpt-6.1-sol", effort: "medium" },
};

// The shell commands Claude Code may run without a prompt. Writes inside the project are allowed
// by acceptEdits. Everything else is denied, since nobody answers a prompt, and the stream says so.
const CLAUDE_ALLOWED = ["Bash(sous *)", "Bash(git *)", "Bash(cat *)", "Bash(ls *)", "Bash(sleep *)", "Read", "Glob", "Grep"];

// The variables of the session that runs this harness. The driver must not inherit them.
const DROP = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_JOB_DIR|CLAUDE_EFFORT|CLAUDE_PLUGIN_DATA|CLAUDE_PROVIDERS_.*|ANTHROPIC_CUSTOM_.*|CODEX_COMPANION_.*|CODEX_THREAD_ID|CODEX_SESSION_ID|CODEX_SANDBOX.*|SUPERSET_.*|SOUS_.*)$/;

/** The driver's environment: the real HOME and logins, the scratch sous first on PATH. */
export function driverEnv(rep) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!DROP.test(key)) env[key] = value;
  env.PATH = `${rep.bin}:${env.PATH}`;
  // The wrapper sets these too. They also keep any other sous the agent finds off ~/.sous.
  env.SOUS_HOME = rep.home;
  env.SOUS_NOTIFY = "0";
  return env;
}

function claudeArgs(rep, prompt, sessionId, opts) {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", opts.model,
    // No user settings (their hooks, plugins and permission mode) and no MCP servers.
    "--setting-sources", "project,local",
    "--strict-mcp-config",
    "--permission-mode", "acceptEdits",
    "--permission-prompts", "none",
    "--allowedTools", CLAUDE_ALLOWED.join(","),
    // Claude Code's own Workflow tool answers to "run the hello workflow" before sous does.
    "--disallowedTools", "Workflow",
    ...(sessionId ? ["--resume", sessionId] : []),
    "--",
    prompt,
  ];
}

function codexArgs(rep, prompt, sessionId, opts) {
  const common = [
    "--json",
    // No user config: its MCP servers and its high effort stay out. Auth still comes from CODEX_HOME.
    "--ignore-user-config",
    "-m", opts.model,
    "-c", `model_reasoning_effort="${opts.effort}"`,
    "-c", `approval_policy="never"`,
  ];
  if (!sessionId) {
    // workspace-write lets the agent write the project. --add-dir lets sous write its home and
    // the call log, which sit outside the project.
    return ["exec", ...common, "-s", "workspace-write", "--add-dir", rep.state, "-C", rep.project, prompt];
  }
  // `exec resume` takes no -s or --add-dir, so the same sandbox goes through -c.
  return [
    "exec", "resume", ...common,
    "-c", `sandbox_mode="workspace-write"`,
    "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(rep.state)}]`,
    sessionId,
    prompt,
  ];
}

/**
 * Run one turn. Resolves with what the stream says. A turn that outlasts `limitMs` is killed and
 * marked timedOut.
 */
export function runTurn(driver, rep, { prompt, sessionId, turn, limitMs, opts, streamFile, stderrFile }) {
  const bin = driver === "claude" ? CLAUDE_BIN : CODEX_BIN;
  const args = driver === "claude" ? claudeArgs(rep, prompt, sessionId, opts) : codexArgs(rep, prompt, sessionId, opts);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: rep.project, env: driverEnv(rep), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stream = createWriteStream(streamFile);
    const errors = createWriteStream(stderrFile);
    let buffer = "";
    const events = [];
    child.stdout.on("data", (chunk) => {
      stream.write(chunk);
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!text) continue;
        try {
          events.push(JSON.parse(text));
        } catch {
          events.push({ type: "unparsed", text });
        }
      }
    });
    child.stderr.pipe(errors);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 5000);
    }, limitMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      stream.end();
      errors.end();
      const ended = Date.now();
      const parsed = driver === "claude" ? readClaude(events) : readCodex(events);
      resolve({
        turn,
        prompt,
        exit: code,
        timedOut,
        startedAt: new Date(started).toISOString(),
        endedAt: new Date(ended).toISOString(),
        ms: ended - started,
        args: args.map((a) => (a === prompt ? "<prompt>" : a)),
        ...parsed,
        sessionId: parsed.sessionId ?? sessionId,
        commands: parsed.commands.map((c) => ({ ...c, turn })),
      });
    });
  });
}

// ── Claude Code's stream-json ──

function readClaude(events) {
  let sessionId;
  let finalText = "";
  let tokens;
  let costUsd;
  const commands = [];
  const tools = [];
  const byId = new Map();
  const skills = [];
  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") {
      sessionId = e.session_id;
      skills.push(...(e.skills ?? []));
    }
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c.type !== "tool_use") continue;
        tools.push(c.name);
        const command = c.name === "Bash" || c.name === "Monitor" ? c.input?.command : undefined;
        if (typeof command === "string") {
          const entry = { tool: c.name, command, background: Boolean(c.input?.run_in_background) || c.name === "Monitor" };
          commands.push(entry);
          byId.set(c.id, entry);
        }
      }
    }
    if (e.type === "user") {
      for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (c.type !== "tool_result" || !byId.has(c.tool_use_id)) continue;
        const entry = byId.get(c.tool_use_id);
        const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
        entry.error = Boolean(c.is_error);
        entry.output = text.slice(0, 2000);
      }
    }
    if (e.type === "system" && e.subtype === "permission_denied" && byId.has(e.tool_use_id)) byId.get(e.tool_use_id).denied = true;
    if (e.type === "result") {
      sessionId = e.session_id ?? sessionId;
      finalText = typeof e.result === "string" ? e.result : finalText;
      const u = e.usage ?? {};
      const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      tokens = { input, cachedInput: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, total: input + (u.output_tokens ?? 0) };
      costUsd = e.total_cost_usd;
    }
  }
  return { sessionId, finalText, tokens, costUsd, commands, tools, skills };
}

// ── Codex's exec --json ──

/** `/bin/zsh -lc 'sous wait x --json'` becomes `sous wait x --json`. */
function unwrapShell(command) {
  const m = String(command).match(/^\S*\/(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/);
  if (!m) return String(command);
  return m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2];
}

function readCodex(events) {
  let sessionId;
  let finalText = "";
  let tokens;
  const commands = [];
  const tools = [];
  for (const e of events) {
    if (e.type === "thread.started") sessionId = e.thread_id;
    if (e.type === "item.completed" && e.item) {
      const item = e.item;
      tools.push(item.type);
      if (item.type === "command_execution") {
        commands.push({
          tool: "shell",
          command: unwrapShell(item.command),
          background: false,
          exit: item.exit_code,
          error: item.exit_code !== 0,
          denied: item.status === "declined" || item.status === "rejected",
          output: String(item.aggregated_output ?? "").slice(0, 2000),
        });
      }
      if (item.type === "agent_message") finalText = item.text ?? finalText;
    }
    if (e.type === "turn.completed" && e.usage) {
      const u = e.usage;
      const prev = tokens ?? { input: 0, cachedInput: 0, output: 0, total: 0 };
      const input = u.input_tokens ?? 0;
      // reasoning_output_tokens is a part of output_tokens, not an addition.
      const output = u.output_tokens ?? 0;
      tokens = { input: prev.input + input, cachedInput: prev.cachedInput + (u.cached_input_tokens ?? 0), output: prev.output + output, total: prev.total + input + output };
    }
  }
  return { sessionId, finalText, tokens, costUsd: undefined, commands, tools, skills: [] };
}

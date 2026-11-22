// Code steps: sh, js, py, a script file, and wait. The engine runs each one itself, in a child
// process in the step's folder, and never hands it to the steps module. A step fails on a
// non-zero exit, unless it allows that, and on its time limit.
//
// A code step keeps the identity it had when it went through the agent path: its journal entry
// is hashed with the JSON spec as the prompt, "exec" as the model and the result schema below.
// So a run started by older code replays its finished code steps, and editing a step's code
// changes its identity, so a resumed run runs it again.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";

/** The model name a code step records. Old run files hold it, so it stays. */
export const EXEC_MODEL = "exec";

/** The result every code step returns. It is part of the step's identity. */
export const EXEC_RESULT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    code: { type: "number" },
    stdout: { type: "string" },
    stderr: { type: "string" },
    result: {},
  },
  required: ["code"],
});

export type ExecKind = "sh" | "js" | "py" | "file" | "wait";

export interface ExecSpec {
  kind: ExecKind;
  /** sh and wait: the shell command. */
  command?: string;
  /** js and py: the code. It may `return` a value, which becomes `result`. */
  source?: string;
  /** file: the script file, run by its extension (.js .mjs .py .sh, else directly). */
  file?: string;
  args?: string[];
  /** js, py and file: a JSON value the code reads as `input` (stdin for files). */
  input?: unknown;
  cwd?: string;
  env?: Record<string, string>;
  /** sh and file: return a non-zero exit as a result instead of failing the step. */
  allowFail?: boolean;
  /** wait: seconds between two checks. */
  everySeconds?: number;
  /** wait: give up after this many seconds. */
  timeoutSeconds?: number;
}

/** The environment code steps run with. The worker sets it from the run's accounts and secrets. */
export interface CodeStepEnv {
  /** Extra environment, such as secrets. The step's own env wins. */
  env?: Record<string, string>;
  /** The environment the extra one goes on. Default process.env. */
  base?: Record<string, string | undefined>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  result?: unknown;
  checks?: number;
}

export interface ExecContext extends CodeStepEnv {
  /** The run's folder. A step's own cwd resolves against it. */
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const MAX_OUTPUT = 200_000;

// js: the code is the body of an async function with `input` and `require`.
const JS_WRAPPER = `
const fs = require("node:fs");
const raw = fs.readFileSync(process.env.ORC_INPUT_FILE, "utf8");
const input = raw ? JSON.parse(raw) : null;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const body = fs.readFileSync(process.env.ORC_SOURCE_FILE, "utf8");
new AsyncFunction("input", "require", body)(input, require).then(
  (value) => { if (value !== undefined) fs.writeFileSync(process.env.ORC_RESULT, JSON.stringify(value)); },
  (error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); },
);
`;

// py: the code becomes the body of a function with `input`, so it may `return` a value.
const PY_WRAPPER = `
import ast, json, os
with open(os.environ["ORC_INPUT_FILE"]) as f:
    raw = f.read()
input = json.loads(raw) if raw else None
with open(os.environ["ORC_SOURCE_FILE"]) as f:
    tree = ast.parse(f.read())
fn = ast.parse("def __orc_main(input):\\n    pass\\n").body[0]
fn.body = tree.body or [ast.Pass()]
module = ast.Module(body=[fn], type_ignores=[])
ast.fix_missing_locations(module)
scope = {"__name__": "__orc__"}
exec(compile(module, "<step>", "exec"), scope)
value = scope["__orc_main"](input)
if value is not None:
    with open(os.environ["ORC_RESULT"], "w") as f:
        json.dump(value, f)
`;

function stepError(message: string): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
}

function tail(text: string): string {
  return text.length > MAX_OUTPUT ? text.slice(text.length - MAX_OUTPUT) : text;
}

function readResult(file: string): unknown {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface Spawned {
  code: number;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<Spawned> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new WorkflowError("step cancelled", WorkflowErrorCode.AGENT_CANCELLED, { recoverable: false }));
      return;
    }
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // already gone
        }
      }, 3000).unref();
    };
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; killGroup(); }, options.timeoutMs) : undefined;
    const onAbort = () => { cancelled = true; killGroup(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { stdout = tail(stdout + chunk); });
    child.stderr.on("data", (chunk) => { stderr = tail(stderr + chunk); });
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(stepError(`could not start ${command}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (cancelled) return reject(new WorkflowError("step cancelled", WorkflowErrorCode.AGENT_CANCELLED, { recoverable: false }));
      if (timedOut) return reject(stepError(`timed out after ${Math.round(options.timeoutMs! / 1000)}s`));
      resolvePromise({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}

function fileCommand(file: string): { command: string; args: string[] } {
  switch (extname(file)) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return { command: process.execPath, args: [file] };
    case ".py":
      return { command: "python3", args: [file] };
    case ".sh":
      return { command: "bash", args: [file] };
    default:
      return { command: file, args: [] };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolvePromise(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new WorkflowError("step cancelled", WorkflowErrorCode.AGENT_CANCELLED, { recoverable: false })); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runCodeStep(spec: ExecSpec, context: ExecContext): Promise<ExecResult> {
  const cwd = spec.cwd ? (isAbsolute(spec.cwd) ? spec.cwd : resolve(context.cwd, spec.cwd)) : context.cwd;
  if (!existsSync(cwd)) throw stepError(`the step's folder does not exist: ${cwd}`);
  const work = mkdtempSync(join(tmpdir(), "orc-step-"));
  try {
    const resultFile = join(work, "result.json");
    const inputFile = join(work, "input.json");
    const sourceFile = join(work, "source");
    const inputText = spec.input === undefined ? "" : JSON.stringify(spec.input);
    writeFileSync(inputFile, inputText);
    const env: NodeJS.ProcessEnv = {
      ...(context.base ?? process.env),
      ...context.env,
      ...spec.env,
      ORC_RESULT: resultFile,
      ORC_INPUT_FILE: inputFile,
      ORC_SOURCE_FILE: sourceFile,
    };
    const base = { cwd, env, signal: context.signal, timeoutMs: context.timeoutMs };

    let spawned: Spawned;
    let checks: number | undefined;
    switch (spec.kind) {
      case "sh":
        spawned = await runProcess("bash", ["-c", spec.command ?? ""], base);
        break;
      case "js":
        writeFileSync(sourceFile, spec.source ?? "");
        spawned = await runProcess(process.execPath, ["-e", JS_WRAPPER], base);
        break;
      case "py":
        writeFileSync(sourceFile, spec.source ?? "");
        spawned = await runProcess("python3", ["-c", PY_WRAPPER], base);
        break;
      case "file": {
        const file = isAbsolute(spec.file ?? "") ? spec.file! : resolve(cwd, spec.file ?? "");
        if (!existsSync(file)) throw stepError(`script file not found: ${file}`);
        const { command, args } = fileCommand(file);
        spawned = await runProcess(command, [...args, ...(spec.args ?? [])], { ...base, stdin: inputText });
        break;
      }
      case "wait": {
        const everyMs = Math.max(1, spec.everySeconds ?? 60) * 1000;
        const deadline = spec.timeoutSeconds ? Date.now() + spec.timeoutSeconds * 1000 : undefined;
        checks = 0;
        for (;;) {
          checks++;
          spawned = await runProcess("bash", ["-c", spec.command ?? ""], { ...base, timeoutMs: undefined });
          if (spawned.code === 0) break;
          if (deadline !== undefined && Date.now() + everyMs > deadline) {
            throw stepError(`still not true after ${spec.timeoutSeconds}s (${checks} checks): ${spec.command}`);
          }
          await sleep(everyMs, context.signal);
        }
        break;
      }
      default:
        throw new WorkflowError(`unknown code step kind: ${String((spec as { kind?: unknown }).kind)}`, WorkflowErrorCode.INVALID_ARGUMENT, { recoverable: false });
    }

    const result = readResult(resultFile);
    const out: ExecResult = {
      code: spawned.code,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
      ...(result === undefined ? {} : { result }),
      ...(checks === undefined ? {} : { checks }),
    };
    if (spawned.code !== 0 && !spec.allowFail) {
      const detail = (spawned.stderr.trim() || spawned.stdout.trim()).split("\n").slice(-5).join("\n");
      throw stepError(`exited with code ${spawned.code}${detail ? `: ${detail}` : ""}`);
    }
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

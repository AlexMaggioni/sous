// A workflow's inputs, outputs and description live in its meta:
//
//   export const meta = {
//     name: "ticket",
//     description: "Implement a ticket, review it, verify it",
//     inputs: { ticket: { type: "string", description: "What to build", required: true },
//               tries: { type: "number", default: 3 } },
//     outputs: { summary: "What was built" },
//     place: "worktree",
//     concurrency: 2,
//     startedBy: "people",   // or "anyone", the default: agents may start it too
//     timeout: "2h",          // the running steps stop and the run pauses after this long
//     schedule: "0 9 * * 1-5", // the service starts it on this cron; or { cron, inputs }
//   }
//
// `orc run ticket --ticket "Add a --json flag"` turns the flags into the run's args.

import type { Place } from "./home.js";
import { parseDurationSeconds } from "@orchestrator/engine";
import { parseCron } from "./cron.js";
import { isPlace } from "./places.js";

export interface InputSpec {
  type?: "string" | "number" | "boolean" | "json";
  description?: string;
  required?: boolean;
  default?: unknown;
  choices?: unknown[];
}

export interface WorkflowExtras {
  description?: string;
  inputs: Record<string, InputSpec>;
  outputs?: Record<string, unknown>;
  place?: Place;
  concurrency?: number;
  /** "people" keeps agents from starting it. */
  startedBy: "anyone" | "people";
  /** The time limit on a run of it, as written, such as "2h". */
  timeout?: string;
  /** The cron the service starts it on, with the inputs of those runs. Without it, people and
   *  agents start it. */
  schedule?: { cron: string; inputs: Record<string, unknown> };
  /** What is wrong in the meta itself. */
  metaProblems?: string[];
}

export function workflowExtras(meta: Record<string, unknown>): WorkflowExtras {
  const inputs: Record<string, InputSpec> = {};
  const rawInputs = meta.inputs;
  if (Array.isArray(rawInputs)) {
    for (const name of rawInputs) if (typeof name === "string") inputs[name] = { type: "string", required: true };
  } else if (rawInputs && typeof rawInputs === "object") {
    for (const [name, spec] of Object.entries(rawInputs as Record<string, unknown>)) {
      inputs[name] = typeof spec === "string" ? { type: "string", description: spec, required: true } : (spec as InputSpec);
    }
  }
  const extras: WorkflowExtras = {
    ...(typeof meta.description === "string" ? { description: meta.description } : {}),
    inputs,
    ...(meta.outputs && typeof meta.outputs === "object" ? { outputs: meta.outputs as Record<string, unknown> } : {}),
    ...(isPlace(meta.place) ? { place: meta.place } : {}),
    ...(typeof meta.concurrency === "number" && meta.concurrency > 0 ? { concurrency: Math.floor(meta.concurrency) } : {}),
    startedBy: meta.startedBy === "people" ? "people" : "anyone",
  };
  const problems: string[] = [];
  const timeout = timeoutOf(meta.timeout);
  if (timeout.timeout) extras.timeout = timeout.timeout;
  if (timeout.problem) problems.push(timeout.problem);
  const schedule = scheduleOf(meta.schedule);
  if (schedule.problem) problems.push(schedule.problem);
  if (schedule.schedule) {
    extras.schedule = schedule.schedule;
    for (const problem of checkInputs(extras, schedule.schedule.inputs).problems) problems.push(`meta.schedule.inputs: ${problem.replace(/--/g, "")}`);
  }
  if (problems.length) extras.metaProblems = problems;
  return extras;
}

function scheduleOf(value: unknown): { schedule?: WorkflowExtras["schedule"]; problem?: string } {
  if (value === undefined) return {};
  const shape = 'meta.schedule must be a cron such as "0 9 * * 1-5", or { cron: "0 9 * * 1-5", inputs: { ... } }';
  const raw = typeof value === "string" ? { cron: value, inputs: {} } : value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  if (!raw || typeof raw.cron !== "string") return { problem: `${shape}, got ${JSON.stringify(value)}` };
  const inputs = raw.inputs ?? {};
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return { problem: `meta.schedule.inputs must be an object of input values` };
  try {
    parseCron(raw.cron);
  } catch (error) {
    return { problem: `meta.schedule: ${(error as Error).message}` };
  }
  return { schedule: { cron: raw.cron.trim(), inputs: inputs as Record<string, unknown> } };
}

function timeoutOf(value: unknown): { timeout?: string; problem?: string } {
  if (value === undefined) return {};
  if (parseDurationSeconds(value) === undefined) {
    return { problem: `meta.timeout must be a time such as "90s", "10m" or "2h", got ${JSON.stringify(value)}` };
  }
  return { timeout: typeof value === "number" ? `${value}s` : String(value).trim() };
}

function coerce(name: string, spec: InputSpec, value: unknown): unknown {
  const type = spec.type ?? "string";
  if (type === "string") return typeof value === "string" ? value : JSON.stringify(value);
  if (type === "number") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error(`--${name} must be a number, got "${String(value)}"`);
    return number;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const text = String(value).toLowerCase();
    if (["true", "yes", "1", ""].includes(text)) return true;
    if (["false", "no", "0"].includes(text)) return false;
    throw new Error(`--${name} must be true or false, got "${String(value)}"`);
  }
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`--${name} must be JSON, got "${value}"`);
  }
}

/**
 * Check the given values against the workflow's inputs. Fills defaults, converts types and
 * lists every problem at once. A workflow with no declared inputs takes any values.
 */
export function checkInputs(extras: WorkflowExtras, given: Record<string, unknown>): { args: Record<string, unknown>; problems: string[] } {
  const declared = Object.keys(extras.inputs);
  if (declared.length === 0) return { args: { ...given }, problems: [] };
  const args: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [name, value] of Object.entries(given)) {
    const spec = extras.inputs[name];
    if (!spec) {
      problems.push(`unknown input --${name}. This workflow takes: ${declared.map((d) => `--${d}`).join(", ")}`);
      continue;
    }
    try {
      args[name] = coerce(name, spec, value);
      if (spec.choices && !spec.choices.includes(args[name])) problems.push(`--${name} must be one of: ${spec.choices.join(", ")}`);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  for (const [name, spec] of Object.entries(extras.inputs)) {
    if (name in args) continue;
    if (spec.default !== undefined) args[name] = spec.default;
    else if (spec.required !== false) problems.push(`missing input --${name}${spec.description ? ` (${spec.description})` : ""}`);
  }
  return { args, problems };
}

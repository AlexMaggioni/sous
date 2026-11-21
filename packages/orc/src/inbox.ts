// Questions a run waits on: ask(), breakpoint() and an agent's question. Each is a file in
// inbox/. The answer is a second file next to it. A question's id stays the same when the
// run pauses and resumes, so an answer given while the run was paused is used on resume.

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HomePaths } from "./home.js";

export interface Question {
  id: string;
  /** The root run, the one `orc list` shows. */
  runId: string;
  /** The run that asks: the root run or a nested one. */
  scope: string;
  callIndex: number;
  hash: string;
  workflow: string;
  prompt: string;
  kind: "confirm" | "input" | "select";
  choices?: string[];
  /** A breakpoint expects approve, stop, or send back with a note. */
  breakpoint: boolean;
  askedAt: string;
}

export interface Answer {
  hash: string;
  value: unknown;
  answeredAt: string;
}

export function questionId(scope: string, callIndex: number): string {
  return `${scope}--${callIndex}`;
}

function writeAtomic(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeQuestion(paths: HomePaths, question: Question): void {
  writeAtomic(join(paths.inbox, `${question.id}.json`), question);
}

export function readQuestion(paths: HomePaths, id: string): Question | undefined {
  return readJson<Question>(join(paths.inbox, `${id}.json`));
}

export function readAnswer(paths: HomePaths, id: string): Answer | undefined {
  return readJson<Answer>(join(paths.inbox, `${id}.answer.json`));
}

export function writeAnswer(paths: HomePaths, question: Question, value: unknown): void {
  writeAtomic(join(paths.inbox, `${question.id}.answer.json`), { hash: question.hash, value, answeredAt: new Date().toISOString() } satisfies Answer);
}

export function removeQuestion(paths: HomePaths, id: string): void {
  for (const name of [`${id}.json`, `${id}.answer.json`]) {
    try {
      unlinkSync(join(paths.inbox, name));
    } catch {
      // already gone
    }
  }
}

/** Open questions, oldest first, optionally for one run. Answered ones are left out. */
export function listQuestions(paths: HomePaths, runId?: string): Question[] {
  if (!existsSync(paths.inbox)) return [];
  const out: Question[] = [];
  for (const name of readdirSync(paths.inbox)) {
    if (!name.endsWith(".json") || name.endsWith(".answer.json")) continue;
    const question = readJson<Question>(join(paths.inbox, name));
    if (!question || (runId && question.runId !== runId)) continue;
    if (readAnswer(paths, question.id)?.hash === question.hash) continue;
    out.push(question);
  }
  return out.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}

export function removeRunQuestions(paths: HomePaths, runId: string): void {
  for (const question of listQuestions(paths, runId)) removeQuestion(paths, question.id);
}

/**
 * Check an answer against the question. A choice must be one of the listed choices, in any
 * case. A breakpoint takes approve, stop, or send back with a note.
 */
export function normalizeAnswer(question: Question, raw: unknown): unknown {
  if (question.kind === "select" && question.choices?.length) {
    const text = String(raw).trim();
    const choice = question.choices.find((c) => c.toLowerCase() === text.toLowerCase());
    if (!choice) throw new Error(`answer one of: ${question.choices.join(", ")}`);
    return choice;
  }
  if (question.kind === "confirm") {
    if (typeof raw === "boolean") return raw;
    const text = String(raw).trim().toLowerCase();
    if (["yes", "y", "true", "approve", "ok"].includes(text)) return true;
    if (["no", "n", "false", "stop"].includes(text)) return false;
    throw new Error("answer yes or no");
  }
  return raw;
}

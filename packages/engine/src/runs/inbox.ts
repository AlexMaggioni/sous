// Questions a run waits on: ask(), breakpoint() and an agent's question. Each is a file in
// inbox/. The answer is a second file next to it. A question's id stays the same when the
// run pauses and resumes, so an answer given while the run was paused is used on resume.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { HomePaths } from "./home.js";
import { answerFile, questionFile, questionFiles } from "./store.js";

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
  writeAtomic(questionFile(paths, question.id), question);
}

export function readQuestion(paths: HomePaths, id: string): Question | undefined {
  return readJson<Question>(questionFile(paths, id));
}

export function readAnswer(paths: HomePaths, id: string): Answer | undefined {
  return readJson<Answer>(answerFile(paths, id));
}

export function writeAnswer(paths: HomePaths, question: Question, value: unknown): void {
  writeAtomic(answerFile(paths, question.id), { hash: question.hash, value, answeredAt: new Date().toISOString() } satisfies Answer);
}

export function removeQuestion(paths: HomePaths, id: string): void {
  for (const file of [questionFile(paths, id), answerFile(paths, id)]) {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
}

/** Open questions, oldest first, optionally for one run. Answered ones are left out. */
export function listQuestions(paths: HomePaths, runId?: string): Question[] {
  const out: Question[] = [];
  for (const file of questionFiles(paths)) {
    const question = readJson<Question>(file);
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

/** What a person decides at a breakpoint. */
export interface Decision {
  decision: "approve" | "send back" | "stop";
  note?: string;
}

/** The words that approve a breakpoint, trimmed and in lower case. */
const APPROVE = ["approve", "yes", ""];
/** "send back: shorter" and "send-back shorter" both send the step back with "shorter". */
const SEND_BACK = /^send[ -]back\s*:?\s*/i;

/** A reply to a breakpoint: approve, stop, or a note that sends the work back. A typed "ok" approves too. */
export function breakpointValue(reply: string): unknown {
  const lower = reply.trim().toLowerCase();
  if (APPROVE.includes(lower) || lower === "ok") return "approve";
  if (lower === "stop") return "stop";
  return { decision: "send back", note: reply.replace(SEND_BACK, "").trim() };
}

/**
 * Read a breakpoint's answer as a decision. It reads what breakpointValue writes, the answer
 * files of older runs, and what a library caller's confirm returns: a decision object, true,
 * false, or text. Anything else approves.
 */
export function decisionOf(answer: unknown): Decision {
  if (answer && typeof answer === "object") {
    const record = answer as { decision?: unknown; note?: unknown };
    const decision = String(record.decision ?? "").toLowerCase();
    const note = typeof record.note === "string" && record.note.trim() ? record.note.trim() : undefined;
    if (decision === "approve" || decision === "stop") return { decision, ...(note ? { note } : {}) };
    if (decision === "send back" || decision === "send-back") return { decision: "send back", ...(note ? { note } : {}) };
  }
  if (answer === true) return { decision: "approve" };
  if (answer === false) return { decision: "stop" };
  const text = typeof answer === "string" ? answer.trim() : "";
  const lower = text.toLowerCase();
  if (APPROVE.includes(lower)) return { decision: "approve" };
  if (lower === "stop") return { decision: "stop" };
  const note = text.replace(SEND_BACK, "").trim();
  return { decision: "send back", ...(note ? { note } : {}) };
}

export type AnswerKind = "answer" | "approve" | "send-back";

/** The value a reply gives a question, or what is wrong with the command when it does not fit. */
export function answerValue(question: Question, kind: AnswerKind, text: string, json = false): { value: unknown } | { usage: string } {
  if (kind === "approve") return { value: question.breakpoint ? "approve" : question.kind === "confirm" ? true : "approve" };
  if (kind === "send-back") {
    if (!question.breakpoint) return { usage: `${question.id} is not a breakpoint. Use orc answer ${question.id} "..."` };
    if (!text) return { usage: `orc send-back ${question.id} "what to change"` };
    return { value: { decision: "send back", note: text } };
  }
  if (!text && question.kind !== "confirm") return { usage: `orc answer ${question.id} "your answer"` };
  const value = question.breakpoint ? breakpointValue(text) : json ? parseJson(text) : normalizeAnswer(question, text);
  if (question.kind === "select" && question.choices && !question.choices.includes(value as string)) {
    return { usage: `answer one of: ${question.choices.join(", ")}` };
  }
  return { value };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

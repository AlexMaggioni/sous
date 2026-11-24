// Questions a run waits on: ask(), breakpoint() and an agent's question. Each is a file in
// inbox/. The answer is a second file next to it. A question's id stays the same when the
// run pauses and resumes, so an answer given while the run was paused is used on resume.

import { unlinkSync } from "node:fs";
import { readJsonFile, writeJsonFile } from "../json-file.js";
import type { By, Through, Who } from "./actions.js";
import { answerCommand, answeredByFor, authorAnsweredBy, type Tried } from "./consent.js";
import type { HomePaths } from "./home.js";
import type { RunRecord } from "./records.js";
import { answerFile, questionFile, questionFiles } from "./store.js";

export interface Question {
  id: string;
  /** The root run, the one `sous list` shows. */
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
  /** Who may answer, as the author said: people, or anyone, an agent too. A breakpoint is always
   *  for people. sous writes it on each question and fills it when it reads an older file, so
   *  only a question built by hand lacks it, and then it is for people. */
  answeredBy?: "people" | "anyone";
  /** The label of the agent step that asks, for an agent's question. */
  step?: string;
  askedAt: string;
}

export interface Answer {
  hash: string;
  value: unknown;
  answeredAt: string;
  /** Who answered and through what. An answer written before these fields has neither. */
  by?: By;
  through?: Through;
}

export function questionId(scope: string, callIndex: number): string {
  return `${scope}--${callIndex}`;
}

function writeQuestion(paths: HomePaths, question: Question): void {
  writeJsonFile(questionFile(paths, question.id), question);
}

/** A question file as it reads today: an old file, or a breakpoint that says anyone, is for people. */
function asRead(question: Question | undefined): Question | undefined {
  if (!question) return question;
  return { ...question, answeredBy: authorAnsweredBy(question) };
}

export function readQuestion(paths: HomePaths, id: string): Question | undefined {
  return asRead(readJsonFile<Question>(questionFile(paths, id)));
}

function readAnswer(paths: HomePaths, id: string): Answer | undefined {
  return readJsonFile<Answer>(answerFile(paths, id));
}

export function writeAnswer(paths: HomePaths, question: Question, value: unknown, who?: Who): void {
  const answer: Answer = { hash: question.hash, value, answeredAt: new Date().toISOString(), ...(who ? { by: who.by, through: who.through } : {}) };
  writeJsonFile(answerFile(paths, question.id), answer);
}

function removeQuestion(paths: HomePaths, id: string): void {
  for (const file of [questionFile(paths, id), answerFile(paths, id)]) {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
}

export interface AskOptions {
  /** Stops the wait. */
  signal: AbortSignal;
  /** How often to look for the answer, in ms. */
  pollMs: number;
  /** Runs once the question is written, before the wait. An answer given before the question skips it. */
  asked?: () => void;
}

/**
 * Ask a question and wait for its answer. An answer given while the run was paused is taken at
 * once, and the question is not written again. Only an answer with the question's hash counts,
 * and taking it removes both files. A stop of the wait rejects with "stopped waiting" and leaves
 * the files, so a paused run still asks.
 */
export function ask(paths: HomePaths, question: Question, options: AskOptions): Promise<unknown> {
  const take = (): { value: unknown } | undefined => {
    const answer = readAnswer(paths, question.id);
    if (!answer || answer.hash !== question.hash) return undefined;
    removeQuestion(paths, question.id);
    return { value: answer.value };
  };
  return new Promise((resolve, reject) => {
    const early = take();
    if (early) return resolve(early.value);
    if (options.signal.aborted) return reject(new Error("stopped waiting"));
    writeQuestion(paths, question);
    options.asked?.();
    const stop = () => {
      clearInterval(timer);
      reject(new Error("stopped waiting"));
    };
    const timer = setInterval(() => {
      const taken = take();
      if (!taken) return;
      clearInterval(timer);
      options.signal.removeEventListener("abort", stop);
      resolve(taken.value);
    }, options.pollMs);
    options.signal.addEventListener("abort", stop, { once: true });
  });
}

/** The answer a dry run gives a question: approve, yes, the first choice, or a stand-in text. */
export function standIn(question: Pick<Question, "kind" | "choices" | "breakpoint">): unknown {
  if (question.breakpoint) return "approve";
  if (question.kind === "select") return question.choices?.[0] ?? "";
  if (question.kind === "input") return "stand-in answer";
  return true;
}

/** Open questions, oldest first, optionally for one run. Answered ones are left out. */
export function listQuestions(paths: HomePaths, runId?: string): Question[] {
  const out: Question[] = [];
  for (const file of questionFiles(paths)) {
    const question = asRead(readJsonFile<Question>(file));
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
function normalizeAnswer(question: Question, raw: unknown): unknown {
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

/** The decision a reply makes at a breakpoint: approve, send-back with its note, or an answer
 *  read as breakpointValue reads it. */
export function triedOf(typed: Pick<Reply, "via" | "text">): Tried {
  if (typed.via === "approve") return { decision: "approve" };
  if (typed.via === "send-back") return { decision: "send back", note: typed.text };
  const value = breakpointValue(typed.text);
  if (value === "approve" || value === "stop") return { decision: value };
  return { decision: "send back", note: decisionOf(value).note ?? "" };
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

/** What a person typed to answer a question: after sous answer, sous approve or sous send-back and
 *  the question's id, or at the prompt of sous wait in a terminal. */
export interface Reply {
  via: "answer" | "approve" | "send-back" | "prompt";
  text: string;
  /** sous answer --value-json: the text is JSON. */
  valueJson?: boolean;
}

/**
 * Answer a question with what a person typed. It writes the answer, or says that the reply stops
 * the run, or what is wrong with the command. "stop" at a breakpoint stops the run, from sous
 * answer as from the prompt. A choice that is not listed, or a confirm that is not yes or no,
 * throws. A reply typed at a prompt counts only while the question's file is there.
 */
export function reply(paths: HomePaths, question: Question, typed: Reply, who?: Who): Answered | { stop: true } | Misfit | { gone: true } {
  if (typed.via === "prompt" && !readQuestion(paths, question.id)) return { gone: true };
  const meaning = meaningOf(question, typed);
  if (!("value" in meaning)) return meaning;
  writeAnswer(paths, question, meaning.value, who);
  return meaning.notJson ? { answered: true, value: meaning.value, notJson: true } : { answered: true, value: meaning.value };
}

/** A written answer and its value. `notJson` says that --value-json was given, the text did not parse, and the
 *  answer went as text. */
export interface Answered {
  answered: true;
  /** The value written. */
  value: unknown;
  notJson?: true;
}

/** What is wrong with a command's answer. `choices` lists what the question takes, when the
 *  answer is not one of its choices. */
export interface Misfit {
  usage: string;
  choices?: string[];
}

/** The choices a question takes, for a select or a confirm. */
function choicesOf(question: Question): string[] {
  return question.kind === "confirm" ? ["yes", "no"] : (question.choices ?? []);
}

/** The answer a reply gives, a stop, or what is wrong with the command. */
function meaningOf(question: Question, { via, text, valueJson }: Reply): { value: unknown; notJson?: true } | { stop: true } | Misfit {
  if (via === "prompt") {
    const typed = text.trim();
    if (!question.breakpoint) return { value: normalizeAnswer(question, typed) };
    const value = breakpointValue(typed);
    return value === "stop" ? { stop: true } : { value };
  }
  if (via === "approve") return { value: question.kind === "confirm" && !question.breakpoint ? true : "approve" };
  if (via === "send-back") {
    if (!question.breakpoint) return { usage: `${question.id} is not a breakpoint. Use sous answer ${question.id} "..."` };
    if (!text) return { usage: `sous send-back ${question.id} "what to change"` };
    return { value: { decision: "send back", note: text } };
  }
  if (!text && question.kind !== "confirm") return { usage: `sous answer ${question.id} "your answer"` };
  let value: unknown;
  let notJson = false;
  if (question.breakpoint) value = breakpointValue(text);
  else if (valueJson) {
    const parsed = parseJson(text);
    value = parsed.ok ? parsed.value : text;
    notJson = !parsed.ok;
  } else {
    try {
      value = normalizeAnswer(question, text);
    } catch (error) {
      return { usage: (error as Error).message, choices: choicesOf(question) };
    }
  }
  if (question.breakpoint && value === "stop") return { stop: true };
  if (question.kind === "select" && question.choices && !question.choices.includes(value as string)) {
    return { usage: `answer one of: ${question.choices.join(", ")}`, choices: question.choices };
  }
  return notJson ? { value, notJson: true } : { value };
}

/** A question as a reply shows it, with who may answer it as it stands for its run. */
export interface QuestionView {
  id: string;
  step?: string;
  prompt: string;
  kind: Question["kind"];
  choices?: string[];
  breakpoint: boolean;
  askedAt: string;
  answeredBy: "people" | "anyone";
}

/** The view of a question, for its root run's record: one started with --let-agent-answer or not. */
export function questionView(question: Question, record?: Pick<RunRecord, "letAgentAnswer">): QuestionView {
  const { id, step, prompt, kind, choices, breakpoint, askedAt } = question;
  return { id, ...(step ? { step } : {}), prompt, kind, ...(choices ? { choices } : {}), breakpoint, askedAt, answeredBy: answeredByFor(question, record) };
}

/**
 * How to answer a question. "sous" gives the commands that sous inbox, show and wait print.
 * "log" gives the commands the run's log prints, which leave out yes or no and the choices.
 * "prompt" gives what the prompt of sous wait takes.
 */
export function hint(question: Question, where: "sous" | "log" | "prompt" = "sous"): string {
  if (where === "prompt") {
    if (question.breakpoint) return "approve, stop, or a note to send back";
    if (question.kind === "confirm") return "yes or no";
    if (question.kind === "select") return (question.choices ?? []).join(" / ");
    return "your answer";
  }
  if (question.breakpoint) return `${answerCommand(question, "approve")}  |  ${answerCommand(question, "send-back", '"note"')}  |  sous stop ${question.runId}`;
  if (where === "log") return answerCommand(question, "answer", '"..."');
  if (question.kind === "confirm") return answerCommand(question, "answer", "yes|no");
  if (question.kind === "select") return answerCommand(question, "answer", `<one of: ${(question.choices ?? []).join(", ")}>`);
  return answerCommand(question, "answer", '"..."');
}

/** The value the text holds as JSON, or ok false when it is not JSON. */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// The calls that come next after sous wait and sous show, from where the run is.

import { answerCalls, type Failure, type RunQuestion, type Who } from "@sous/engine";
import type { Next } from "../reply.js";

/** Where a run is, as wait and show give it. */
interface RunAt {
  runId: string;
  status: string;
  /** The questions as a reply shows them, with who may answer each as it stands for the run. */
  questions?: ReadonlyArray<Pick<RunQuestion, "id" | "kind" | "choices" | "breakpoint" | "prompt" | "answeredBy">>;
  failure?: Failure;
  /** When the service resumes a run paused at a usage limit. */
  resumesAt?: string;
}

/** The call that waits for a run, in JSON, with the --timeout of the wait before it. */
export const waitNext = (runId: string, does: string, timeout?: number): Next => ({ call: `sous wait ${runId}${timeout ? ` --timeout ${timeout}` : ""} --json`, does });

/** The call that resumes a run, in JSON. */
export const resumeNext = (runId: string, does: string): Next => ({ call: `sous resume ${runId} --json`, does });

/** The call that starts a run's workflow again with the same inputs, in JSON. */
export const rerunNext = (runId: string, does: string): Next => ({ call: `sous rerun ${runId} --json`, does });

/** A step label as one shell word, in single quotes when it needs them. */
const word = (text: string) => (/^[\w./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`);

/** The calls after sous step, from the step's status. A failed step can run again with a resume,
 *  a running one can be told more or stopped, and every step can wait for its run. */
export function stepNext(runId: string, step: string, status: string): Next[] {
  const wait = waitNext(runId, "waits until the run ends, pauses or asks");
  if (status === "error") return [resumeNext(runId, "resumes the run, and the failed step runs again"), wait];
  if (status !== "running") return [wait];
  return [
    { call: `sous tell ${runId} --step ${word(step)} "..." --json`, does: "gives the step a message it reads after its current tool call" },
    { call: `sous stop ${runId} --step ${word(step)} --json`, does: "stops the step, and the run pauses on it" },
    wait,
  ];
}

/** A prompt's first line, cut to about 80 characters, to quote in a reply. */
export function promptLine(prompt: string): string {
  const line = prompt.split("\n")[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** The calls that answer a question, each with what it does, for the caller. A step of a run
 *  gets none for a question for people, since only the person answers it. */
export function answerNext(question: Pick<RunQuestion, "id" | "kind" | "choices" | "breakpoint" | "prompt" | "answeredBy">, who: Who): Next[] {
  const [first, sendBack] = answerCalls(question, who);
  if (!first) return [];
  const calls: Next[] = [{ call: first, does: `${question.breakpoint ? "approves" : "answers"} "${promptLine(question.prompt)}"` }];
  if (sendBack) calls.push({ call: sendBack, does: "sends the run back with a note" });
  return calls;
}

/** The calls after a wait or a show, and a note when the run waits for its own time. Show leaves
 *  out the call to itself. A wait with a timeout suggests the same timeout again. The answer
 *  calls are for `who`, the caller. */
export function nextCalls(run: RunAt, from: "wait" | "show", who: Who, timeout?: number): { next: Next[]; notes: string[] } {
  const id = run.runId;
  const wait = waitNext(id, "waits until the run ends, pauses or asks", timeout);
  const show = { call: `sous show ${id} --json`, does: "shows the run and its steps" };
  const resume = resumeNext(id, "resumes the run where it stopped");
  const calls: Next[] = [];
  const notes: string[] = [];
  if (run.status === "asks") {
    for (const q of run.questions ?? []) calls.push(...answerNext(q, who));
    calls.push({ ...wait, does: "waits again once the answer is in" });
  } else if (run.status === "running" || run.status === "pending" || run.status === "starting") {
    calls.push(wait);
  } else if (run.failure) {
    if (run.failure.step) calls.push({ call: `sous step ${id} ${word(run.failure.step)} --json`, does: "shows the step that failed" });
    calls.push(resume, show);
  } else if (run.status === "completed") {
    calls.push(show);
  } else if (run.status === "stopped") {
    calls.push(rerunNext(id, "starts the workflow again with the same inputs"), show);
  } else if (run.status === "paused" && run.resumesAt) {
    notes.push(`The service resumes this run by itself at ${run.resumesAt}. Until then sous wait returns at once, so call it after that time.`);
    calls.push({ ...wait, does: "waits for the run once the service resumed it" }, show);
  } else if (run.status === "paused" || run.status === "interrupted" || run.status === "failed") {
    calls.push(resume, show);
  } else {
    calls.push(show);
  }
  return { next: from === "show" ? calls.filter((next) => next.call !== show.call) : calls, notes };
}

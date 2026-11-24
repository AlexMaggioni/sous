// The calls that come next after sous wait and sous show, from where the run is.

import { answerCalls, type Failure, type RunQuestion } from "@sous/engine";
import type { Next } from "../reply.js";

/** Where a run is, as wait and show give it. */
interface RunAt {
  runId: string;
  status: string;
  questions?: ReadonlyArray<Pick<RunQuestion, "id" | "kind" | "choices" | "breakpoint" | "prompt">>;
  failure?: Failure;
  /** When the service resumes a run paused at a usage limit. */
  resumesAt?: string;
}

/** A step label as one shell word, in single quotes when it needs them. */
const word = (text: string) => (/^[\w./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`);

/** A prompt's first line, cut to about 80 characters, to quote in a reply. */
export function promptLine(prompt: string): string {
  const line = prompt.split("\n")[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** The calls that answer a question, each with what it does. */
function answerNext(question: Pick<RunQuestion, "id" | "kind" | "choices" | "breakpoint" | "prompt">): Next[] {
  const [first, sendBack] = answerCalls(question);
  const calls: Next[] = [{ call: first!, does: `${question.breakpoint ? "approves" : "answers"} "${promptLine(question.prompt)}"` }];
  if (sendBack) calls.push({ call: sendBack, does: "sends the run back with a note" });
  return calls;
}

/** The calls after a wait or a show, and a note when the run waits for its own time. Show leaves
 *  out the call to itself. A wait with a timeout suggests the same timeout again. */
export function nextCalls(run: RunAt, from: "wait" | "show", timeout?: number): { next: Next[]; notes: string[] } {
  const id = run.runId;
  const wait = { call: `sous wait ${id}${timeout ? ` --timeout ${timeout}` : ""} --json`, does: "waits until the run ends, pauses or asks" };
  const show = { call: `sous show ${id} --json`, does: "shows the run and its steps" };
  const resume = { call: `sous resume ${id} --json`, does: "resumes the run where it stopped" };
  const calls: Next[] = [];
  const notes: string[] = [];
  if (run.status === "asks") {
    for (const q of run.questions ?? []) calls.push(...answerNext(q));
    calls.push({ ...wait, does: "waits again once the answer is in" });
  } else if (run.status === "running" || run.status === "pending" || run.status === "starting") {
    calls.push(wait);
  } else if (run.failure) {
    if (run.failure.step) calls.push({ call: `sous step ${id} ${word(run.failure.step)} --json`, does: "shows the step that failed" });
    calls.push(resume, show);
  } else if (run.status === "completed") {
    calls.push(show);
  } else if (run.status === "stopped") {
    calls.push({ call: `sous rerun ${id} --json`, does: "starts the workflow again with the same inputs" }, show);
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

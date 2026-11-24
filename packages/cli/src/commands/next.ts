// The calls that come next after sous wait and sous show, from where the run is.

import { answerCall, type Failure, type RunQuestion } from "@sous/engine";
import type { Next } from "../reply.js";

/** Where a run is, as wait and show give it. */
interface RunAt {
  runId: string;
  status: string;
  questions?: ReadonlyArray<Pick<RunQuestion, "id" | "kind" | "choices" | "breakpoint" | "prompt">>;
  failure?: Failure;
}

/** A step label as one shell word. */
const word = (text: string) => (/^[\w./-]+$/.test(text) ? text : JSON.stringify(text));

/** The calls after a wait or a show. Show leaves out the call to itself. A wait that timed out
 *  gives the same wait again. */
export function nextCalls(run: RunAt, from: "wait" | "show", timeout?: number): Next[] {
  const id = run.runId;
  const wait = { call: `sous wait ${id}${timeout ? ` --timeout ${timeout}` : ""} --json`, does: "waits until the run ends, pauses or asks" };
  const show = { call: `sous show ${id} --json`, does: "shows the run and its steps" };
  const resume = { call: `sous resume ${id} --json`, does: "resumes the run where it stopped" };
  const calls: Next[] = [];
  if (run.status === "asks") {
    for (const q of run.questions ?? []) calls.push({ call: answerCall(q), does: `answers "${q.prompt}"` });
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
  } else if (run.status === "paused" || run.status === "interrupted" || run.status === "failed") {
    calls.push(resume, show);
  } else {
    calls.push(show);
  }
  return from === "show" ? calls.filter((next) => next.call !== show.call) : calls;
}

// `sous resume <run> --note "..." [--step <step>]`: a resume that gives a note to the first agent
// call that runs, or to the first call of the named step. This module checks the step against the
// run's steps and the text it goes on with, and says where the note went. resumeRun leaves the
// note for the worker.

import type { Who } from "./actions.js";
import type { Launcher } from "./launch.js";
import type { HomePaths } from "./home.js";
import type { NoteRequest } from "./records.js";
import { readWorkflowScript, type ScriptCall } from "../workflows/script.js";
import { Refusal, word } from "./refusal.js";
import { resumeRun, runDetail, type ResumeOptions, type ResumeOutcome, type RunDetail } from "./run.js";
import { isAgentCall, stepCalls } from "./step-view.js";
import { readState } from "./store.js";

/** A note as the caller gives it: the text, and the step by its name in the log or its label. A
 *  label the run's text writes names a step the run has not reached yet too. */
export interface ResumeNote {
  text: string;
  step?: string;
}

/** How a resume with a note went, as resumeRun says, with notes on where the note went. `tell` is
 *  the call that gives the note to a running step, when the run runs already. */
export type NotedResume = ResumeOutcome & { notes: string[]; tell?: string };

/**
 * Resume a run, as resumeRun does, with a note. The step, when given, is one the run has had, as
 * sous step and sous tell find it, or a label the text the run goes on with writes: the one
 * --latest checked, else the run's own. A name in neither is refused no_such_step, and a step with
 * no agent call step_takes_no_message, and either changes nothing. A name several nested runs
 * share covers each, so the note goes to the first of their calls that runs. A note for a step
 * whose calls all finished reaches it only if the workflow calls it again, and a note says so. A
 * run that runs already gets no note: a note gives the sous tell call instead. A run in any other
 * state that does not resume says the note reached no step.
 */
export function resumeWithNote(paths: HomePaths, launch: Launcher, runId: string, who: Who, options: Omit<ResumeOptions, "note" | "view"> & { note: ResumeNote }): NotedResume {
  const { note, ...rest } = options;
  const detail = runDetail(paths, runId);
  if (!detail.resume.ok && detail.resume.why === "running") {
    const aimed = aimNote(detail, note, readState(paths, detail.record.runId)?.script ?? "");
    return { ...resumeRun(paths, launch, runId, who, { ...rest, view: detail }), ...tellInstead(detail, aimed) };
  }
  const aimed: { note?: NoteRequest } = {};
  const aim = (script: string) => (aimed.note = aimNote(detail, note, script));
  const resumed = resumeRun(paths, launch, runId, who, { ...rest, view: detail, note: aim });
  if (!("resumed" in resumed)) return { ...resumed, notes: "wrongState" in resumed ? ["The note reached no step, since the run did not resume."] : [] };
  return { ...resumed, notes: aimed.note?.step ? finishedNote(detail, aimed.note.step) : [] };
}

/** The note with its step found in the run, else in the text, or a refusal when neither has an
 *  agent step of that name. */
function aimNote(detail: RunDetail, note: ResumeNote, script: string): NoteRequest {
  const { text, step } = note;
  if (step === undefined) return { text };
  const id = detail.record.runId;
  const found = stepCalls(detail, step);
  const kinds = found ? undefined : textKinds(script).get(step);
  if (found ? !found.calls.some(({ agent }) => isAgentCall(agent)) : kinds !== undefined && !kinds.has("agent")) {
    const change = "Name an agent step, or leave out --step to give the note to the first agent call that runs.";
    throw new Refusal("step_takes_no_message", `"${step}" is not an agent step, and only an agent call takes a note.`, change, `sous show ${id} --json`);
  }
  if (found) return { text, step: { name: found.name, scopes: [...new Set(found.calls.map((call) => call.scope))], label: found.label } };
  // A label the top-level text writes, of a step the run has not reached: the top-level run's step.
  if (kinds) return { text, step: { name: step, scopes: [id], label: step } };
  const change =
    "Name one of the run's steps, by its label or its name in sous log, or a label the workflow writes, or leave out --step to give the note to the first agent call that runs. " +
    "A step of a nested workflow counts only once the run reached it.";
  throw new Refusal("no_such_step", `run ${id} has no step "${step}", and its workflow writes no such label.`, change, `sous show ${id} --json`);
}

/** The kinds of the step calls the text writes, by their literal label. Empty when the text does
 *  not parse. */
function textKinds(script: string): Map<string, Set<ScriptCall["kind"]>> {
  const kinds = new Map<string, Set<ScriptCall["kind"]>>();
  let calls: ScriptCall[];
  try {
    calls = readWorkflowScript(script).refs.calls;
  } catch {
    return kinds;
  }
  for (const { label, kind } of calls) if (label !== undefined) kinds.set(label, (kinds.get(label) ?? new Set()).add(kind));
  return kinds;
}

/** A note when every call of the step finished: the resume does not run it again by itself. */
function finishedNote(detail: RunDetail, step: NonNullable<NoteRequest["step"]>): string[] {
  const calls = stepCalls(detail, step.name)?.calls ?? [];
  if (!calls.length || calls.some(({ agent }) => agent.status !== "done")) return [];
  return [`Step "${step.name}" already finished. The note reaches it only if the workflow calls "${step.label}" again.`];
}

/** For a run that runs already: the note reached no step, and sous tell gives it to a running
 *  agent step, the one named or else the first that runs now. A named step the run has not
 *  reached gets no call yet, since sous tell takes only a step the run has had. */
function tellInstead(detail: RunDetail, note: NoteRequest): { notes: string[]; tell?: string } {
  const id = detail.record.runId;
  const named = note.step?.name;
  if (named !== undefined && !stepCalls(detail, named)) {
    return { notes: [`The note reached no step, since the run runs already and "${named}" has not run yet. Once it runs, sous tell ${id} --step ${word(named)} gives it the note.`] };
  }
  const agentStep = (name: string) => stepCalls(detail, name)?.calls.some(({ agent }) => isAgentCall(agent)) ?? false;
  const step = named ?? detail.running.find(agentStep);
  if (step === undefined) {
    return { notes: [`The note reached no step, since the run runs already and no agent step runs now. Once one runs, sous tell ${id} --step <step> gives it the note. sous show ${id} --json lists the steps.`] };
  }
  const tell = `sous tell ${id} --step ${word(step)} ${word(note.text)} --json`;
  return { notes: [`The note reached no step, since the run runs already. To give it to "${step}" while it runs: ${tell}`], tell };
}

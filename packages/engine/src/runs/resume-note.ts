// `sous resume <run> --note "..." [--step <step>]`: a resume that gives a note to the first agent
// call that runs, or to the first call of the named step. This module checks the step against the
// run's steps and says where the note went. resumeRun leaves the note for the worker.

import { EXEC_MODEL } from "../code-steps.js";
import type { Who } from "./actions.js";
import type { Launcher } from "./launch.js";
import type { HomePaths } from "./home.js";
import type { NoteRequest } from "./records.js";
import { Refusal, word } from "./refusal.js";
import { resumeRun, runDetail, type ResumeOptions, type ResumeOutcome, type RunDetail } from "./run.js";
import { stepCalls } from "./step-view.js";

/** A note as the caller gives it: the text, and the step by its name in the log or its label. */
export interface ResumeNote {
  text: string;
  step?: string;
}

/** How a resume with a note went, as resumeRun says, with notes on where the note went. `tell` is
 *  the call that gives the note to a running step, when the run runs already. */
export type NotedResume = ResumeOutcome & { notes: string[]; tell?: string };

/**
 * Resume a run, as resumeRun does, with a note. The step, when given, is one the run has had, as
 * sous step and sous tell find it, else the resume refuses no_such_step and changes nothing. A
 * note for a step whose calls all finished reaches it only if the workflow calls it again, and a
 * note says so. A run that runs already gets no note: a note gives the sous tell call instead. A
 * run in any other state that does not resume says the note reached no step.
 */
export function resumeWithNote(paths: HomePaths, launch: Launcher, runId: string, who: Who, options: Omit<ResumeOptions, "note"> & { note: ResumeNote }): NotedResume {
  const { note, ...rest } = options;
  const detail = runDetail(paths, runId);
  const why = detail.resume.ok ? undefined : detail.resume.why;
  // A run that cannot resume says why first, through resumeRun, and a step there names nothing.
  const aimed = why === undefined || why === "running" ? aimNote(detail, note) : undefined;
  if (why === "running") {
    const resumed = resumeRun(paths, launch, runId, who, rest);
    return { ...resumed, ...tellInstead(detail, note.text, aimed!.step?.name) };
  }
  const resumed = resumeRun(paths, launch, runId, who, { ...rest, ...(aimed ? { note: aimed } : {}) });
  if (!("resumed" in resumed)) return { ...resumed, notes: "wrongState" in resumed ? ["The note reached no step, since the run did not resume."] : [] };
  return { ...resumed, notes: aimed?.step ? finishedNote(detail, aimed.step) : [] };
}

/** The note with its step found in the run, or no_such_step when the run never had it. */
function aimNote(detail: RunDetail, note: ResumeNote): NoteRequest {
  if (note.step === undefined) return { text: note.text };
  const id = detail.record.runId;
  const found = stepCalls(detail, note.step);
  if (!found) {
    const change = "Name one of the run's steps, by its label or its name in sous log, or leave out --step to give the note to the first agent call that runs.";
    throw new Refusal("no_such_step", `run ${id} has no step "${note.step}".`, change, `sous show ${id} --json`);
  }
  return { text: note.text, step: { name: found.name, scope: found.calls.at(-1)!.scope, label: found.label } };
}

/** A note when every call of the step finished: the resume does not run it again by itself. */
function finishedNote(detail: RunDetail, step: NonNullable<NoteRequest["step"]>): string[] {
  const calls = stepCalls(detail, step.name)?.calls ?? [];
  if (!calls.length || calls.some((call) => call.agent.status !== "done")) return [];
  return [`Step "${step.name}" already finished. The note reaches it only if the workflow calls "${step.label}" again.`];
}

/** For a run that runs already: the note reached no step, and sous tell gives it to a running
 *  agent step, the one named or else the first that runs now. */
function tellInstead(detail: RunDetail, text: string, named: string | undefined): { notes: string[]; tell?: string } {
  const id = detail.record.runId;
  const agentStep = (name: string) => stepCalls(detail, name)?.calls.some((call) => call.agent.model !== EXEC_MODEL) ?? false;
  const step = named ?? detail.running.find(agentStep);
  if (step === undefined) {
    return { notes: [`The note reached no step, since the run runs already and no agent step runs now. Once one runs, sous tell ${id} --step <step> gives it the note. sous show ${id} --json lists the steps.`] };
  }
  const tell = `sous tell ${id} --step ${word(step)} ${word(text)} --json`;
  return { notes: [`The note reached no step, since the run runs already. To give it to "${step}" while it runs: ${tell}`], tell };
}

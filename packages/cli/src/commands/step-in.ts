// The person steps into the session of an agent step, in this terminal: sous join, and sous wait
// in a terminal when an agent asks. sous builds the step's program first, so a program it can't
// find stops nothing. Then it makes the session the person's, which stops a turn that runs in it,
// opens the program on the session, and gives the session back to the step when the person
// leaves. Every other step goes on.

import { askedWords, joinName, joinProgram, joinQuestion, joinTarget, leaveSession, readRun, Refusal, takeSession, word, type JoinTarget, type RunQuestion, type RunView } from "@sous-run/engine";
import type { Next } from "../reply.js";
import type { Ctx } from "./index.js";
import { waitNext } from "./next.js";

/** The exit code of a join the person stopped with Ctrl-C while it waited for the session. */
export const STOPPED_WAITING = 130;
/** The exit code the machine gives for a program that did not start. */
const NOT_STARTED = 127;

/** How a person's time in a session went. */
export interface Joined {
  runId: string;
  step: string;
  call: number;
  /** The step and call as sous step finds them. */
  shown: { step: string; call: number };
  sessionId: string;
  /** The program's name, such as Claude Code. */
  program: string;
  cwd: string;
  /** The program's exit code. */
  exit: number;
  /** The id of the step's question that leaving answered. */
  answered: string | null;
  /** The run's status once the person left. */
  status: RunView["status"];
}

/** The command a person types to step into a step's session. */
const joinCommand = (runId: string, step: string) => `sous join ${runId} ${word(step)}`;

/** What sous says once the person left the session. */
export function leftText(joined: Joined): { text: string[]; notes: string[]; next: Next[] } {
  const { runId, step, status } = joined;
  const text = [`left the session of "${step}" in ${runId}.`];
  const notes: string[] = [];
  if (joined.exit !== 0) notes.push(`${joined.program} exited with code ${joined.exit}.`);
  if (status === "running" || status === "pending" || status === "starting" || status === "asks") {
    text.push(joined.answered ? `"${step}" has its answer and goes on in its session.` : `"${step}" goes on in its session.`);
  } else {
    text.push(`run ${runId} is ${status}, so nothing goes on in the session now.`);
  }
  const next: Next[] = [{ call: `sous step ${runId} ${word(joined.shown.step)} --call ${joined.shown.call} --json`, does: "shows the step and what it did since" }, waitNext(runId, "waits until the run ends, pauses or asks")];
  return { text, notes, next };
}

/**
 * Step into `target`'s session in this terminal, and give it back when the person leaves. It says
 * what it does on stderr, so the reply stays alone on stdout. Ctrl-C while it waits for the
 * session gives `{stopped: true}`, and the step keeps its session.
 */
export async function stepIn(ctx: Ctx, target: JoinTarget): Promise<Joined | { stopped: true }> {
  const { paths, machine, who } = ctx;
  const command = joinCommand(target.runId, target.step);
  if (who.through.kind === "run") {
    throw new Refusal("no_person_here", `a step of run ${who.through.runId} has no person to step into a session.`, `Leave sous join to the person. They run ${command} in a terminal.`, null);
  }
  if (!machine.isTerminal) {
    throw new Refusal("no_person_here", "sous join opens the step's program in this terminal, and this shell has none.", `Ask the person to run ${command} in a terminal of their own.`, null);
  }
  const files = machine.privateFolder();
  try {
    const program = joinProgram(paths, target, files.write, ctx.env);
    const say = (line: string) => machine.err(line);
    const question = joinQuestion(paths, target);
    // The agent's question is in its session, where the person reads it. A question asked with the
    // program's own tool ends with the turn sous ended there: Claude Code shows it as declined or
    // interrupted, and Codex shows only the prompt, so sous gives its words. A question asked
    // through the status is the session's last message.
    if (question) {
      say(`"${target.label}" asked you a question in its session.`);
      const words = askedWords(paths, target);
      if (words !== undefined && !program.showsAsked) {
        say(`${program.name} does not show it when it opens the session. It asked:`);
        for (const line of words.split("\n")) say(`  ${line}`);
        say("Answer it in your own words.");
      } else if (words !== undefined) {
        say(`${program.name} shows it as declined or interrupted, because sous ended the turn there. Answer it in your own words.`);
      } else {
        say("Its last message there holds the question. Answer it in your own words.");
      }
    }
    // The first Ctrl-C stops the wait, and a second one stops the wait for the session to come back.
    const stop = new AbortController();
    const giveUp = new AbortController();
    const off = machine.onStop(() => (stop.signal.aborted ? giveUp.abort() : (stop.abort(), say("stopping. The turn hands the session over and gets it back. Ctrl-C again leaves now."))));
    try {
      await takeSession(paths, target, who, { signal: stop.signal, giveUp: giveUp.signal, onWait: (holder) => say(waitLine(target, holder)) });
    } catch (error) {
      if (stop.signal.aborted) return { stopped: true };
      throw error;
    } finally {
      off();
    }
    for (const note of program.notes) say(`note: ${note}`);
    say(`opening ${program.name} in ${program.cwd}, in the session of "${target.label}". Leave it to give the session back to the step.`);
    let exit = NOT_STARTED;
    let answered: string | undefined;
    try {
      exit = await machine.openProgram(program);
    } finally {
      // A program that never opened answered nothing, so the step's question stays open.
      answered = leaveSession(paths, target, who, exit === NOT_STARTED ? { answer: false } : {})?.id;
    }
    if (exit === NOT_STARTED) throw new Refusal("no_program", `${program.name} did not start from ${program.path}.`, "Check the program with sous doctor, then join again.", "sous doctor");
    const { runId, step, call, cwd } = { ...target, cwd: program.cwd };
    return { runId, step, call, shown: target.shown, sessionId: target.session.sessionId, program: program.name, cwd, exit, answered: answered ?? null, status: readRun(paths, runId).status };
  } finally {
    files.remove();
  }
}

/** What the person waits for before the session is theirs. */
function waitLine(target: JoinTarget, holder: { by: string; pid: number } | undefined): string {
  if (target.running) return `waiting for "${target.label}" to hand its session over. Its turn stops once its program has the prompt.`;
  if (holder?.by === "step") return `waiting for process ${holder.pid}, which runs a turn in the session of "${target.label}", to let go of it.`;
  return `waiting for run ${target.runId} to hand the session of "${target.label}" over.`;
}

/** sous wait in a terminal met an agent's question: offer to step into its session now. */
export async function offerJoin(ctx: Ctx, question: RunQuestion): Promise<boolean> {
  const step = question.step ?? "agent";
  const later = `${joinCommand(question.runId, joinName(question))} steps into it later. The step waits until then.`;
  const typed = await ctx.machine.ask(`\n"${step}" needs you in its session. Step into it now? (Y/n) > `);
  if (/^n(o)?$/i.test(typed.trim())) {
    ctx.machine.err(later);
    return false;
  }
  const joined = await stepIn(ctx, joinTarget(ctx.paths, question.runId, joinName(question)));
  if ("stopped" in joined) {
    ctx.machine.err(`stopped waiting. ${later}`);
    return false;
  }
  const { text, notes } = leftText(joined);
  for (const line of [...text, ...notes.map((note) => `note: ${note}`)]) ctx.machine.err(line);
  return true;
}

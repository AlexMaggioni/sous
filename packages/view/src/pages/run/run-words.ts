// The words of each sous command the run page sends to /api/call, the action a run's state puts
// first, and what a question shows. Pure, so the tests read them without a page.
import type { Question, RunPage } from "../../api/contract.ts";

/** The argv of each sous command the page runs. The server adds --json. */
export const words = {
  stop: (run: string) => ["stop", run],
  pause: (run: string) => ["pause", run],
  /** `text` picks the workflow text when it changed since the run started. */
  resume: (run: string, text?: "same" | "latest") => (text ? ["resume", run, `--${text}`] : ["resume", run]),
  rerun: (run: string) => ["rerun", run],
  /** An answer sous would read as a flag goes as a JSON string, as `--value-json` takes it. */
  answer: (question: string, value: string) => (readsAsFlag(value) ? ["answer", question, "--value-json", JSON.stringify(value)] : ["answer", question, value]),
  approve: (question: string) => ["approve", question],
  sendBack: (question: string, note: string) => ["send-back", question, note],
  /** "stop" at a breakpoint stops the run, as sous stop does. */
  stopAt: (question: string) => ["answer", question, "stop"],
  /** `call` picks one call of a step that ran more than once. */
  tell: (run: string, step: string, message: string, call?: number) => ["tell", run, message, "--step", step, ...(call === undefined ? [] : ["--call", String(call)])],
};

/** Text sous reads as a flag, not as words: it starts with "-", as in "--force" or "-f". */
export function readsAsFlag(text: string): boolean {
  return text.startsWith("-");
}

/** Why a note or message can't go as it is. Only an answer has a way around a leading "-". */
export const FLAG_TEXT = "sous reads text that starts with - as a flag. Start it with a word.";

/**
 * The resume a run calls for. A run paused at its budget asks for twice the budget, else it
 * pauses again at once. `text` picks the workflow text when it changed since the run started.
 */
export function resumeFor(run: Pick<RunPage, "id" | "pauseReason" | "budget">, text?: "same" | "latest"): string[] {
  const argv = words.resume(run.id, text);
  return run.pauseReason === "budget" && run.budget ? [...argv, "--budget", String(run.budget * 2)] : argv;
}

/**
 * The one primary action of the header. Resume, when the run is paused or failed and can go on.
 * When a question waits, its panel holds the primary, so the header has none.
 */
export function primaryAction(run: Pick<RunPage, "status" | "can" | "questions">): "resume" | null {
  if (run.questions.length > 0) return null;
  return (run.status === "paused" || run.status === "failed") && run.can.resume ? "resume" : null;
}

/** What a question shows: who asks, its title, and the text a breakpoint shows under it. */
export interface Asked {
  who: string;
  title: string;
  /** The markdown a breakpoint shows, made by the steps before it. */
  show?: string;
}

/** A question in the page's words. A breakpoint comes with its title and the text it shows. */
export function askedOf(question: Pick<Question, "prompt" | "kind" | "breakpoint" | "step" | "title" | "show">): Asked {
  if (question.breakpoint) return { who: "Breakpoint", title: question.title ?? question.prompt, ...(question.show ? { show: question.show } : {}) };
  const who = question.step ? `${question.step} asks` : question.kind === "confirm" ? "Checkpoint" : "Question";
  return { who, title: question.prompt };
}

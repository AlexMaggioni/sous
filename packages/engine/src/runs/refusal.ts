// A refusal: sous will not do what the command asks. It says what to change and gives the call to
// make instead. The cli prints it as {"error": {code, message, change, call}} and exits 65 when the
// thing asked for is missing, 66 for any other refusal.

export type RefusalCode =
  | "no_such_run"
  | "no_such_workflow"
  | "no_such_question"
  | "no_such_step"
  | "no_such_schedule"
  | "no_such_topic"
  | "step_not_running"
  | "started_by_people"
  | "not_approved"
  | "question_for_people"
  | "needs_person"
  | "no_person_here"
  | "step_takes_no_message"
  | "turn_not_steerable"
  | "run_is_running"
  /** A run that has not completed, failed or stopped, which only an ended run's removal refuses. */
  | "run_not_ended"
  | "cannot_resume"
  | "not_ours"
  | "workflow_invalid"
  /** A record sous keeps is broken, such as an event log that does not parse. */
  | "broken_record";

/** The codes of a thing that is not there. */
const MISSING: ReadonlySet<RefusalCode> = new Set(["no_such_run", "no_such_workflow", "no_such_question", "no_such_step", "no_such_schedule", "no_such_topic", "step_not_running"]);

export class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    /** What the caller changes. */
    readonly change: string,
    /** The command to run instead, or null when there is none. */
    readonly call: string | null,
    /** The command a person types, set only on started_by_people. */
    readonly forPerson?: string,
  ) {
    // The name stays "Error", so a refusal prints as the errors before it did.
    super(message);
  }

  /** The thing asked for is not there: a run, a workflow, a question, a step or a guide topic. */
  get missing(): boolean {
    return MISSING.has(this.code);
  }
}

/** A word as one shell word, in single quotes when it needs them, for the calls sous gives. */
export const word = (text: string) => (/^[\w./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`);

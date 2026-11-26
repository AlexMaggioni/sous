// The API's errors: every non-2xx answer has {error: ApiError} as its body, the shape sous prints
// with --json, with an HTTP status that fits it.

import type { ApiError } from "@sous/view";
import { printError } from "../reply.js";

/** A failure the server itself answers, such as a route that does not exist. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
  }
}

/** The refusals that ask for the person, or that a caller may not make. */
const FORBIDDEN = new Set(["started_by_people", "not_approved", "question_for_people", "needs_person", "no_person_here"]);

/** The refusals of a thing that is not there. */
const MISSING = new Set(["no_such_run", "no_such_workflow", "no_such_question", "no_such_step", "no_such_schedule", "no_such_topic", "step_not_running"]);

/** The status of an error sous gives: 404 for a missing thing, 403 for a call only the person
 *  makes, 409 for any other refusal, 400 for a wrong request, 500 when sous itself failed. */
function statusOf(code: string): number {
  if (MISSING.has(code)) return 404;
  if (FORBIDDEN.has(code)) return 403;
  if (code === "bad_argument" || code === "not_a_choice") return 400;
  if (code === "internal" || code === "home_not_writable") return 500;
  return 409;
}

/** An error as the API answers it, with its status and the exit code the command line gives it.
 *  `adjust` changes its calls, as printError does. */
export function failureOf(error: unknown, adjust?: (call: string) => string): { status: number; error: ApiError; exit: number } {
  if (error instanceof ApiFailure) return { status: error.status, error: error.error, exit: 64 };
  let printed = "";
  const exit = printError(error, true, (line) => (printed += line), adjust);
  // The error as sous --json prints it, with its calls to make instead when it has some.
  const { error: printedError } = JSON.parse(printed) as { error: ApiError };
  return { status: statusOf(printedError.code), error: printedError, exit };
}

// One reply shape for every command, and one error shape. With --json a reply prints as
// {...data, notes, next} and an error as {"error": {code, message, change, call}}. In text a reply
// prints its lines, then its notes and next calls, and an error goes to stderr.

import { InputProblems, Refusal } from "@sous/engine";
import { Usage } from "./args.js";

/** A command the caller can run next, and what it does. */
export interface Next {
  call: string;
  does: string;
}

/** What a command answers: its data, its notes, its next calls, its exit code and its text form. */
export interface Reply<T extends object = Record<string, unknown>> {
  data: T;
  next: Next[];
  notes: string[];
  exit: number;
  /** The lines the text form prints before the notes and next calls. */
  text: string[];
}

/** The keys the JSON form adds, which data may not have. */
const OWN_KEYS = ["notes", "next", "error"];

/** A reply with this data. It throws when data has a key named notes, next or error. */
export function reply<T extends object>(data: T, rest: Partial<Omit<Reply<T>, "data">> = {}): Reply<T> {
  const clash = OWN_KEYS.find((key) => Object.hasOwn(data, key));
  if (clash) throw new Error(`a reply's data has no key named "${clash}"`);
  return { data, next: rest.next ?? [], notes: rest.notes ?? [], exit: rest.exit ?? 0, text: rest.text ?? [] };
}

/** Print a reply, as JSON or as text, and return its exit code. */
export function print(r: Reply<object>, json: boolean, write: (line: string) => void): number {
  if (json) {
    write(JSON.stringify({ ...r.data, notes: r.notes, next: r.next }, null, 2));
    return r.exit;
  }
  for (const line of r.text) write(line);
  for (const note of r.notes) write(`note: ${note}`);
  for (const next of r.next) write(`next: ${next.call}  (${next.does})`);
  return r.exit;
}

/** The first `max` items, and a note naming the flag that shows the rest, when some are left out. */
export function cut<T>(items: T[], max: number, flag: string, what: string): { items: T[]; note?: string } {
  if (items.length <= max) return { items };
  return { items: items.slice(0, max), note: `${items.length - max} more ${what} not shown. Add ${flag} to see them.` };
}

interface ErrorBody {
  code: string;
  message: string;
  change: string;
  call: string | null;
  forPerson?: string;
}

/** The change of a usage error that names none. */
const FIX_COMMAND = "Fix the command line. sous help lists the commands and their flags.";

/** The lines under an error's first line in text, as its JSON has them. */
const below = (body: ErrorBody): string[] => [`  change: ${body.change}`, ...(body.call ? [`  try: ${body.call}`] : [])];

/** The error's body and exit code, and its first line in text. */
function shapeOf(error: unknown): { body: ErrorBody; exit: number; first: string } {
  if (error instanceof Refusal) {
    const body: ErrorBody = { code: error.code, message: error.message, change: error.change, call: error.call };
    if (error.code === "started_by_people" && error.forPerson !== undefined) body.forPerson = error.forPerson;
    return { body, exit: error.missing ? 65 : 66, first: error.message };
  }
  if (error instanceof Usage) {
    const body: ErrorBody = { code: error.code, message: error.message, change: error.change ?? FIX_COMMAND, call: error.call };
    return { body, exit: 64, first: `usage: ${error.message}` };
  }
  if (error instanceof InputProblems) {
    const body: ErrorBody = { code: "bad_argument", message: error.message, change: "Give the inputs the workflow needs.", call: `sous check ${error.workflow} --json` };
    return { body, exit: 64, first: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  const change = "The command is fine. sous itself failed. Read the message, fix the cause and run the same command again.";
  // A fault keeps today's one line in text.
  return { body: { code: "internal", message, change, call: null }, exit: 1, first: `sous: ${message}` };
}

/** Print an error, as JSON or as text, and return its exit code: 64 for a usage error, 65 for a
 *  missing thing, 66 for any other refusal, 1 when sous itself failed. `adjust` changes the call,
 *  such as to keep the command's --project. */
export function printError(error: unknown, json: boolean, write: (line: string) => void, adjust?: (call: string) => string): number {
  const { body, exit, first } = shapeOf(error);
  if (body.call && adjust) body.call = adjust(body.call);
  if (json) write(JSON.stringify({ error: body }, null, 2));
  else for (const line of body.code === "internal" ? [first] : [first, ...below(body)]) write(line);
  return exit;
}

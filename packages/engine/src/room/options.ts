// Reads and checks room()'s options before the room's first turn. A wrong option fails the script
// with what to write instead. workflows/check.ts checks what it can see of them in the script's
// text, and this checks all of them again, since a script can build them in code.

import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import { isSchemaObject } from "../steps/answer.js";
import { cloneStrictJsonValue } from "../strict-json.js";
import type { RoomMessage, Turns } from "./order.js";
import type { Hears, PromptRoom } from "./prompt.js";

/** A member of a room: its handle, its label and model as the handle gives them, and its role. */
export interface RoomMember {
  handle: { send(prompt: string, options?: Record<string, unknown>): Promise<unknown> };
  label: string;
  model?: string;
  role?: string;
}

/** A room's options, read and checked. */
export interface RoomSetup extends PromptRoom {
  members: RoomMember[];
  /** The messages said before round 1, with round 0. */
  opening: RoomMessage[];
}

/** What room() reads of a handle: its label and model, or undefined for anything that is not a handle of this workflow. */
export type Describe = (value: unknown) => { label: string; model?: string } | undefined;

const KEYS = ["goal", "members", "name", "opening", "turns", "decider", "schema", "hears", "maxRounds"] as const;
const KEY_SET = new Set<string>(KEYS);
const TURNS: readonly Turns[] = ["together", "in order", "moderated"];

function fail(message: string): never {
  throw new WorkflowError(`room(): ${message}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A member as written: a handle, or { session, role }. */
function memberOf(value: unknown, index: number, describe: Describe): RoomMember {
  const own = describe(value);
  if (own) return { handle: value as RoomMember["handle"], ...own };
  if (!isObject(value)) fail(`members[${index}] is a session handle, or { session, role }`);
  const { session, role, ...rest } = value;
  if (Object.keys(rest).length > 0) fail(`members[${index}] takes session and role, not ${Object.keys(rest).join(", ")}`);
  const info = describe(session);
  if (!info) fail(`members[${index}].session is a handle from session() or fork()`);
  if (role !== undefined && (typeof role !== "string" || !role.trim())) fail(`members[${index}].role is a line of text`);
  return { handle: session as RoomMember["handle"], ...info, ...(role === undefined ? {} : { role: role.trim() }) };
}

/** The opening messages, each from a member to another member or to all. */
function openingOf(value: unknown, labels: ReadonlySet<string>): RoomMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("opening is a list of { from, to, text }");
  return value.map((message: unknown, index) => {
    if (!isObject(message)) fail(`opening[${index}] is { from, to, text }`);
    const { from, to, text, ...rest } = message;
    if (Object.keys(rest).length > 0) fail(`opening[${index}] takes from, to and text, not ${Object.keys(rest).join(", ")}`);
    if (typeof from !== "string" || !labels.has(from)) fail(`opening[${index}].from is a member's label, got ${JSON.stringify(from)}`);
    if (typeof to !== "string" || (to !== "all" && !labels.has(to))) fail(`opening[${index}].to is a member's label or "all", got ${JSON.stringify(to)}`);
    if (to === from) fail(`opening[${index}] goes from ${from} to itself`);
    if (typeof text !== "string") fail(`opening[${index}].text is text, got ${text === null ? "null" : typeof text}`);
    return { round: 0, from, to, text };
  });
}

/** Reads room()'s options. Each option is read once, so a getter can't give two values. */
export function readRoomOptions(given: unknown, describe: Describe): RoomSetup {
  if (!isObject(given)) fail("takes an options object with goal and members");
  for (const key of Object.keys(given)) {
    if (!KEY_SET.has(key)) fail(`${key} is not a room option. A room takes ${KEYS.join(", ")}.`);
  }
  const { goal, members: written, name, opening, turns, decider, schema, hears, maxRounds } = given;
  if (typeof goal !== "string" || !goal.trim()) fail("needs a goal, the text of what the room must reach");
  if (!Array.isArray(written) || written.length < 2) fail("needs members, a list of two handles at least");
  const members = written.map((member: unknown, index) => memberOf(member, index, describe));
  const labels = new Set<string>();
  for (const member of members) {
    if (member.label === "all") fail('a member\'s label is never "all", since a message to "all" goes to every member');
    if (labels.has(member.label)) fail(`the label "${member.label}" names two members. Each member is another session.`);
    labels.add(member.label);
  }
  if (name !== undefined && (typeof name !== "string" || !name.trim())) fail("name is a short text");
  if (turns !== undefined && !TURNS.includes(turns as Turns)) fail(`turns is ${TURNS.map((t) => JSON.stringify(t)).join(", ")}, got ${JSON.stringify(turns)}`);
  if (hears !== undefined && hears !== "all" && hears !== "addressed") fail(`hears is "all" or "addressed", got ${JSON.stringify(hears)}`);
  let deciderLabel: string | undefined;
  if (decider !== undefined) {
    deciderLabel = describe(decider)?.label;
    if (deciderLabel === undefined || !members.some((member) => member.handle === decider)) fail("decider is the handle of one of the members");
  }
  if (turns === "moderated" && deciderLabel === undefined) fail('a "moderated" room needs a decider, who names each next speaker');
  let shape: Record<string, unknown> | undefined;
  if (schema !== undefined) {
    if (deciderLabel === undefined) fail("schema is the shape of the decision, so it needs a decider");
    const copy = cloneStrictJsonValue(schema);
    if (!copy.ok || !isSchemaObject(copy.clone)) fail("schema must be a JSON schema object");
    shape = copy.clone as Record<string, unknown>;
  }
  if (maxRounds !== undefined && (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds < 1)) {
    fail(`maxRounds is a whole number of 1 or more, got ${JSON.stringify(maxRounds)}`);
  }
  return {
    name: typeof name === "string" ? name.trim() : "room",
    goal: goal.trim(),
    members,
    opening: openingOf(opening, labels),
    turns: (turns as Turns | undefined) ?? "together",
    hears: (hears as Hears | undefined) ?? "all",
    ...(deciderLabel === undefined ? {} : { decider: deciderLabel }),
    ...(shape === undefined ? {} : { schema: shape }),
    ...(maxRounds === undefined ? {} : { maxRounds: maxRounds as number }),
  };
}

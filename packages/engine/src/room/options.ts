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

/** room()'s options. */
export const ROOM_KEYS = ["goal", "members", "name", "opening", "turns", "decider", "schema", "hears", "maxRounds"] as const;
const KEY_SET = new Set<string>(ROOM_KEYS);
export const ROOM_TURNS: readonly Turns[] = ["together", "in order", "moderated"];

/** A value as a message shows it: as JSON, else its type, such as "undefined" or "function". */
const got = (value: unknown) => JSON.stringify(value) ?? typeof value;

/** What room() says of each wrong option. workflows/check.ts says the same of what it sees in the text. */
export const SAYS = {
  options: "takes an options object with goal and members",
  key: (key: string) => `${key} is not a room option. A room takes ${ROOM_KEYS.join(", ")}.`,
  goal: "needs a goal, the text of what the room must reach",
  members: "needs members, a list of two handles at least",
  member: (index: number) => `members[${index}] is a session handle, or { session, role }`,
  memberKeys: (index: number, keys: string[]) => `members[${index}] takes session and role, not ${keys.join(", ")}`,
  session: (index: number) => `members[${index}].session is a handle from session() or fork()`,
  role: (index: number) => `members[${index}].role is a line of text`,
  all: 'a member\'s label is never "all", since a message to "all" goes to every member',
  twice: (label: string) => `the label "${label}" names two members. Each member is another session.`,
  name: "name is a short text",
  turns: (value: unknown) => `turns is ${ROOM_TURNS.map((turns) => JSON.stringify(turns)).join(", ")}, got ${got(value)}`,
  hears: (value: unknown) => `hears is "all" or "addressed", got ${got(value)}`,
  decider: "decider is the handle of one of the members",
  moderated: 'a "moderated" room needs a decider, who names each next speaker',
  schemaDecider: "schema is the shape of the decision, so it needs a decider",
  schema: "schema must be a JSON schema object",
  maxRounds: (value: unknown) => `maxRounds is a whole number of 1 or more, got ${got(value)}`,
  opening: "opening is a list of { from, to, text }",
  message: (index: number) => `opening[${index}] is { from, to, text }`,
  messageKeys: (index: number, keys: string[]) => `opening[${index}] takes from, to and text, not ${keys.join(", ")}`,
  from: (index: number, value: unknown) => `opening[${index}].from is a member's label, got ${got(value)}`,
  to: (index: number, value: unknown) => `opening[${index}].to is a member's label or "all", got ${got(value)}`,
  self: (index: number, from: string) => `opening[${index}] goes from ${from} to itself`,
  text: (index: number, value: unknown) => `opening[${index}].text is text, got ${value === null ? "null" : typeof value}`,
};

function fail(message: string): never {
  throw new WorkflowError(`room(): ${message}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A member as written: a handle, or { session, role }. */
function memberOf(value: unknown, index: number, describe: Describe): RoomMember {
  const own = describe(value);
  if (own) return { handle: value as RoomMember["handle"], ...own };
  if (!isObject(value)) fail(SAYS.member(index));
  const { session, role, ...rest } = value;
  if (Object.keys(rest).length > 0) fail(SAYS.memberKeys(index, Object.keys(rest)));
  const info = describe(session);
  if (!info) fail(SAYS.session(index));
  if (role !== undefined && (typeof role !== "string" || !role.trim())) fail(SAYS.role(index));
  return { handle: session as RoomMember["handle"], ...info, ...(role === undefined ? {} : { role: role.trim() }) };
}

/** The opening messages, each from a member to another member or to all. */
function openingOf(value: unknown, labels: ReadonlySet<string>): RoomMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(SAYS.opening);
  return value.map((message: unknown, index) => {
    if (!isObject(message)) fail(SAYS.message(index));
    const { from, to, text, ...rest } = message;
    if (Object.keys(rest).length > 0) fail(SAYS.messageKeys(index, Object.keys(rest)));
    if (typeof from !== "string" || !labels.has(from)) fail(SAYS.from(index, from));
    if (typeof to !== "string" || (to !== "all" && !labels.has(to))) fail(SAYS.to(index, to));
    if (to === from) fail(SAYS.self(index, from));
    if (typeof text !== "string") fail(SAYS.text(index, text));
    return { round: 0, from, to, text };
  });
}

/** Reads room()'s options. Each option is read once, so a getter can't give two values. */
export function readRoomOptions(given: unknown, describe: Describe): RoomSetup {
  if (!isObject(given)) fail(SAYS.options);
  for (const key of Object.keys(given)) {
    if (!KEY_SET.has(key)) fail(SAYS.key(key));
  }
  const { goal, members: written, name, opening, turns, decider, schema, hears, maxRounds } = given;
  if (typeof goal !== "string" || !goal.trim()) fail(SAYS.goal);
  if (!Array.isArray(written) || written.length < 2) fail(SAYS.members);
  const members = written.map((member: unknown, index) => memberOf(member, index, describe));
  const labels = new Set<string>();
  for (const member of members) {
    if (member.label === "all") fail(SAYS.all);
    if (labels.has(member.label)) fail(SAYS.twice(member.label));
    labels.add(member.label);
  }
  if (name !== undefined && (typeof name !== "string" || !name.trim())) fail(SAYS.name);
  if (turns !== undefined && !ROOM_TURNS.includes(turns as Turns)) fail(SAYS.turns(turns));
  if (hears !== undefined && hears !== "all" && hears !== "addressed") fail(SAYS.hears(hears));
  let deciderLabel: string | undefined;
  if (decider !== undefined) {
    deciderLabel = describe(decider)?.label;
    if (deciderLabel === undefined || !members.some((member) => member.handle === decider)) fail(SAYS.decider);
  }
  if (turns === "moderated" && deciderLabel === undefined) fail(SAYS.moderated);
  let shape: Record<string, unknown> | undefined;
  if (schema !== undefined) {
    if (deciderLabel === undefined) fail(SAYS.schemaDecider);
    const copy = cloneStrictJsonValue(schema);
    if (!copy.ok || !isSchemaObject(copy.clone)) fail(SAYS.schema);
    shape = copy.clone as Record<string, unknown>;
  }
  if (maxRounds !== undefined && (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds < 1)) {
    fail(SAYS.maxRounds(maxRounds));
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

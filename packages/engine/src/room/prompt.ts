// What a room member reads and how it answers: each turn's prompt and schema. It does no I/O.
//
// A member's first turn holds the goal, the members with their models, its role, the rules and
// every message before it. A later turn holds only the messages since its last turn, since the
// session holds the rest. No prompt holds a time, a count of tokens or anything else that
// changes between two runs, so a resumed room asks the same prompts and replays its turns.

import type { Ended, RoomMessage, Turns } from "./order.js";

/** Whom a member hears: every message, or only the messages to it or to all. */
export type Hears = "all" | "addressed";

/** A member as its prompts name it. */
export interface PromptMember {
  label: string;
  model?: string;
  role?: string;
}

/** What the prompts and schemas read of a room. */
export interface PromptRoom {
  name: string;
  goal: string;
  members: readonly PromptMember[];
  turns: Turns;
  hears: Hears;
  /** The decider's label. */
  decider?: string;
  /** The shape of the decision. */
  schema?: Record<string, unknown>;
  maxRounds?: number;
}

/** One message as a prompt shows it. */
const line = (message: RoomMessage): string => `[${message.from} to ${message.to}] ${message.text}`;

/** The messages from `from` on that the member hears, without its own. */
function heard(room: PromptRoom, label: string, transcript: readonly RoomMessage[], from = 0): RoomMessage[] {
  return transcript.slice(from).filter((message) => message.from !== label && (room.hears === "all" || message.to === label || message.to === "all"));
}

const ORDERS: Record<Turns, string> = {
  together: "The members talk in rounds. In each round, every member with a new message to it or to all speaks at the same time.",
  "in order": "The members speak one at a time, in the order of the list above. A member with no new message to it or to all is skipped.",
  moderated: "The decider speaks first and after each other turn, and names the member who speaks next.",
};

/** The rules of the room, as the member's first turn gives them. */
function rules(room: PromptRoom, label: string): string[] {
  const decides = room.decider === label;
  return [
    ORDERS[room.turns],
    "Each turn, answer with your messages and whether you are done. A message goes to one member by its label, or to all. A message to a member asks that member to answer.",
    room.hears === "all" ? "Every member reads every message." : "Each member reads only the messages sent to it or to all.",
    "Set done to true when you have nothing more to add and accept where the room stands. A new message to you asks you to speak again.",
    "Before you answer, you may read files and run tools, as in any task.",
    ...(decides ? ["You decide for the room. Put your decision in decision once the room has reached one, else null. The room ends when you decide."] : []),
    ...(decides && room.turns === "moderated" ? ["In next, name the member who speaks next, or null when nobody needs to."] : []),
  ];
}

/** The member list, with each member's model, marking the member itself and the decider. */
function roster(room: PromptRoom, label: string): string[] {
  return room.members.map((member) => {
    const notes = [member.label === label ? "you" : undefined, member.label === room.decider ? "decides" : undefined].filter(Boolean);
    return `- ${member.label}${member.model ? ` (${member.model})` : ""}${notes.length ? `, ${notes.join(", ")}` : ""}`;
  });
}

/** The prompt of a member's first turn in the room, in round `round`. */
export function firstPrompt(room: PromptRoom, label: string, transcript: readonly RoomMessage[], round: number): string {
  const role = room.members.find((member) => member.label === label)?.role;
  const said = heard(room, label, transcript);
  return [
    `Round ${round}. You are "${label}", a member of the room "${room.name}".${role ? ` ${role}` : ""}`,
    `Goal:\n${room.goal}`,
    `Members:\n${roster(room, label).join("\n")}`,
    `How the room works:\n${rules(room, label).map((rule) => `- ${rule}`).join("\n")}`,
    said.length ? `Messages so far:\n${said.map(line).join("\n")}` : "No messages yet.",
  ].join("\n\n");
}

/** The prompt of a member's later turn: the messages since its last turn, read up to `read`. */
export function laterPrompt(room: PromptRoom, label: string, transcript: readonly RoomMessage[], read: number, round: number): string {
  const said = heard(room, label, transcript, read);
  return said.length
    ? `Round ${round}. New messages since your last turn:\n${said.map(line).join("\n")}`
    : `Round ${round}. No new messages since your last turn.`;
}

/** What the decider's last turn adds: why the room ends, and to decide now. */
export function decideNow(ended: Exclude<Ended, "decided">, maxRounds?: number): string {
  const why = {
    agreed: "every member is done",
    quiet: "no member has anything new to say",
    limit: `it reached its limit of ${maxRounds} rounds`,
  }[ended];
  return `The room ends now, because ${why}. Give your decision in decision now.`;
}

const nullable = (schema: Record<string, unknown>, description: string) => ({ anyOf: [schema, { type: "null" }], description });

/**
 * The schema of a member's answer: its messages and whether it is done. `to` is "all" or another
 * member's label. The decider's answer adds `decision`, the room's schema or null, and in
 * "moderated" `next`, another member's label or null. Each anyOf puts its value first and null
 * second, so the dry run's stand-in decides and names a member.
 */
export function turnSchema(room: PromptRoom, label: string): Record<string, unknown> {
  const others = room.members.map((member) => member.label).filter((other) => other !== label);
  const message = {
    type: "object",
    properties: {
      to: { type: "string", enum: ["all", ...others], description: "A member's label, or all." },
      text: { type: "string", description: "What you say." },
    },
    required: ["to", "text"],
    additionalProperties: false,
  };
  const decides = room.decider === label;
  const properties: Record<string, unknown> = {
    messages: { type: "array", items: message, description: "Your messages this turn. An empty list says nothing." },
    done: { type: "boolean", description: "True when you have nothing more to add and accept where the room stands." },
    ...(decides ? { decision: nullable(room.schema ?? { type: "string" }, "Your decision for the room once it has reached one, else null. The room ends when you decide.") } : {}),
    ...(decides && room.turns === "moderated" ? { next: nullable({ type: "string", enum: others }, "The member who speaks next, or null when nobody needs to.") } : {}),
  };
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

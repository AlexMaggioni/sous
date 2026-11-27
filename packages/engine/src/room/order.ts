// Who speaks next in a room, and whether the room ends. It reads the transcript, the members'
// state and the room's order, and does no I/O. room/room.ts runs the turns it names.
//
// A member speaks when it has something new: before its first turn, or after a message to it or
// to all from another member since its last turn. A member whose turn waits for the person is
// busy. The others go on without it, and the room ends "agreed" or "quiet" only once it is back.

/** The order of a room's turns. */
export type Turns = "together" | "in order" | "moderated";

/** Why a room ended. */
export type Ended = "decided" | "agreed" | "quiet" | "limit";

/** One message of a room. `to` is a member's label or "all". The opening messages have round 0. */
export interface RoomMessage {
  round: number;
  from: string;
  to: string;
  text: string;
}

/** A member as the order reads it. */
export interface MemberState {
  label: string;
  /** How many messages of the transcript its last turn's prompt held. Unset before its first turn. */
  read?: number;
  /** Its last answer said done. */
  done: boolean;
  /** A turn of it runs or waits for the person, and its answer has not joined the transcript. */
  busy: boolean;
}

/** Whether the member has something new to answer. */
function woken(member: MemberState, transcript: readonly RoomMessage[]): boolean {
  if (member.read === undefined) return true;
  return transcript.slice(member.read).some((message) => message.from !== member.label && (message.to === member.label || message.to === "all"));
}

/** The members that speak in the next round of "together": each free member with something new, in member order. */
export function together(members: readonly MemberState[], transcript: readonly RoomMessage[]): string[] {
  return members.filter((member) => !member.busy && woken(member, transcript)).map((member) => member.label);
}

/**
 * The next member at the table in "in order": the first free member with something new after the
 * member at index `after`. -1 starts a pass. Undefined ends the pass.
 */
export function atTable(members: readonly MemberState[], transcript: readonly RoomMessage[], after: number): string | undefined {
  return members.slice(after + 1).find((member) => !member.busy && woken(member, transcript))?.label;
}

/** What the ending rule reads after a round. */
export interface EndCheck {
  members: readonly MemberState[];
  /** The decider's label, when the room has one. */
  decider?: string;
  /** The decider gave a decision. */
  decided: boolean;
  /** The rounds run so far. */
  rounds: number;
  maxRounds?: number;
  /** Nobody would speak in the next round: no free member has something new, or in "moderated"
   *  the decider named nobody. */
  silent: boolean;
}

/**
 * Why the room ends now, if it does, in this order: the decider decided, every member is done
 * with no decider, nobody would speak, or the room ran its rounds. A busy member keeps the room
 * from "agreed" and "quiet", since its answer is still to come.
 */
export function ending(check: EndCheck): Ended | undefined {
  if (check.decided) return "decided";
  const busy = check.members.some((member) => member.busy);
  if (check.decider === undefined && !busy && check.members.every((member) => member.done)) return "agreed";
  if (check.silent && !busy) return "quiet";
  if (check.maxRounds !== undefined && check.rounds >= check.maxRounds) return "limit";
  return undefined;
}

/** Whether the decider gets one more turn, asked to decide now, before the room ends. */
export function lastTurn(ended: Ended, decider: string | undefined, decided: boolean): boolean {
  return decider !== undefined && !decided && ended !== "decided";
}

// The room's loop. Each turn is one send() on a member's handle, with until "turn" and the room's
// schema, so each member goes on in its own session and every turn is an ordinary agent step:
// the journal, a resume, retries, --set, sous tell and sous join hold for it. room/order.ts names
// who speaks and when the room ends, and room/prompt.ts writes each turn's prompt and schema.
//
// The answers of a round join the transcript in member order, never in the order the turns
// finished, so a resumed room asks the same prompts and replays its turns. A turn runs inside the
// script's parallel(), so a failure that ends the run ends it here too, and any other failure
// counts as a member that said nothing and is done.
//
// A member whose turn waits for the person, because its agent asked or the person stepped in,
// gives way: in "together" and "in order" the other members go on, and its answer joins the
// transcript at the first round boundary after its turn ends. A room where a person stepped in
// may then ask other prompts on a resume, and those turns run live. In "moderated" one member
// speaks at a time, so the room waits for it.

import type { Ended, MemberState, RoomMessage } from "./order.js";
import { atTable, ending, lastTurn, together } from "./order.js";
import { readRoomOptions, type Describe, type RoomMember, type RoomSetup } from "./options.js";
import { decideNow, firstPrompt, laterPrompt, turnSchema } from "./prompt.js";

export interface RoomDeps {
  /** Runs turns as the script's parallel() does. */
  parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
  /** The run's log. Each message gets a line. */
  log: (message: string) => void;
  /** The label and model of a handle of this workflow. */
  describe: Describe;
  /** Calls `fn` each time a turn of the session `label` waits for the person. Gives the call that stops it. */
  watch: (label: string, fn: () => void) => () => void;
}

/** What room() returns. */
export interface RoomResult {
  ended: Ended;
  /** The decider's decision, or null. */
  decision: unknown;
  rounds: number;
  /** Every message, the opening first with round 0. */
  transcript: RoomMessage[];
  members: Record<string, { turns: number; done: boolean }>;
}

interface Member extends MemberState, RoomMember {
  turns: number;
}

/** A turn that waits for the person. Its answer joins the transcript once it ends. */
interface Waiting {
  sent: Promise<unknown>;
  settled: boolean;
  ended: Promise<void>;
}

/** What a turn that may give way gave: its answer, or its turn that waits for the person. */
type Outcome = { answer: unknown } | { waits: Waiting };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A message's first line, as the log shows it. */
function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}...` : line;
}

/** Makes room(), which reads its options, runs its turns and gives { ended, decision, rounds, transcript, members }. */
export function createRoom(deps: RoomDeps) {
  return (given: unknown): Promise<RoomResult> => {
    const setup = readRoomOptions(given, deps.describe);
    return runRoom(setup, deps);
  };
}

async function runRoom(room: RoomSetup, deps: RoomDeps): Promise<RoomResult> {
  const transcript: RoomMessage[] = [...room.opening];
  const members: Member[] = room.members.map((member) => ({ ...member, done: false, busy: false, turns: 0 }));
  const byLabel = new Map(members.map((member) => [member.label, member]));
  const waiting = new Map<string, Waiting>();
  let rounds = 0;
  let decided = false;
  let decision: unknown = null;
  /** The member the decider named to speak next, in "moderated". */
  let next: string | null = null;
  const say = (text: string) => deps.log(`room ${room.name}  ${text}`);
  for (const message of transcript) say(`${message.from} to ${message.to}: ${firstLine(message.text)}`);

  /** Sends the member its turn: what is new since its last turn, and `note` after it. */
  const send = (member: Member, note?: string): Promise<unknown> => {
    const prompt = member.read === undefined ? firstPrompt(room, member.label, transcript, rounds) : laterPrompt(room, member.label, transcript, member.read, rounds);
    member.read = transcript.length;
    member.turns++;
    return member.handle.send(note ? `${prompt}\n\n${note}` : prompt, { until: "turn", schema: turnSchema(room, member.label) });
  };

  /** A whole turn, run as parallel() runs one: null when it failed and the run goes on. */
  const whole = async (member: Member, note?: string): Promise<unknown> => (await deps.parallel([() => send(member, note)]))[0];

  /** A turn that gives way once it waits for the person. */
  const mayWait = (member: Member): Promise<Outcome> => {
    let stop = () => {};
    const waits = new Promise<void>((resolve) => {
      stop = deps.watch(member.label, resolve);
    });
    const sent = send(member);
    const turn: Waiting = { sent, settled: false, ended: Promise.resolve() };
    turn.ended = sent.then(
      () => void (turn.settled = true),
      () => void (turn.settled = true),
    );
    return Promise.race([sent.then((answer): Outcome => ({ answer })), waits.then((): Outcome => ({ waits: turn }))]).finally(stop);
  };

  /** Puts a member's answer in the transcript, in round `round`. */
  const take = (member: Member, answer: unknown, round: number) => {
    member.busy = false;
    waiting.delete(member.label);
    if (!isObject(answer)) {
      member.done = true;
      say(`${member.label} gave no answer`);
      return;
    }
    for (const message of Array.isArray(answer.messages) ? answer.messages : []) {
      if (!isObject(message) || typeof message.text !== "string") continue;
      const to = typeof message.to === "string" && message.to !== member.label && (message.to === "all" || byLabel.has(message.to)) ? message.to : "all";
      transcript.push({ round, from: member.label, to, text: message.text });
      say(`${member.label} to ${to}: ${firstLine(message.text)}`);
    }
    member.done = answer.done === true;
    if (member.label !== room.decider) return;
    if (answer.decision !== null && answer.decision !== undefined) {
      decided = true;
      decision = answer.decision;
    }
    next = typeof answer.next === "string" && answer.next !== member.label && byLabel.has(answer.next) ? answer.next : null;
  };

  /** Takes each turn's outcome, in the order the members spoke: an answer, or a turn that waits. */
  const settle = (labels: readonly string[], outcomes: readonly unknown[]) => {
    labels.forEach((label, index) => {
      const member = byLabel.get(label)!;
      const outcome = outcomes[index] as Outcome | null | undefined;
      if (outcome && "waits" in outcome) {
        member.busy = true;
        waiting.set(label, outcome.waits);
        say(`${label} waits for the person. The room goes on without it.`);
      } else take(member, outcome?.answer ?? null, rounds);
    });
  };

  /** Takes the answers of the turns that waited for the person, in member order: those that ended, or with `all` every one. */
  const collect = async (all: boolean) => {
    for (const member of members) {
      const turn = waiting.get(member.label);
      if (!turn || (!all && !turn.settled)) continue;
      const [answer] = await deps.parallel([() => turn.sent]);
      take(member, answer, rounds);
    }
  };

  /** Waits for any turn that waits for the person to end. */
  const anyEnds = () => Promise.race([...waiting.values()].map((turn) => turn.ended));

  const check = (silent: boolean) =>
    ending({
      members,
      ...(room.decider === undefined ? {} : { decider: room.decider }),
      decided,
      rounds,
      ...(room.maxRounds === undefined ? {} : { maxRounds: room.maxRounds }),
      silent,
    });

  /** "together": each round, every free member with something new speaks at once. */
  const inRounds = async (): Promise<Ended> => {
    for (;;) {
      await collect(false);
      const speakers = together(members, transcript);
      const ended = check(speakers.length === 0);
      if (ended) return ended;
      if (speakers.length === 0) {
        await anyEnds();
        continue;
      }
      rounds++;
      settle(speakers, await deps.parallel(speakers.map((label) => () => mayWait(byLabel.get(label)!))));
    }
  };

  /** "in order": one member at a time around the table. The room ends at once on a decision. */
  const aroundTable = async (): Promise<Ended> => {
    for (;;) {
      await collect(false);
      const first = atTable(members, transcript, -1);
      const ended = check(first === undefined);
      if (ended) return ended;
      if (first === undefined) {
        await anyEnds();
        continue;
      }
      rounds++;
      for (let label: string | undefined = first; label !== undefined; label = atTable(members, transcript, members.indexOf(byLabel.get(label)!))) {
        const member = byLabel.get(label)!;
        settle([label], await deps.parallel([() => mayWait(member)]));
        if (decided) return "decided";
      }
    }
  };

  /** "moderated": the decider speaks, then the member it names. A round is one pick. */
  const moderated = async (): Promise<Ended> => {
    const decider = byLabel.get(room.decider!)!;
    for (;;) {
      const ended = check(false);
      if (ended) return ended;
      rounds++;
      take(decider, await whole(decider), rounds);
      if (decided) return "decided";
      const picked = next === null ? undefined : byLabel.get(next);
      if (!picked) return check(true) ?? "quiet";
      take(picked, await whole(picked), rounds);
    }
  };

  let ended = await (room.turns === "moderated" ? moderated() : room.turns === "in order" ? aroundTable() : inRounds());
  // A room that ends while a member is with the person returns once that member's turn ends.
  await collect(true);
  if (decided) ended = "decided";
  if (lastTurn(ended, room.decider, decided)) {
    take(byLabel.get(room.decider!)!, await whole(byLabel.get(room.decider!)!, decideNow(ended as Exclude<Ended, "decided">, room.maxRounds)), rounds);
    if (decided) ended = "decided";
  }
  say(`ended ${ended} after ${rounds} round${rounds === 1 ? "" : "s"}`);
  return {
    ended,
    decision: decided ? decision : null,
    rounds,
    transcript: transcript.map((message) => ({ ...message })),
    members: Object.fromEntries(members.map((member) => [member.label, { turns: member.turns, done: member.done }])),
  };
}

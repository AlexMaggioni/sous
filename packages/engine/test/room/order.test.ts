// Who speaks next in a room, and when the room ends.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atTable, ending, lastTurn, together, type EndCheck, type MemberState, type RoomMessage } from "../../src/room/order.js";

const say = (round: number, from: string, to: string, text = "..."): RoomMessage => ({ round, from, to, text });
const member = (label: string, fields: Partial<MemberState> = {}): MemberState => ({ label, done: false, busy: false, ...fields });
const check = (fields: Partial<EndCheck>): EndCheck => ({ members: [], decided: false, rounds: 1, silent: false, ...fields });
/** Whether a message wakes the member: whether it would speak in "together", alone in the room. */
const woken = (one: MemberState, transcript: RoomMessage[]) => together([one], transcript).includes(one.label);

describe("whom a message wakes", () => {
  it("wakes every member before its first turn", () => {
    assert.equal(woken(member("a"), []), true);
  });

  it("wakes a member with a message to it or to all since its last turn, but not with its own or one between others", () => {
    const transcript = [say(1, "a", "all"), say(1, "b", "c"), say(2, "c", "a")];
    assert.equal(woken(member("a", { read: 0 }), transcript), true, "c wrote to a");
    assert.equal(woken(member("a", { read: 3 }), transcript), false, "nothing new since its last turn");
    assert.equal(woken(member("b", { read: 1 }), transcript), false, "a message from b to c, and one from c to a");
    assert.equal(woken(member("c", { read: 0 }), transcript), true, "a wrote to all, and b to c");
    assert.equal(woken(member("a", { read: 0 }), [say(1, "a", "all")]), false, "its own message wakes nobody it was not sent to");
  });

  it("wakes a member that said done when a message reaches it", () => {
    assert.equal(woken(member("a", { read: 1, done: true }), [say(1, "b", "all"), say(2, "b", "a")]), true);
  });
});

describe("together", () => {
  it("lets every member speak in round 1", () => {
    assert.deepEqual(together([member("a"), member("b"), member("c")], []), ["a", "b", "c"]);
  });

  it("lets only the members with something new speak, in member order, and skips a busy member", () => {
    const transcript = [say(1, "c", "a"), say(1, "a", "all")];
    const members = [member("a", { read: 0 }), member("b", { read: 0, busy: true }), member("c", { read: 0 })];
    assert.deepEqual(together(members, transcript), ["a", "c"], "b heard a's message but its turn waits for the person");
  });

  it("names nobody when nobody has something new", () => {
    assert.deepEqual(together([member("a", { read: 1 }), member("b", { read: 1 })], [say(1, "a", "b")]), []);
  });
});

describe("in order", () => {
  it("goes around the table one member at a time, in member order", () => {
    const members = [member("a"), member("b"), member("c")];
    assert.equal(atTable(members, [], -1), "a");
    assert.equal(atTable(members, [], 0), "b");
    assert.equal(atTable(members, [], 2), undefined, "the pass ends after the last member");
  });

  it("skips a member with nothing new and a busy one", () => {
    const transcript = [say(1, "a", "c")];
    const members = [member("a", { read: 1 }), member("b", { read: 1 }), member("c", { read: 0 })];
    assert.equal(atTable(members, transcript, -1), "c");
    assert.equal(atTable([member("a", { read: 0 }), member("b", { busy: true }), member("c", { read: 0 })], [say(1, "a", "all")], 0), "c");
  });
});

describe("the ending", () => {
  it("ends decided when the decider decided, before every other ending", () => {
    assert.equal(ending(check({ decider: "m", decided: true, silent: true, maxRounds: 1, members: [member("m", { done: true })] })), "decided");
  });

  it("ends agreed when every member said done and the room has no decider, even with new messages", () => {
    const members = [member("a", { done: true }), member("b", { done: true })];
    assert.equal(ending(check({ members, silent: false, maxRounds: 1 })), "agreed");
    assert.equal(ending(check({ members, decider: "a" })), undefined, "a room with a decider never ends agreed");
  });

  it("ends quiet when nobody would speak, before the limit", () => {
    assert.equal(ending(check({ members: [member("a"), member("b")], silent: true, maxRounds: 1 })), "quiet");
  });

  it("ends on the limit once the rounds reach maxRounds, and never without one", () => {
    const members = [member("a"), member("b")];
    assert.equal(ending(check({ members, rounds: 3, maxRounds: 3 })), "limit");
    assert.equal(ending(check({ members, rounds: 2, maxRounds: 3 })), undefined);
    assert.equal(ending(check({ members, rounds: 500 })), undefined, "maxRounds has no default");
  });

  it("does not end agreed or quiet while a member's turn waits for the person, but ends on the limit", () => {
    const members = [member("a", { done: true }), member("b", { done: true, busy: true })];
    assert.equal(ending(check({ members, silent: true })), undefined);
    assert.equal(ending(check({ members, silent: true, rounds: 2, maxRounds: 2 })), "limit");
  });
});

describe("the decider's last turn", () => {
  it("comes before any ending but decided, when the decider has not decided", () => {
    assert.equal(lastTurn("quiet", "m", false), true);
    assert.equal(lastTurn("limit", "m", false), true);
    assert.equal(lastTurn("decided", "m", true), false);
    assert.equal(lastTurn("agreed", undefined, false), false, "no decider, no last turn");
  });
});

// What a room member reads and how it answers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fabricateFromSchema } from "../../src/fabricate.js";
import type { RoomMessage } from "../../src/room/order.js";
import { decideNow, firstPrompt, laterPrompt, turnSchema, type PromptRoom } from "../../src/room/prompt.js";

const ROOM: PromptRoom = {
  name: "design",
  goal: "Agree on one design for the queue.",
  members: [
    { label: "claude", model: "opus", role: "You argue for the simplest design." },
    { label: "gpt", model: "codex/gpt-6-luna" },
    { label: "mediator" },
  ],
  turns: "together",
  hears: "all",
  decider: "mediator",
};

const TRANSCRIPT: RoomMessage[] = [
  { round: 0, from: "claude", to: "all", text: "Proposal: an event log." },
  { round: 0, from: "gpt", to: "all", text: "Proposal: a queue." },
  { round: 1, from: "mediator", to: "claude", text: "Can your design drop the queue?" },
  { round: 1, from: "gpt", to: "mediator", text: "The queue keeps order." },
];

type Node = Record<string, unknown>;
/** The texts of the messages a member's first prompt holds. */
const heard = (room: PromptRoom, label: string, transcript: RoomMessage[]) =>
  [...firstPrompt(room, label, transcript, 1).matchAll(/^\[\w+ to \w+\] (.*)$/gm)].map((match) => match[1]);
const props = (schema: Node) => schema["properties"] as Record<string, Node>;

describe("a member's first prompt", () => {
  it("holds the goal, the members with their models, its role, the rules and every message it hears", () => {
    const prompt = firstPrompt(ROOM, "claude", TRANSCRIPT, 1);
    assert.equal(
      prompt,
      [
        'Round 1. You are "claude", a member of the room "design". You argue for the simplest design.',
        "Goal:\nAgree on one design for the queue.",
        "Members:\n- claude (opus), you\n- gpt (codex/gpt-6-luna)\n- mediator, decides",
        [
          "How the room works:",
          "- The members talk in rounds. In each round, every member with a new message to it or to all speaks at the same time.",
          "- Each turn, answer with your messages and whether you are done. A message goes to one member by its label, or to all. A message to a member asks that member to answer.",
          "- Every member reads every message.",
          "- Set done to true when you have nothing more to add and accept where the room stands. A new message to you asks you to speak again.",
          "- Before you answer, you may read files and run tools, as in any task.",
        ].join("\n"),
        "Messages so far:\n[gpt to all] Proposal: a queue.\n[mediator to claude] Can your design drop the queue?\n[gpt to mediator] The queue keeps order.",
      ].join("\n\n"),
    );
  });

  it("tells the decider it decides, and in a moderated room that it names the next member", () => {
    const together = firstPrompt(ROOM, "mediator", [], 1);
    assert.match(together, /You decide for the room\. Put your decision in decision/);
    assert.doesNotMatch(together, /In next, name/);
    assert.match(together, /No messages yet\.$/);
    const moderated = firstPrompt({ ...ROOM, turns: "moderated" }, "mediator", [], 1);
    assert.match(moderated, /- In next, name the member who speaks next, or null when nobody needs to\./);
    assert.match(moderated, /- The decider speaks first and after each other turn/);
  });

  it("holds nothing that changes between two runs", () => {
    assert.equal(firstPrompt(ROOM, "gpt", TRANSCRIPT, 2), firstPrompt(ROOM, "gpt", structuredClone(TRANSCRIPT), 2));
    assert.doesNotMatch(firstPrompt(ROOM, "gpt", TRANSCRIPT, 2), /\d{4}-\d{2}-\d{2}|\d+:\d{2}|token/i);
  });
});

describe("a member's later prompt", () => {
  it("holds only the messages since its last turn, without its own", () => {
    assert.equal(
      laterPrompt(ROOM, "gpt", TRANSCRIPT, 2, 2),
      "Round 2. New messages since your last turn:\n[mediator to claude] Can your design drop the queue?",
    );
  });

  it("says so when nothing is new", () => {
    assert.equal(laterPrompt(ROOM, "gpt", TRANSCRIPT, 4, 3), "Round 3. No new messages since your last turn.");
  });

  it("holds only the messages to the member or to all when it hears what is addressed to it", () => {
    const addressed = { ...ROOM, hears: "addressed" as const };
    assert.deepEqual(heard(addressed, "gpt", TRANSCRIPT), ["Proposal: an event log."], "not the mediator's message to claude");
    assert.deepEqual(heard(addressed, "claude", TRANSCRIPT), ["Proposal: a queue.", "Can your design drop the queue?"]);
    assert.equal(laterPrompt(addressed, "gpt", TRANSCRIPT, 2, 2), "Round 2. No new messages since your last turn.", "a later turn leaves them out too");
    assert.match(firstPrompt(addressed, "claude", TRANSCRIPT, 1), /- Each member reads only the messages sent to it or to all\./);
  });
});

describe("the decider's last turn", () => {
  it("says why the room ends and asks for the decision now", () => {
    assert.equal(decideNow("quiet"), "The room ends now, because no member has anything new to say. Give your decision in decision now.");
    assert.equal(decideNow("limit", 6), "The room ends now, because it reached its limit of 6 rounds. Give your decision in decision now.");
  });
});

describe("the turn schemas", () => {
  it("gives a member its messages, to all or another member, and done", () => {
    const schema = turnSchema(ROOM, "claude");
    assert.deepEqual(schema["required"], ["messages", "done"]);
    assert.equal(schema["additionalProperties"], false);
    const items = props(schema)["messages"]!["items"] as Node;
    assert.deepEqual(props(items)["to"]!["enum"], ["all", "gpt", "mediator"], "all first, then the other members");
  });

  it("adds the decision to the decider's, with the room's schema first and null second", () => {
    const decision = { type: "object", properties: { design: { type: "string" } }, required: ["design"] };
    const schema = turnSchema({ ...ROOM, schema: decision }, "mediator");
    assert.deepEqual(schema["required"], ["messages", "done", "decision"]);
    assert.deepEqual((props(schema)["decision"]!["anyOf"] as Node[]), [decision, { type: "null" }]);
    assert.deepEqual((props(turnSchema(ROOM, "mediator"))["decision"]!["anyOf"] as Node[])[0], { type: "string" }, "a decision is text without a room schema");
  });

  it("adds next to the decider's in a moderated room", () => {
    const schema = turnSchema({ ...ROOM, turns: "moderated" }, "mediator");
    assert.deepEqual(schema["required"], ["messages", "done", "decision", "next"]);
    assert.deepEqual(props(schema)["next"]!["anyOf"], [{ type: "string", enum: ["claude", "gpt"] }, { type: "null" }]);
  });

  it("gives a dry-run stand-in that says one thing to all, is done, decides and names a member", () => {
    const decision = { type: "object", properties: { design: { type: "string" } }, required: ["design"] };
    const member = fabricateFromSchema(turnSchema(ROOM, "gpt")) as Node;
    assert.deepEqual([(member["messages"] as Node[]).length, (member["messages"] as Node[])[0]!["to"], member["done"]], [1, "all", true]);
    const decider = fabricateFromSchema(turnSchema({ ...ROOM, turns: "moderated", schema: decision }, "mediator")) as Node;
    assert.equal(typeof (decider["decision"] as Node)["design"], "string");
    assert.equal(decider["next"], "claude");
  });
});

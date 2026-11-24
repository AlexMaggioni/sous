// The messages a Claude step sends after its prompt, and what became of each one.
//
// A tell goes in with priority "next": Claude Code reads it after the current tool call, in the
// same turn. "now" aborts the turn with an empty result, and "later" starts a second turn, so
// neither is ever sent.

import type { UUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Steer, SteerOutcome } from "../seam.js";

export class Tells {
  private readonly outbox: SDKUserMessage[] = [];
  private readonly waiting = new Map<string, { text: string; settle(outcome: SteerOutcome): void }>();
  private state: "new" | "open" | "closed" = "new";
  private wake?: () => void;

  /** delivered gets the text of each tell the turn read. */
  constructor(private readonly delivered: (text: string) => void) {}

  /** Opens the seam once the turn has started. Undefined when it was open already or has closed. */
  open(): Steer | undefined {
    if (this.state !== "new") return undefined;
    this.state = "open";
    return (text, id) => this.send(text, id);
  }

  /** Ends the seam. Each tell still waiting resolves ended. True when the seam was open. */
  close(): boolean {
    const was = this.state === "open";
    this.state = "closed";
    this.outbox.length = 0;
    for (const id of [...this.waiting.keys()]) this.settle(id, "ended");
    this.wake?.();
    return was;
  }

  /** A command_lifecycle frame from Claude Code. */
  lifecycle(uuid: string, state: string) {
    if (state === "started" || state === "completed") this.settle(uuid, "delivered");
    else if (state === "cancelled") this.settle(uuid, "ended");
  }

  /** The uuids a result lists in user_message_uuids: the messages its turn read. */
  consumed(uuids: readonly string[] = []) {
    for (const uuid of uuids) this.settle(uuid, "delivered");
  }

  /** Each tell as the SDK should send it, until the seam closes. */
  async *messages(): AsyncGenerator<SDKUserMessage> {
    while (this.state !== "closed") {
      const next = this.outbox.shift();
      if (next) yield next;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private send(text: string, id: string): Promise<SteerOutcome> {
    if (this.state !== "open" || this.waiting.has(id)) return Promise.resolve("ended");
    return new Promise((settle) => {
      this.waiting.set(id, { text, settle });
      this.outbox.push({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
        priority: "next",
        uuid: id as UUID,
      });
      this.wake?.();
    });
  }

  private settle(id: string, outcome: SteerOutcome) {
    const tell = this.waiting.get(id);
    if (!tell) return;
    this.waiting.delete(id);
    if (outcome === "delivered") this.delivered(tell.text);
    tell.settle(outcome);
  }
}

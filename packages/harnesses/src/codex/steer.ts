// Messages sent into a running Codex turn, through turn/steer.

import type { Steer, SteerOutcome } from "../seam.js";
import { RpcError, type AppServer } from "./rpc.js";

/** What the adapter needs to steer one turn. */
export interface TurnSeam {
  server: AppServer;
  threadId: string;
  turnId: string;
  /** Gets the text of each message Codex took. */
  delivered(text: string): void;
  /** Gets a note for the step's result. */
  note(text: string): void;
}

const OLD_CODEX = "This Codex has no turn/steer, so a message could not reach the running turn. Update Codex to 0.169.0 or later.";

/** A seam onto one turn. close() makes every later message end, and is true when it was open. */
export function steerTurn(turn: TurnSeam): { send: Steer; close(): boolean } {
  let open = true;
  let noted = false;
  // Every message sent, by id, so a repeated id gets the first one's outcome and sends nothing.
  const sent = new Map<string, Promise<SteerOutcome>>();
  const send: Steer = (text, id) => {
    const earlier = sent.get(id);
    if (earlier) return earlier;
    const outcome = deliver(text, id);
    sent.set(id, outcome);
    return outcome;
  };
  const deliver = async (text: string, id: string): Promise<SteerOutcome> => {
    if (!open) return "ended";
    try {
      await turn.server.request("turn/steer", {
        threadId: turn.threadId,
        clientUserMessageId: id,
        input: [{ type: "text", text, text_elements: [] }],
        expectedTurnId: turn.turnId,
      });
    } catch (error) {
      if (unknownMethod(error)) {
        if (!noted) turn.note(OLD_CODEX);
        noted = true;
        return "not_steerable";
      }
      return refused(error);
    }
    turn.delivered(text);
    return "delivered";
  };
  return {
    send,
    close() {
      const was = open;
      open = false;
      return was;
    },
  };
}

/**
 * A Codex before 0.169.0 has no turn/steer. It answers -32601, or -32600 with a message that
 * names the method, as a request it cannot parse.
 */
function unknownMethod(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false;
  return error.code === -32601 || (error.code === -32600 && error.message.includes("turn/steer"));
}

/**
 * The outcome of a refused turn/steer. activeTurnNotSteerable, as during a compact turn, is
 * not_steerable. Anything else, such as -32600 "no active turn to steer" or a server that has
 * exited, means the turn is over.
 */
function refused(error: unknown): SteerOutcome {
  if (!(error instanceof RpcError)) return "ended";
  const info = (error.data as { codexErrorInfo?: unknown } | null | undefined)?.codexErrorInfo;
  return info !== null && typeof info === "object" && "activeTurnNotSteerable" in info ? "not_steerable" : "ended";
}

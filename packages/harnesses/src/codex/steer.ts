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
  const send: Steer = async (text, id) => {
    if (!open) return "ended";
    try {
      await turn.server.request("turn/steer", {
        threadId: turn.threadId,
        clientUserMessageId: id,
        input: [{ type: "text", text, text_elements: [] }],
        expectedTurnId: turn.turnId,
      });
    } catch (error) {
      const outcome = refused(error);
      if (outcome === "not_steerable" && error instanceof RpcError && error.code === -32601 && !noted) {
        noted = true;
        turn.note(OLD_CODEX);
      }
      return outcome;
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
 * The outcome of a refused turn/steer. activeTurnNotSteerable, as during a compact turn, and a
 * Codex without the method are not_steerable. Anything else, such as -32600 "no active turn to
 * steer" or a server that has exited, means the turn is over.
 */
function refused(error: unknown): SteerOutcome {
  if (!(error instanceof RpcError)) return "ended";
  if (error.code === -32601) return "not_steerable";
  const info = (error.data as { codexErrorInfo?: unknown } | null | undefined)?.codexErrorInfo;
  return info !== null && typeof info === "object" && "activeTurnNotSteerable" in info ? "not_steerable" : "ended";
}

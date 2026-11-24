// The seam into a running turn. The engine's steering board sends each tell through it.

/**
 * What became of a message sent into a running turn. delivered: the turn read it. not_steerable:
 * the program refused it, as Codex does during a compact turn. ended: the turn ended first, so the
 * message reached nothing.
 */
export type SteerOutcome = "delivered" | "not_steerable" | "ended";

/** Sends a message into the running turn. id names the message, so its outcome can be traced. */
export type Steer = (text: string, id: string) => Promise<SteerOutcome>;

// The agent calls that run now, each with the steer seam its program opened, so a tell reaches
// them. The steps module opens a call when its turn starts and closes it when the turn ends. The
// worker sends each `sous tell` through the board.

import type { Steer, SteerOutcome } from "@sous/harnesses";

/** An agent call: the run or nested run it runs in, its call index and its label. */
export interface LiveCall {
  scope: string;
  callIndex: number;
  label?: string;
}

/**
 * The calls a tell names: every open call of the label, or the `call`th of it, counted from 1 in
 * callIndex order among the calls the board has seen open. `scope` keeps the tell to one run or
 * nested run, and `callIndex` names one call exactly, as the worker does with the calls the cli
 * resolved.
 */
export interface TellTarget {
  label: string;
  call?: number;
  scope?: string;
  callIndex?: number;
}

const keyOf = (call: LiveCall) => `${call.scope}#${call.callIndex}`;

export class SteeringBoard {
  /** The open calls and their seams. */
  private readonly open_ = new Map<string, { call: LiveCall; send: Steer }>();
  /** Every call seen open, so a call keeps its number after an earlier one closed. */
  private readonly seen = new Map<string, LiveCall>();

  /** The call's turn started. Opening it again replaces its send. */
  open(call: LiveCall, send: Steer): void {
    const key = keyOf(call);
    this.open_.set(key, { call, send });
    if (!this.seen.has(key)) this.seen.set(key, call);
  }

  /** The call's turn ended. It is told nothing more. */
  close(call: LiveCall): void {
    this.open_.delete(keyOf(call));
  }

  /**
   * Send the text to each open call the target names, all with the same id. The results come in
   * callIndex order. A send that throws counts as ended. A target no open call has gives [].
   */
  async tell(target: TellTarget, text: string, id: string): Promise<Array<{ call: LiveCall; outcome: SteerOutcome }>> {
    const ofLabel = (call: LiveCall) => call.label === target.label && (target.scope === undefined || call.scope === target.scope);
    let keys = [...this.seen.values()]
      .filter(ofLabel)
      .sort((a, b) => a.callIndex - b.callIndex)
      .map(keyOf);
    if (target.callIndex !== undefined) keys = keys.filter((key) => this.seen.get(key)!.callIndex === target.callIndex);
    if (target.call !== undefined) keys = target.call >= 1 ? keys.slice(target.call - 1, target.call) : [];
    const told = keys.flatMap((key) => {
      const entry = this.open_.get(key);
      return entry ? [entry] : [];
    });
    return Promise.all(
      told.map(async ({ call, send }) => {
        let outcome: SteerOutcome;
        try {
          outcome = await send(text, id);
        } catch {
          outcome = "ended";
        }
        return { call, outcome };
      }),
    );
  }
}

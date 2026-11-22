// The error run() throws, and the usage sums both adapters keep.

import type { Failure, HarnessFailure, Usage } from "./types.js";

export class StepFailure extends Error implements HarnessFailure {
  failure: Failure;
  usage?: Usage;
  sessionId?: string;
  notes?: string[];

  constructor(message: string, failure: Failure, extra: { usage?: Usage; sessionId?: string; notes?: string[] } = {}) {
    super(message);
    this.name = "HarnessFailure";
    this.failure = failure;
    if (extra.usage) this.usage = extra.usage;
    if (extra.sessionId) this.sessionId = extra.sessionId;
    if (extra.notes?.length) this.notes = extra.notes;
  }
}

export const noUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

/** A usage with its total set by the one rule. */
export function usage(input: number, output: number, cacheRead: number, cacheWrite: number, costUsd?: number): Usage {
  const result: Usage = { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
  if (costUsd !== undefined) result.costUsd = costUsd;
  return result;
}

export function addUsage(a: Usage, b: Usage): Usage {
  const cost = a.costUsd === undefined && b.costUsd === undefined ? undefined : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return usage(a.input + b.input, a.output + b.output, a.cacheRead + b.cacheRead, a.cacheWrite + b.cacheWrite, cost);
}

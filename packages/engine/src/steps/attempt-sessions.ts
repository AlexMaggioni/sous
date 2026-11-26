import type { AgentSessionRecord, AgentSessionRef } from "../workflow-result.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { AgentResultProvenance, AgentUsage } from "./agent-run.js";
import { cloneTelemetry, deepFreeze } from "../strict-json.js";

export interface AttemptSessionEvent {
  state: "starting" | "open" | "closed";
  attempt: number;
  label: string;
  scope: string;
  callIndex: number;
  session?: AgentSessionRecord;
}

export interface AttemptSessionControl {
  observe(listener: (event: AttemptSessionEvent) => void): void;
}

interface SessionContext {
  label: string;
  scope: string;
  callIndex: number;
  phase?: string;
  keptOpen: boolean;
}

export interface AttemptSlots {
  sealed: boolean;
  attempt: number;
  context: SessionContext;
  usage?: AgentUsage;
  sessionRef?: AgentSessionRef;
  sessionCostGauge?: number;
  modelResolved?: string;
  provenance?: AgentResultProvenance;
  history?: AgentHistoryEntry[];
  sessions: AttemptSessionControl & {
    start(): void;
    open(ref: AgentSessionRef): void;
    close(): void;
  };
}

/** The backend opens the identity; a historical continuation candidate never does. */
export function createAttemptSlot(attempt: number, context: SessionContext): AttemptSlots {
  let observe: ((event: AttemptSessionEvent) => void) | undefined;
  const emit = (state: AttemptSessionEvent["state"], session?: AgentSessionRecord) => {
    const { label, scope, callIndex } = context;
    observe?.({ state, attempt, label, scope, callIndex, ...(session ? { session } : {}) });
  };
  const slot: AttemptSlots = {
    sealed: false, attempt, context,
    sessions: {
      observe(listener) { observe = listener; },
      start() { emit("starting"); },
      open(ref) {
        if (slot.sealed) return;
        const copied = cloneTelemetry(ref);
        if (!copied) return;
        slot.sessionRef = copied;
        emit("open", sessionRecord(slot, context.keptOpen));
      },
      close() { emit("closed"); },
    },
  };
  return slot;
}

export function sealAttempt(slot: AttemptSlots, sealedUsage: AgentUsage[]): void {
  if (slot.sealed) return;
  slot.sealed = true;
  if (slot.usage) sealedUsage.push(slot.usage);
  slot.sessions.close();
}

export function sessionRecord(slot: AttemptSlots, keptOpen: boolean): AgentSessionRecord | undefined {
  if (!slot.sessionRef) return undefined;
  const { label, callIndex, phase } = slot.context;
  return deepFreeze({
    ...slot.sessionRef,
    // Opening precedes the prompt; a continuation baselines the release-time gauge.
    ...(slot.sessionCostGauge === undefined ? {} : { costGauge: slot.sessionCostGauge }),
    callIndex, label, phase, keptOpen,
  });
}

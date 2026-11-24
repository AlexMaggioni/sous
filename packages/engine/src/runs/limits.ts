// The limits of one go of a run: its time limit and its token budget. Each start and each resume
// gets the whole of both. When a go reaches one, the running steps stop and the run pauses on
// them with the limit's reason. When no step runs, the run pauses the same way, and no new step
// starts.

import { parseDurationSeconds } from "../duration.js";
import type { HostPause } from "../host-pause.js";
import type { ActivityStep } from "../steps/activity.js";
import type { AgentUsage } from "../steps/agent-run.js";
import type { WorkflowManager } from "../workflow-manager.js";
import type { RunRecord } from "./records.js";

export interface GoLimits {
  /** For createSteps: the stop a new step meets once the go reached a limit. */
  gate: () => HostPause | undefined;
  /** For createSteps: the tokens an attempt of a step spent so far, and once more when it ends. */
  onUsage: (step: ActivityStep, usage: AgentUsage, ended?: boolean) => void;
  /** Count the go's tokens on the run's manager, and start the time limit's clock. */
  watch(manager: WorkflowManager): void;
  /** Stop the clock, once the go ends. */
  end(): void;
}

/**
 * The limits of this go of the record's run. The budget counts the tokens of the steps that ended
 * in this go, each step's own count, the attempts of running steps that ended, and what the
 * running attempts spent so far. A replayed step counts none. The tokens are the total sous show
 * reports: input, output, and cache reads and writes.
 */
export function goLimits(record: RunRecord, log: (line: string) => void): GoLimits {
  const runId = record.runId;
  const budget = record.budget;
  let manager: WorkflowManager | undefined;
  let reached: HostPause | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = 0;
  // By step: the tokens of its attempts that ended, and of the attempt that runs, until it ends.
  const attempts = new Map<string, number>();
  const running = new Map<string, number>();
  // The steps that ended in this go. A step the host stopped ends at once, and its runner reports
  // later, when its program has ended. The step's own count holds those tokens already.
  const closed = new Set<string>();
  const key = (step: { scope?: string; callIndex: number }) => `${step.scope ?? runId}#${step.callIndex}`;

  // The log says what happened: running steps stop and the run pauses on them, or no new step
  // starts, and the run pauses only if it had more to do.
  const reach = (stop: HostPause, line: string) => {
    if (reached) return;
    reached = stop;
    const cancelled = manager?.cancelAgentSteps(runId, stop) ?? 0;
    log(`${line}: ${cancelled ? "the running steps stop and the run pauses" : "no new step starts"}`);
    if (manager && !cancelled) manager.pause(runId, stop);
  };
  const check = () => {
    if (budget === undefined) return;
    let spent = ended;
    for (const tokens of attempts.values()) spent += tokens;
    for (const tokens of running.values()) spent += tokens;
    if (spent < budget) return;
    reach({ pauseReason: "budget", message: `the run reached its budget of ${budget} tokens` }, `${stamp()} budget     ${budget} tokens reached (${spent} spent)`);
  };

  return {
    gate: () => {
      check();
      return reached;
    },
    onUsage: (step, usage, done) => {
      const at = key(step);
      if (closed.has(at)) return;
      if (!done) {
        running.set(at, usage.total);
        check();
        return;
      }
      // An attempt that ended stops nothing: the gate of the next attempt or step, or the step's
      // end, checks its tokens.
      attempts.set(at, (attempts.get(at) ?? 0) + usage.total);
      running.delete(at);
    },
    watch(watched) {
      manager = watched;
      watched.on("agentEnd", (event) => {
        if (event.runId !== runId) return;
        // The step's own count, of all its attempts, takes the place of what was counted so far.
        closed.add(key(event));
        attempts.delete(key(event));
        running.delete(key(event));
        ended += event.tokens ?? 0;
        // The step that ended is still among the running ones until its call returns, so the
        // check waits for that, and stops only the steps that still run.
        queueMicrotask(check);
      });
      const limit = record.timeout ? parseDurationSeconds(record.timeout) : undefined;
      if (!limit) return;
      timer = setTimeout(() => {
        const stop: HostPause = { pauseReason: "time_limit", message: `the workflow's time limit of ${record.timeout} was reached` };
        reach(stop, `${stamp()} time limit ${record.timeout} reached`);
      }, limit * 1000);
    },
    end: () => clearTimeout(timer),
  };
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

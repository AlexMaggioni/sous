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
  /** For createSteps: the tokens a step spent so far while it runs. */
  onUsage: (step: ActivityStep, usage: AgentUsage) => void;
  /** Count the go's tokens on the run's manager, and start the time limit's clock. */
  watch(manager: WorkflowManager): void;
  /** Stop the clock, once the go ends. */
  end(): void;
}

/**
 * The limits of this go of the record's run. The budget counts the tokens of the steps that ended
 * in this go, each step's own count, and the tokens the running steps spent so far. A replayed
 * step counts none. A step's failed attempts count when the step ends.
 */
export function goLimits(record: RunRecord, log: (line: string) => void): GoLimits {
  const runId = record.runId;
  const budget = record.budget;
  let manager: WorkflowManager | undefined;
  let reached: HostPause | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = 0;
  const running = new Map<string, number>();
  const key = (step: { scope?: string; callIndex: number }) => `${step.scope ?? runId}#${step.callIndex}`;

  const reach = (stop: HostPause, line: string) => {
    if (reached) return;
    reached = stop;
    log(line);
    if (manager && !manager.cancelAgentSteps(runId, stop)) manager.pause(runId, stop);
  };
  const check = () => {
    if (budget === undefined) return;
    let spent = ended;
    for (const tokens of running.values()) spent += tokens;
    if (spent < budget) return;
    reach(
      { pauseReason: "budget", message: `the run reached its budget of ${budget} tokens` },
      `${stamp()} budget     ${budget} tokens reached (${spent} spent): the running steps stop and the run pauses`,
    );
  };

  return {
    gate: () => {
      check();
      return reached;
    },
    onUsage: (step, usage) => {
      running.set(key(step), usage.total);
      check();
    },
    watch(watched) {
      manager = watched;
      watched.on("agentEnd", (event) => {
        if (event.runId !== runId) return;
        running.delete(key(event));
        ended += event.tokens ?? 0;
        check();
      });
      const limit = record.timeout ? parseDurationSeconds(record.timeout) : undefined;
      if (!limit) return;
      timer = setTimeout(() => {
        const stop: HostPause = { pauseReason: "time_limit", message: `the workflow's time limit of ${record.timeout} was reached` };
        reach(stop, `${stamp()} time limit ${record.timeout} reached: the running steps stop and the run pauses`);
      }, limit * 1000);
    },
    end: () => clearTimeout(timer),
  };
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

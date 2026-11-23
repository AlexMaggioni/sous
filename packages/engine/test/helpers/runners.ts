// Agent runners for tests of the manager and the engine, in place of the programs.

import type { AgentUsage, StepRequest } from "../../src/steps/agent-run.js";
import type { AgentRunner } from "../../src/steps/agent-runner.js";

/** A runner that answers each call with what `impl` returns or resolves to. */
export function runnerFrom(impl: (prompt: string, options: StepRequest) => unknown | Promise<unknown>): AgentRunner {
  return { run: (prompt: string, options: StepRequest) => Promise.resolve(impl(prompt, options)) };
}

/** A runner that reports `usage` on top of zeros, so token accounting runs, and answers `result`. */
export function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

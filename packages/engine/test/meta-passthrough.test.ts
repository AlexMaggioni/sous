import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, StepRequest } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import { runWorkflow } from "../src/workflow.js";

// A script may still set agent({ meta, promptMeta }). They count in the call's inputs, so a
// resumed session notices a change, but no step reads them and they stay out of the resume hash.
// cwd.test.ts checks the hash for all the additive options.

describe("agent({ meta, promptMeta })", () => {
  it("are accepted, and no step receives them", async () => {
    let given: Record<string, unknown> | undefined;
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: StepRequest<S>,
      ): Promise<AgentResult<S>> {
        given = options as Record<string, unknown> | undefined;
        return "ok" as AgentResult<S>;
      },
    };
    const script = `export const meta = { name: 'm', description: 'meta' }
const a = await agent('p', {
  label: 'a',
  meta: { credsRef: 'vault://qa', allowedDomains: ['preview.example.com'] },
  promptMeta: { viewport: '1280x800' },
})
return a`;

    const result = await runWorkflow(script, { agent: capturing, persistLogs: false });

    assert.equal(result.result, "ok");
    assert.ok(given);
    assert.equal("meta" in given, false);
    assert.equal("promptMeta" in given, false);
  });
});

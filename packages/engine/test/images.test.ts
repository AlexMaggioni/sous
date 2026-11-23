import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, PromptImage, StepRequest } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import { runWorkflow } from "../src/workflow.js";

// agent({ images }) is an additive run input. The engine threads it through to the runner opts
// verbatim, and the steps module hands each image to the harness. It stays out of the resume
// identity hash, which cwd.test.ts checks for all the additive options.

describe("agent({ images }) plumbing", () => {
  it("threads images from agent() into the runner opts", async () => {
    let images: readonly PromptImage[] | undefined;
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: StepRequest<S>,
      ): Promise<AgentResult<S>> {
        images = options?.images;
        return "ok" as AgentResult<S>;
      },
    };
    const script = `export const meta = { name: 'm', description: 'images' }
const a = await agent('p', {
  label: 'a',
  images: [{ data: 'ZmFrZQ==', mimeType: 'image/png', uri: 'file:///tmp/a.png' }],
})
return a`;

    await runWorkflow(script, { agent: capturing, persistLogs: false });

    // Cross-realm objects have a different Object.prototype; normalize through JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(images)), [
      { data: "ZmFrZQ==", mimeType: "image/png", uri: "file:///tmp/a.png" },
    ]);
  });

  it("passes undefined through when images are not provided", async () => {
    let sawOptions = false;
    let images: unknown = "sentinel";
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: StepRequest<S>,
      ): Promise<AgentResult<S>> {
        sawOptions = true;
        images = options?.images;
        return "ok" as AgentResult<S>;
      },
    };
    await runWorkflow(
      `export const meta = { name: 'm', description: 'images' }
return await agent('p', { label: 'a' })`,
      { agent: capturing, persistLogs: false },
    );
    assert.ok(sawOptions);
    assert.equal(images, undefined);
  });
});

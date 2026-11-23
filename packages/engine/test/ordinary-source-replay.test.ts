import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WorkflowManager } from "../src/workflow-manager.js";

const ENVIRONMENT_KEY = "ordinary-source-replay-v1";
const workflow = (body: string, name: string) =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "ordinary source replay" }\n${body}`;

function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ordinary-source-replay-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("journal replay of an ordinary source", () => {
  it("replays an ordinary source without requiring filesystem declarations", async () => {
    const dirs = tempRoot();
    let liveCalls = 0;
    const manager = new WorkflowManager({
      persistenceRoot: dirs.root,
      environmentKey: ENVIRONMENT_KEY,
      agent: { async run(prompt) { liveCalls++; return `live:${prompt}:${liveCalls}`; } },
    });
    const script = workflow(`
await agent("ordinary-one", { label: "ordinary-one" })
return await agent("ordinary-two", { label: "ordinary-two" })`, "safe-prefix-prediction");
    try {
      const source = await manager.runSync(script);
      assert.equal(source.status, "completed");
      const resumed = await manager.runSync(script, undefined, { resumeFromRunId: source.runId });
      assert.equal(resumed.status, "completed");
      assert.equal(resumed.resumeReport?.strategy, "identity-v1");
      assert.equal(resumed.replayEligibility?.predictedReplayablePrefix, 2);
      assert.equal(resumed.replayEligibility?.replayedPrefix, 2);
      assert.equal(resumed.resumeReport?.replayed, 2);
      assert.equal(resumed.resumeReport?.live, 0);
      assert.equal(liveCalls, 2);
    } finally {
      dirs.cleanup();
    }
  });
});

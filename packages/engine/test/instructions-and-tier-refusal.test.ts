import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lookupAgents } from "../src/agents.js";
import type { PlannedRequest } from "../src/steps/agent-run.js";
import { createSteps } from "../src/steps/steps.js";
import { runWorkflow } from "../src/workflow.js";

function capturingRunner(capture: (options: PlannedRequest) => void) {
  return {
    async run(_prompt: string, options: PlannedRequest) {
      capture(options);
      return "ok";
    },
  };
}

test("run-level instructions are prepended to the instructions of an agent the steps module routes", async () => {
  const seen: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "instructions-steps-"));
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".rulesync", "subagents"), { recursive: true });
  writeFileSync(join(projectDir, ".rulesync", "subagents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\n---\nAct as the reviewer.\n");
  const env = { CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), XDG_CONFIG_HOME: join(root, "config") };
  const script = `export const meta = { name: 'i', description: 'instructions' }
phase('Review')
return await agent('check', { label: 'a', agentType: 'reviewer' })`;

  try {
    await runWorkflow(script, {
      agent: createSteps({
        cwd: projectDir,
        inner: capturingRunner((options) => seen.push(String(options.instructions))),
        agents: lookupAgents({ projectDir, rulesyncGlobal: join(root, "aiglobal"), defaultHarness: "claude", env }),
      }),
      instructions: "Run-level guidance.",
      persistLogs: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(seen.length, 1);
  assert.ok(
    seen[0].startsWith("Run-level guidance.\n\nAct as the reviewer."),
    "run instructions should be prepended before agentType guidance",
  );
  assert.ok(seen[0].includes("Workflow phase: Review"), "existing composed instructions are preserved");
});

test("unset run-level instructions leave an otherwise plain agent with no instructions", async () => {
  let instructions: unknown = "sentinel";
  await runWorkflow(
    `export const meta = { name: 'i2', description: 'instructions' }
return await agent('plain', { label: 'a' })`,
    {
      agent: capturingRunner((options) => {
        instructions = options.instructions;
      }),
      persistLogs: false,
    },
  );

  assert.equal(instructions, undefined);
});

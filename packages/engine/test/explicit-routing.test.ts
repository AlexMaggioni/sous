import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import { runWorkflow } from "../src/workflow.js";

test("parallel completion order and dynamic branches preserve their actual routes", async () => {
  const calls: Array<{ prompt: string; model?: string }> = [];
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const agent: AgentRunner = {
    async run(prompt, options) {
      calls.push({ prompt, model: options.model });
      if (prompt === "slow") await slow;
      if (prompt === "after-fast") releaseSlow();
      return prompt;
    },
  };
  await runWorkflow(`export const meta = { name: "dynamic-routes", description: "Concurrent routes" };
await parallel([
  async () => { await agent("slow", { model: "claude" }); return agent("after-slow", { model: "claude" }); },
  async () => { await agent("fast", { model: "codex" }); return agent("after-fast", { model: "codex" }); },
]);
const choice = await agent("choose", { model: "codex" });
if (choice === "choose") return agent("live-branch", { model: "pi/provider/model" });
return agent("mock-branch", { model: "opencode/provider/model" });`, {
    agent, concurrency: 2, persistLogs: false,
  });
  assert.deepEqual(calls, [
    { prompt: "slow", model: "claude" }, { prompt: "fast", model: "codex" },
    { prompt: "after-fast", model: "codex" }, { prompt: "after-slow", model: "claude" },
    { prompt: "choose", model: "codex" }, { prompt: "live-branch", model: "pi/provider/model" },
  ]);
});

test("routing resolves definitions, tiers, phase defaults, and backend-only routes", async () => {
  const routes: Array<string | undefined> = [];
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "explicit-routing-home-"));
  mkdirSync(join(home, ".agentprism", "workflows"), { recursive: true });
  writeFileSync(join(home, ".agentprism", "workflows", "model-tiers.json"), JSON.stringify({ tiers: { small: "pi/provider/small" } }));
  process.env.HOME = home;
  try {
    await runWorkflow(`export const meta = { name: "route-sources", description: "Effective route sources", model: "codex", phases: [{ title: "General" }, { title: "Review", model: "claude" }] };
await agent("workflow default");
await agent("definition", { agentType: "reviewer" });
await agent("tier", { tier: "small" });
await agent("tier fallback", { tier: "big" });
phase("Review");
await agent("phase");
return agent("explicit", { model: "opencode" });`, {
      agent: { async run(_prompt, options) { routes.push(options.model); return "ok"; } },
      persistLogs: false, mainModel: "pi/provider/main",
      agentRegistry: new Map([["reviewer", { name: "reviewer", prompt: "Review", source: "project", model: "claude/defined" }]]),
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
  assert.deepEqual(routes, ["codex", "claude/defined", "pi/provider/small", "pi/provider/main", "claude", "opencode"]);
});

test("aggregator selectors fail before dispatch", async () => {
  await assert.rejects(runWorkflow(`export const meta = { name: "selector", description: "Discovery is explicit" }; return agent("work", { model: "opencode/openrouter/*" });`, {
    agent: { async run() { assert.fail("selectors must never dispatch"); } }, persistLogs: false,
  }), /discovery selector/);
});

test("configuration is captured at call time before queued dispatch", async () => {
  const seen: unknown[] = [];
  const result = await runWorkflow(`export const meta = { name: "config-capture", description: "Captured call configuration", model: "codex" };
const configOptions = { reasoning_effort: "high" };
const pending = agent("work", { configOptions });
configOptions.reasoning_effort = "low";
return await pending;`, {
    agent: { async run(_prompt, options) { assert.equal("configOptions" in options, false); return "ok"; } },
    onAgentStart: (event) => seen.push(event.configOptions),
    persistLogs: false,
  });
  assert.deepEqual(seen, [{ reasoning_effort: "high" }]);
  assert.deepEqual(result.calls[0].configOptionsRequested, { reasoning_effort: "high" });
});

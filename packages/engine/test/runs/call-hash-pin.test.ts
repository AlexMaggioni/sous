import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { createRun } from "../../src/runs/launch.js";
import { readState } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import type { AgentRunner } from "../../src/steps/agent-runner.js";
import { setup } from "./fixture.js";

// The call hash decides which steps replay when a run resumes. These pins hold the hash of each
// kind of step, read from the saved journal of a whole run, so a change that moves one shows.

// The agent lookup reads the harnesses' home folders. These tests give it empty ones.
const harnessHome = mkdtempSync(join(tmpdir(), "engine-pin-harness-home-"));
process.env.CLAUDE_CONFIG_DIR = join(harnessHome, ".claude");
process.env.CODEX_HOME = join(harnessHome, ".codex");
process.env.XDG_CONFIG_HOME = join(harnessHome, ".config");
delete process.env.AGENTPRISM_DEFAULT_BACKEND;

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const AGENTS: Record<string, string> = {
  // A block model on each harness. Claude Code is the default harness.
  reviewer: "---\nname: reviewer\ndescription: reviews\nclaudecode:\n  model: haiku\n  tools: [Read]\n  effort: high\ncodexcli:\n  model: gpt-test\n  model_reasoning_effort: low\n---\nAnswer REVIEW.\n",
  // No block model.
  implementer: "---\nname: implementer\ndescription: builds\n---\nBuild it.\n",
  // A block model that names its harness, which doubles the prefix.
  doubler: "---\nname: doubler\ndescription: doubles\nclaudecode:\n  model: claude/haiku\n---\nDouble it.\n",
  isolated: "---\nname: isolated\ndescription: works apart\nisolation: worktree\n---\nWork apart.\n",
};

interface Seen {
  label?: string;
  model?: unknown;
  toolNames?: unknown;
  effort?: unknown;
  instructions?: unknown;
}

function standIn(): { runner: AgentRunner; seen: Seen[] } {
  const seen: Seen[] = [];
  const runner = {
    async run(_prompt: string, options: Record<string, unknown> = {}) {
      const label = options.label as string | undefined;
      seen.push({ label, model: options.model, toolNames: options.toolNames, effort: options.effort, instructions: options.instructions });
      return options.schema ? { ok: true } : `${label} done`;
    },
  } as unknown as AgentRunner;
  return { runner, seen };
}

const quiet = () => {};

/** Each call's hash from the saved journal, with what the call record keeps beside it. */
function pins(paths: Parameters<typeof readState>[0], runId: string) {
  const state = readState(paths, runId);
  assert.ok(state, "the run was saved");
  const journal = new Map((state.journal ?? []).map((entry) => [entry.index, entry.hash]));
  return Object.fromEntries(
    (state.calls ?? []).map((call) => {
      assert.equal(journal.get(call.index), call.hash, `the journal and the call record agree for ${call.label}`);
      return [call.label, { hash: journal.get(call.index), model: call.modelRequested ?? null, inputs: call.inputsHash }];
    }),
  );
}

async function runOne(workflow: string, script: string, request: { defaultModel?: string; overrides?: Record<string, Record<string, unknown>> } = {}) {
  const { paths, projectDir } = setup({ [workflow]: script });
  for (const [name, content] of Object.entries(AGENTS)) write(join(projectDir, ".rulesync", "subagents", `${name}.md`), content);
  const { runner, seen } = standIn();
  const record = createRun(paths, { workflow, projectDir, inputs: {}, ...request });
  const result = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
  return { paths, projectDir, record, result, seen };
}

describe("the call hash", () => {
  it("keeps its bytes for steps with and without an agent", async () => {
    const run = await runOne(
      "pins",
      `export const meta = { name: 'pins', description: 'one step per hash input' }
await agent('Plain step', { label: 'plain' })
await agent('Haiku step', { label: 'haiku', model: 'claude/haiku' })
await agent('Review it', { label: 'reviewer', agentType: 'reviewer' })
await agent('Review it', { label: 'reviewer on codex', agentType: 'reviewer', model: 'codex' })
await agent('Double it', { label: 'doubled', agentType: 'doubler' })
await agent('Effort step', { label: 'effort', effort: 'high', skills: ['tdd'] })
await agent('Mode step', { label: 'mode', mode: 'plan' })
await agent('Schema step', { label: 'schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
await sh('echo pinned', { label: 'code' })
await agent('Isolated step', { label: 'isolated', agentType: 'isolated' })
return 'done'`,
    );
    assert.equal(run.result?.status, "completed");
    assert.deepEqual(pins(run.paths, run.record.runId), {
      plain: { hash: "bdb6845eaa3d2a5929d99f03b20e28523f7177047d889e53d4b09fea7c37bd5a", model: null, inputs: "50526967a1114655a6e0cda28feeb866221cea7710b83d3f107ee67d01c126a4" },
      haiku: { hash: "4456e2f3ac6a997389463a97536dc4693b690ba24321fe7da9f5dd0ecd57bed9", model: "claude/haiku", inputs: "78ee4d72b673292e77b1e676bb6178a72e0a88cf33a30b64c37880c2f09fba23" },
      reviewer: { hash: "e39a1105d357ac13500f89dd9902e484fb4f71b849809dc3603963ae8d0bf8b4", model: "claude/haiku", inputs: "a3952b706b9bfba2eceb055685ac1b588ba96e32cbc4fa0da0023c7249687288" },
      "reviewer on codex": { hash: "c5cd74b88a38393a6ee7eb8880c631f240837704e82e6a4e7c9d147e443857ac", model: "codex", inputs: "ce3c475ebae7be6900fabaa692fc1118a8e3f618e954d926ac339e92d7237905" },
      doubled: { hash: "809a258c3f61e3f22f70a5cdc62f14e515d6d0fdc7f3941b496d8cf9b93077de", model: "claude/claude/haiku", inputs: "a202d025fc7b4e4695d9c4bedf9f54ca705805b217a64a85fcf172a4334ab221" },
      effort: { hash: "da26c369e69b91e478c1d98722ccc27243f3f26e9db2d6a483644378230a735f", model: null, inputs: "ea69847dd59c17581757b01ede7f5159836623aae27a69add67a3dba13837376" },
      mode: { hash: "bb3fbf3cca3731c6c66622b728d6692b3c08ebadefc86fe63b4d1a3a1aa91517", model: null, inputs: "6135cb67525571c70c6e177d39ccacfe855158158ee89e9a1e912a3f91bcf581" },
      schema: { hash: "2a0e904209b75b111cc5bf8392b5b88678e3fa91ebee32fdaefcfdb7d3a1dde3", model: null, inputs: "4ee67cdc7b2a340afbd22a4103936d45cdec122a066841b3cdea76c512bcef5d" },
      code: { hash: "335010b0cf530bf9537fc6a672da45feed9b11ad798a82cdc18a5676c92558c2", model: "exec", inputs: "582efe946dbcdf739ba5e17a5bdb8eeff001ffbdb868f54a2d96234755e1307c" },
      isolated: { hash: "842de33b776fa053446ac99d619aec453e490e0e4a2655f67d0e2c4bbfc91665", model: null, inputs: "9dfa2c578e4fde544ae4c587ebbf8953d179d9748a8ab36f62cc5ee87ceaf6ad" },
    });

    const by = (label: string) => run.seen.find((call) => call.label === label)!;
    // An agent on its default harness gets that harness's block.
    assert.deepEqual([by("reviewer").model, by("reviewer").toolNames, by("reviewer").effort], ["claude/haiku", ["Read"], "high"]);
    assert.match(String(by("reviewer").instructions), /Answer REVIEW\./);
    // Case a: the hash keeps "codex", and the step runs the Codex block's model.
    assert.deepEqual([by("reviewer on codex").model, by("reviewer on codex").toolNames, by("reviewer on codex").effort], ["codex/gpt-test", undefined, "low"]);
    assert.match(String(by("reviewer on codex").instructions), /Answer REVIEW\./);
    // The doubled prefix reaches the runner as it is.
    assert.equal(by("doubled").model, "claude/claude/haiku");
    assert.match(String(by("doubled").instructions), /Double it\./);
    assert.match(String(by("isolated").instructions), /Work apart\.[\s\S]*Requested isolation: worktree/);
    assert.deepEqual([by("plain").model, by("haiku").model, by("effort").effort], [undefined, "claude/haiku", "high"]);
  });

  it("keeps its bytes for the run's model, a per-run override and an agent with no block model", async () => {
    const run = await runOne(
      "defaults",
      `export const meta = { name: 'defaults', description: 'the run model' }
await agent('Plain step', { label: 'run model' })
await agent('Override step', { label: 'over' })
await agent('Build it', { label: 'no block model', agentType: 'implementer' })
return 'done'`,
      { defaultModel: "codex/gpt-run", overrides: { over: { model: "claude/sonnet" } } },
    );
    assert.equal(run.result?.status, "completed");
    assert.deepEqual(pins(run.paths, run.record.runId), {
      "run model": { hash: "d38fddfe6d05571a0b52525572c88e1a5c6d744cb6330e8198bd8ba56a069e71", model: "codex/gpt-run", inputs: "729ed414f1a3e5aad773472781b92784e1be3c05f2119a321bf75ddd5c8f03a6" },
      over: { hash: "68e91f31b3485dca4a1740f0cee01c147201ca2d6ba338d984f86980d81ce4cc", model: "claude/sonnet", inputs: "d98b23dc15c655f8e2bb9c2225926443cbf899e86e6ccf25883f4ae6224eeb4e" },
      "no block model": { hash: "469b59402c840102568d780b8fe262a98e7498a06232a9b911f8c4bb118d997e", model: "codex/gpt-run", inputs: "8791aac3341f6fa57b7d5755ae96add8187955e941eb4cbe2a78d5b0014a4cca" },
    });
    const by = (label: string) => run.seen.find((call) => call.label === label)!;
    assert.deepEqual([by("run model").model, by("over").model], ["codex/gpt-run", "claude/sonnet"]);
    // Case b: the hash has the run's model, and the agent runs on its own harness alone.
    assert.equal(by("no block model").model, "claude");
    assert.match(String(by("no block model").instructions), /Build it\./);
  });

  it("keeps its bytes for meta.model and a phase route", async () => {
    const run = await runOne(
      "routed",
      `export const meta = { name: 'routed', description: 'meta model and a phase route', model: 'claude/sonnet', phases: [{ title: 'Plan' }, { title: 'Review', model: 'codex/gpt-phase' }] }
await agent('Meta step', { label: 'meta model' })
phase('Review')
await agent('Phase step', { label: 'phase route' })
return 'done'`,
    );
    assert.equal(run.result?.status, "completed");
    assert.deepEqual(pins(run.paths, run.record.runId), {
      "meta model": { hash: "bc416053513b448327ee5ccf02b57968fbc6b65979f6f0eaebd660f9e89e2008", model: "claude/sonnet", inputs: "1f44a396337c4fc7f7211363bce97e2982fd6e548002d8c46c6499ca8004ea60" },
      "phase route": { hash: "00b665ce16abc2aa2539303eed78ed45eddc99dd1a1525f1c159b4aba3f9c8e8", model: "codex/gpt-phase", inputs: "8543e816715270f2b832b4579210b8be9e8db14950a8c468175e50d36ce249fb" },
    });
    const by = (label: string) => run.seen.find((call) => call.label === label)!;
    assert.deepEqual([by("meta model").model, by("phase route").model], ["claude/sonnet", "codex/gpt-phase"]);
  });

  it("refuses a step with a tier, so no call keeps a hash for it", async () => {
    const run = await runOne(
      "tiered",
      `export const meta = { name: 'tiered', description: 'a tier' }
await agent('Tier step', { label: 'tier', tier: 'small' })
return 'done'`,
      { defaultModel: "codex/gpt-run" },
    );
    // tier is gone. The hash still holds "tier": null, so the pins above keep their bytes.
    assert.equal(run.result?.status, "failed");
    assert.equal(run.result?.reason, 'tier is gone. Set the model with model, such as "claude/haiku", or name an agent with agentType.');
    assert.deepEqual(pins(run.paths, run.record.runId), {});
    assert.equal(run.seen.length, 0, "a step with a tier never reaches the runner");
  });
});

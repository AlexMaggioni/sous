import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentResult, StepRequest } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { TSchema } from "typebox";
import { CALL_INPUTS_FORMAT, type WorkflowRunOptions, runWorkflow } from "../src/workflow.js";
import { tempPlaces } from "./helpers/places.js";

type RunOverrides = Omit<WorkflowRunOptions, "agent">;

async function fingerprintFor(optionsSource: string, overrides: RunOverrides = {}): Promise<string | undefined> {
  let fingerprint: string | undefined;
  const runner: AgentRunner = {
    async run<S extends TSchema | undefined = undefined>(
      _prompt: string,
      options?: StepRequest<S>,
    ): Promise<AgentResult<S>> {
      fingerprint = options?.callInputsHash;
      return "ok" as AgentResult<S>;
    },
  };
  await runWorkflow(
    `export const meta = { name: 'fingerprint', description: 'input fingerprint' }
await Promise.resolve()
return await agent('same-prompt', ${optionsSource})`,
    { ...overrides, agent: runner, persistLogs: false },
  );
  return fingerprint;
}

describe("agent input fingerprints", () => {
  it("pins the format and exact canonical bytes for default effective inputs", async () => {
    assert.equal(CALL_INPUTS_FORMAT, 2);
    const fingerprint = await fingerprintFor("{}");
    const canonical = JSON.stringify({
      backends: null,
      cwd: null,
      images: null,
      isolation: null,
      keepSession: false,
      label: "agent 1",
      mcpServers: null,
      meta: null,
      promptMeta: null,
    });
    const expected = createHash("sha256").update(canonical).digest("hex");

    assert.equal(fingerprint, expected);
  });

  it("sorts record keys recursively while preserving array order", async () => {
    const keysA = await fingerprintFor("{ label: 'fixed', mcpServers: [{ name: 'tools', command: 'tool-server', args: ['--stdio'] }] }");
    const keysB = await fingerprintFor("{ mcpServers: [{ args: ['--stdio'], command: 'tool-server', name: 'tools' }], label: 'fixed' }");
    const ordered = await fingerprintFor("{ label: 'fixed', mcpServers: [{ name: 'a', command: 'a' }, { name: 'b', command: 'b' }] }");
    const reordered = await fingerprintFor("{ label: 'fixed', mcpServers: [{ name: 'b', command: 'b' }, { name: 'a', command: 'a' }] }");

    assert.equal(keysA, keysB);
    assert.notEqual(ordered, reordered);
  });

  it("changes for every script-level unhashed execution input", async () => {
    const nonGitCwd = mkdtempSync(join(tmpdir(), "ap-inputs-nogit-"));
    try {
      const baseline = await fingerprintFor("{ label: 'fixed' }", { cwd: nonGitCwd });
      const variants = await Promise.all([
        fingerprintFor("{ label: 'fixed', images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] }", {
          cwd: nonGitCwd,
        }),
        fingerprintFor("{ label: 'fixed', cwd: 'packages/engine' }", { cwd: nonGitCwd }),
        fingerprintFor(
          "{ label: 'fixed', mcpServers: [{ name: 'tools', command: 'tool-server', args: ['--stdio'], env: [] }] }",
          { cwd: nonGitCwd },
        ),
        fingerprintFor("{ label: 'fixed', keepSession: true }", { cwd: nonGitCwd }),
        fingerprintFor("{ label: 'fixed', isolation: 'worktree' }", { cwd: nonGitCwd }),
      ]);

      for (const variant of variants) {
        assert.notEqual(variant, baseline);
      }
    } finally {
      rmSync(nonGitCwd, { recursive: true, force: true });
    }
  });

  it("hashes the resolved explicit/default label", async () => {
    const trimmed = await fingerprintFor("{ label: '  fixed  ' }");
    const fixed = await fingerprintFor("{ label: 'fixed' }");
    const changed = await fingerprintFor("{ label: 'changed' }");
    let afterCheckpoint: string | undefined;
    await runWorkflow(
      `export const meta = { name: 'default-label', description: 'default label path' }
await checkpoint('occupy index')
return await agent('same-prompt')`,
      {
        agent: {
          async run(_prompt, options) {
            afterCheckpoint = options?.callInputsHash;
            return "ok";
          },
        },
        confirm: async () => true,
        persistLogs: false,
      },
    );
    const firstDefault = await fingerprintFor("{}");

    assert.equal(trimmed, fixed, "labels are fingerprinted after engine trimming");
    assert.notEqual(changed, fixed);
    assert.notEqual(afterCheckpoint, firstDefault, "default labels include the resolved shared agent ordinal");
  });

  it("excludes run-level and per-call operational knobs from the fingerprint", async () => {
    const baseline = await fingerprintFor("{ label: 'fixed' }");
    const variants = await Promise.all([
      fingerprintFor("{ label: 'fixed' }", { agentRetries: 1 }),
      fingerprintFor("{ label: 'fixed', retries: 2 }", { agentRetries: 0 }),
      fingerprintFor("{ label: 'fixed' }", { concurrency: 1 }),
      fingerprintFor("{ label: 'fixed' }", { concurrency: 8 }),
    ]);

    for (const variant of variants) assert.equal(variant, baseline);
  });

  it("uses pre-resolution isolation inputs while exposing the actual worktree cwd", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ap-inputs-git-"));
    const home = tempPlaces();
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    const fingerprints: Array<string | undefined> = [];
    const resolvedCwds: string[] = [];
    const runner: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: StepRequest<S>,
      ): Promise<AgentResult<S>> {
        fingerprints.push(options?.callInputsHash);
        if (options?.cwd) resolvedCwds.push(options.cwd);
        return "ok" as AgentResult<S>;
      },
    };
    const script = `export const meta = { name: 'worktree-input', description: 'worktree input' }
return await agent('same-prompt', { label: 'fixed', isolation: 'worktree' })`;

    try {
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      writeFileSync(join(repo, "file.txt"), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");

      await runWorkflow(script, { runId: "worktree-a", cwd: repo, agent: runner, persistLogs: false, places: home.places("worktree-a") });
      await runWorkflow(script, { runId: "worktree-b", cwd: repo, agent: runner, persistLogs: false, places: home.places("worktree-b") });

      assert.equal(fingerprints[0], fingerprints[1]);
      assert.equal(resolvedCwds.length, 2);
      assert.notEqual(resolvedCwds[0], resolvedCwds[1]);
      assert.notEqual(resolvedCwds[0], repo);
      assert.notEqual(resolvedCwds[1], repo);
      assert.match(resolvedCwds[0], /worktree-a-0-fixed$/);
      assert.match(resolvedCwds[1], /worktree-b-0-fixed$/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      home.cleanup();
    }
  });

  it("omits the whole fingerprint when a vm-authored component is not strict JSON", async () => {
    const fingerprint = await fingerprintFor("{ label: 'fixed', mcpServers: [{ name: 'tools', command: 'tool-server', invalid: () => 2 }] }");
    assert.equal(fingerprint, undefined);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACP_CROSS_CUTTING_EVENT_NAMES,
  ACP_EXTENSION_SUPPORT_MATRIX,
  FORK_SESSION_TRAITS,
  SYSTEM_PROMPT_SUPPORT,
} from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("cross-cutting ACP event names are documented in public event tables", () => {
  const docs = ["packages/acp-agents/README.md"];

  for (const path of docs) {
    const text = readRepoFile(path);
    for (const name of ACP_CROSS_CUTTING_EVENT_NAMES) {
      assert.ok(text.includes(`\`${name}\``), `${path} must document ${name}`);
    }
  }
});

test("steering documentation stays aligned with the executable extension matrix", () => {
  assert.deepEqual(
    ACP_EXTENSION_SUPPORT_MATRIX.map(({ agent, disposition }) => ({ agent, disposition })),
    [
      { agent: "claude", disposition: "supported" },
      { agent: "codex", disposition: "supported" },
      { agent: "claude", disposition: "not-advertised" },
      { agent: "codex", disposition: "supported" },
    ],
  );
  for (const path of ["packages/acp-agents/README.md"]) {
    const text = readRepoFile(path);
    assert.ok(text.includes("_session/steering"), `${path} must document the steering extension`);
  }
});

// The per-backend fork dispositions and the prompt-usage scope are executable data in
// protocol-coverage.ts; the public docs that describe the SDK must carry the same rows and the
// per-turn statement, so a trait change cannot land without its prose.
test("fork traits and prompt-usage scope are documented per backend wherever the SDK is described", () => {
  for (const path of ["packages/acp-agents/README.md"]) {
    const text = readRepoFile(path);
    assert.ok(text.includes("`FORK_SESSION_TRAITS`"), `${path} must name the fork trait table`);
    for (const row of FORK_SESSION_TRAITS) {
      const cells = [row.agent, row.disposition, row.reattach, row.cwd]
        .map((cell) => `\\|\\s*\`${escapeRegExp(cell)}\`\\s*`)
        .join("");
      assert.match(text, new RegExp(`${cells}\\|`), `${path} must carry the ${row.agent} fork trait row`);
    }
    assert.match(
      text,
      /`PROMPT_USAGE_SCOPES`[^\n]*per-turn/,
      `${path} must state that prompt usage is per-turn (PROMPT_USAGE_SCOPES)`,
    );
  }
});

test("codex-acp is consumed as a workspace package", () => {
  const packageJson = JSON.parse(readRepoFile("packages/acp-agents/package.json")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(
    packageJson.dependencies["@orchestrator/codex-acp"],
    "workspace:*",
    "codex-acp is consumed as a workspace package",
  );
});

test("root agent entrypoints carry the repository rules", () => {
  const agents = readRepoFile("AGENTS.md");
  const claude = readRepoFile("CLAUDE.md");
  const codexAgents = readRepoFile("packages/codex-acp/AGENTS.md");

  assert.equal(claude.trim(), "@AGENTS.md", "CLAUDE.md must import the canonical root AGENTS.md");
  assert.ok(agents.includes("`orc`, `engine` and `harnesses`"), "root agent guidance must name the three packages at the end");
  assert.ok(agents.includes("`test/architecture.test.mjs`"), "root agent guidance must name the architecture test");
  assert.ok(
    agents.includes("Change its tables only in a commit of their own, and never to turn a red test green"),
    "root agent guidance must guard the architecture tables",
  );
  assert.ok(agents.includes("deterministic and free of credentials"), "root agent guidance must keep the default tests offline");
  assert.ok(agents.includes("Never weaken a test"), "root agent guidance must forbid weakening tests");
  assert.ok(agents.includes("plain and short"), "root agent guidance must keep docs plain and short");
  assert.ok(
    !agents.includes("docs/specs") && !agents.includes("design-notes"),
    "root agent guidance must not route agents to archived design records",
  );
  assert.ok(
    codexAgents.includes("Root monorepo, delivery, attribution, and release rules always win"),
    "the nested Codex guidance must defer to root repository policy",
  );
  assert.ok(codexAgents.includes("Never use `git subtree --squash`"), "the nested Codex guidance must keep upstream ancestry");
  assert.ok(codexAgents.includes("merge commit"));
  assert.ok(
    !codexAgents.includes("Releases are fully automated by release-please"),
    "upstream release-please instructions must not re-enter the vendored subtree guidance",
  );
  assert.ok(
    !codexAgents.includes("gh pr merge <pr-number> --squash"),
    "upstream squash-release instructions would destroy subtree ancestry",
  );
});

test("maintained examples do not reintroduce invalid agent/model contracts", () => {
  const maintainedDocs = ["README.md"];
  for (const path of maintainedDocs) {
    const text = readRepoFile(path);
    for (const retired of ["gpt-5.5-codex", "gpt-5.1-codex"]) {
      assert.ok(!text.includes(retired), `${path} contains the retired ${retired} example id`);
    }
    assert.doesNotMatch(
      text,
      /must (?:call|contain)[^\n]*agent\(\)[^\n]*at least once/i,
      `${path} must not claim agentless scripts are invalid`,
    );
  }
});

// The backend-neutral `systemPrompt` instructions are executable data (`SYSTEM_PROMPT_SUPPORT`);
// every public document that describes the runner or the AcpAgent SDK must carry the same rows
// and none may keep the retired Codex-only story.
test("system-prompt instruction support is documented per backend and the Codex-only story is retired", () => {
  const publicDocs = ["packages/acp-agents/README.md", "packages/shared-types/README.md"];
  for (const path of publicDocs) {
    const text = readRepoFile(path);
    assert.ok(text.includes("`systemPrompt`"), `${path} must document the systemPrompt option`);
    assert.doesNotMatch(text, /Codex-only[^\n]{0,40}`baseInstructions`/, `${path} still describes baseInstructions as Codex-only`);
    assert.doesNotMatch(text, /ignored by the Claude backend/i, `${path} still claims Claude ignores instructions`);
    assert.doesNotMatch(text, /Claude has no analog/i, `${path} still claims Claude has no system-prompt analog`);
    assert.doesNotMatch(text, /never drives `systemPrompt`/, `${path} still claims AgentPrism never drives systemPrompt`);
  }
  for (const path of ["packages/acp-agents/README.md"]) {
    const text = readRepoFile(path);
    for (const row of SYSTEM_PROMPT_SUPPORT) {
      for (const key of row.metaKeys) {
        assert.ok(text.includes(`\`${key}\``), `${path} must name the ${row.agent} \`${key}\` _meta key`);
      }
    }
  }
});

// Mid-session model switching: wherever the AcpAgent SDK is described, `setModel` and the
// per-turn `model` option are named, the FIFO list carries `setModel`, and the agent's `model`
// is no longer described as fixed at open.
test("mid-session model switching is documented wherever the AcpAgent SDK is described", () => {
  for (const path of ["packages/acp-agents/README.md"]) {
    const text = readRepoFile(path);
    assert.ok(text.includes("`setModel`"), `${path} must name setModel in the FIFO list`);
    assert.match(text, /setModel\(spec\)/, `${path} must describe setModel(spec)`);
    assert.doesNotMatch(text, /the model this agent selects at open/, `${path} still describes \`model\` as fixed at open`);
  }
});

// The AcpAgent function-tool surface and the `permissions` rename: the SDK docs must name the
// injected server, the renamed policy option, and must not describe
// `tools` as the permission policy any more.
test("function tools and the permissions option are documented wherever the AcpAgent SDK is described", () => {
  for (const path of ["packages/acp-agents/README.md"]) {
    const text = readRepoFile(path);
    assert.ok(text.includes("`agent_tools`"), `${path} must name the injected agent_tools MCP server`);
    assert.ok(text.includes("`permissions`"), `${path} must document the permissions option`);
    assert.ok(text.includes("AcpAgentToolDefinition"), `${path} must name the tool definition type`);
    assert.ok(text.includes("mcpCapabilities.http"), `${path} must document the HTTP MCP gate`);
    assert.doesNotMatch(text, /`tools\?`[^\n]{0,120}`ToolPolicy`/, `${path} still describes \`tools\` as the ToolPolicy`);
  }
});

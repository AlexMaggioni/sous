// A throwaway sous world for the end-to-end checks and the demo: a sous home, a HOME, and a
// project with workflows of code and agent steps, questions and breakpoints, agents, a skill and
// MCP servers. The agent steps run on the repo's fake Claude Code and Codex (test/fakes), which
// answer as the rules below say and spend no real tokens. Nothing here reads or writes the real
// home.

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKES = fileURLToPath(new URL("../../../test/fakes/", import.meta.url));

const WORKFLOWS = {
  greet: `export const meta = {
  name: "greet",
  description: "Ask who to greet, then greet them",
  inputs: { greeting: { type: "string", description: "The word to greet with", default: "Hello" } },
  place: "none",
}

await sh("echo getting ready", { label: "prepare" })
const name = await ask("Who should we greet?")
const said = await js("return input.greeting + ', ' + input.name", { greeting: args.greeting, name }, { label: "greet" })
return { said: said.result }
`,
  review: `export const meta = {
  name: "review",
  description: "Draft release notes, then stop for a person to approve them",
  place: "none",
}

const draft = await breakpoint(
  "Approve the release notes",
  () => js("return 'v1.2: faster start'", null, { label: "draft" }),
  { show: (step) => step.result },
)
await sh("echo shipped", { label: "ship" })
return { notes: draft.result }
`,
  slow: `export const meta = {
  name: "slow",
  description: "Warm up, run a long step, then finish",
  place: "none",
}

await sh("sleep 1", { label: "warm up" })
await sh("sleep 300", { label: "long step" })
await sh("echo finished", { label: "finish" })
return "done"
`,
  fanout: `export const meta = {
  name: "fanout",
  description: "Check three parts at once, then summarize until the check passes",
  place: "none",
}

const parts = ["api", "page", "docs"]
await parallel(parts.map((part) => () => sh("echo checked " + part, { label: "check " + part })))
let summary
for (let attempt = 0; attempt < 3; attempt++) {
  const step = await js("return 'summary ' + input.attempt", { attempt }, { label: "summarize" })
  summary = step.result
  if (summary === "summary 2") break
}
return { summary }
`,
  fails: `export const meta = {
  name: "fails",
  description: "Prepare, then run a check that fails",
  place: "none",
}

await sh("echo prepared", { label: "prepare" })
await sh("echo 'disk check failed' >&2; exit 3", { label: "check disk" })
return "done"
`,
  "dark-mode": `export const meta = {
  name: "dark-mode",
  description: "Plan a dark mode toggle, review and test it at once, then ask before shipping",
  place: "none",
}

phase("Plan")
const plan = await agent("Plan the dark mode toggle for the settings page.", { label: "plan", agentType: "planner" })
phase("Build")
const [review, tests] = await parallel([
  () => agent("Review the plan for the dark mode toggle: " + plan, { label: "review", agentType: "reviewer" }),
  () => agent("Write the tests for the dark mode toggle.", { label: "write tests", agentType: "fixer" }),
])
phase("Ship")
const ship = await ask("Ship the dark mode toggle?", { choices: ["yes", "no"] })
const note = await agent("Write the release note for the dark mode toggle.", { label: "release note", model: "claude/haiku" })
return { review, tests, ship, note }
`,
  investigate: `export const meta = {
  name: "investigate",
  description: "Look into why the app starts slowly",
  place: "none",
}

await sh("echo collecting traces", { label: "collect traces" })
return await agent("Investigate why the app takes four seconds to start.", { label: "investigate" })
`,
  flaky: `export const meta = {
  name: "flaky",
  description: "Fix the flaky login test, with a retry when the program is overloaded",
  place: "none",
}

return await agent("Fix the flaky login test.", { label: "fix test", model: "codex" })
`,
};

/** What the fake programs answer. The first rule whose match fits the prompt decides. The prompt
 *  is the step's prompt as written. The step's "Task label: ..." line is in the system text. */
const RULES = [
  { match: "Plan the dark mode", delayMs: 1500, answer: "1. Add a theme setting.\n2. Read it at start.\n3. Add the toggle to the settings page." },
  { match: "Review the plan", delayMs: 2500, tool: "ls", answer: "The plan is sound. Store the choice per user, not per device." },
  { match: "Write the tests", delayMs: 3500, tool: "ls", answer: "Added 4 tests in settings/theme.test.ts. All pass." },
  { match: "Write the release note", delayMs: 800, answer: "Settings now have a dark mode toggle." },
  { match: "Investigate", tool: "ls", hold: "release-investigate" },
  { match: "Fix the flaky", fail: "Overloaded", times: 1 },
  { match: "Fix the flaky", delayMs: 1200, answer: "The test waited on a timer. It now waits on the login event." },
];

const AGENT = `---
name: reviewer
description: Reviews a change and says what to fix
model: sonnet
tools: Read, Grep, Glob
---

You review one change. Read the diff, then list what to fix, most important first.
`;

const SKILL = `---
name: release-notes
description: Write release notes from the merged pull requests
---

# Release notes

List the merged pull requests since the last tag, then write one line per change.
`;

const PLANNER = `---
name: planner
description: Turns a request into a short plan of steps
targets: ["*"]
claudecode:
  model: opus
---

You plan one change. Name the files it touches and the steps, in order, in at most five lines.
`;

const FIXER = `name = "fixer"
description = "Writes tests and fixes what they find"
model = "gpt-5"
developer_instructions = "Write the tests first, then the smallest fix that passes them."
`;

const MCP = {
  mcpServers: {
    tracker: { type: "http", url: "https://tracker.example.com/mcp", headers: { Authorization: "Bearer \${TRACKER_TOKEN}" } },
    files: { command: "npx", args: ["-y", "files-mcp", "."], env: { FILES_KEY: "not-a-real-key-123" } },
  },
};

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** The env of a person at their own terminal: no agent or run markers, the world's homes, and
 *  the fake programs in place of the real ones, which the PATH no longer finds. */
export function personEnv(world, extra = {}) {
  const env = { ...process.env };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "SOUS_RUN_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[key];
  return {
    ...env,
    HOME: world.home,
    SOUS_HOME: world.sousHome,
    PATH: `${join(world.root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    CLAUDE_CODE_EXECUTABLE: join(FAKES, "claude"),
    CODEX_PATH: join(FAKES, "codex"),
    FAKE_LOG: join(world.fake, "requests.jsonl"),
    FAKE_RULES: join(world.fake, "rules.json"),
    ...extra,
  };
}

/** The folders of the world in `root`, without making anything. The checks use it to reach the
 *  world serve.mjs made, from the project folder the server names. */
export function worldAt(root) {
  return { root, home: join(root, "home"), sousHome: join(root, "sous"), project: join(root, "shop"), fake: join(root, "fake") };
}

/** Make a world in a new temporary folder, or in `root`. */
export function makeWorld(root = realpathSync(mkdtempSync(join(tmpdir(), "sous-view-")))) {
  const world = worldAt(root);
  const { home, sousHome, project, fake } = world;
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  // A PATH with node and the system folders only, so no real claude or codex is found.
  symlinkSync(process.execPath, join(root, "bin", "node"));
  write(join(fake, "rules.json"), JSON.stringify(RULES, null, 2));
  write(join(sousHome, "config.json"), JSON.stringify({ notify: false }, null, 2));
  mkdirSync(join(project, ".git"), { recursive: true });
  for (const [name, text] of Object.entries(WORKFLOWS)) write(join(project, ".sous", "workflows", `${name}.js`), text);
  write(join(project, ".claude", "agents", "reviewer.md"), AGENT);
  write(join(project, ".rulesync", "subagents", "planner.md"), PLANNER);
  write(join(project, ".codex", "agents", "fixer.toml"), FIXER);
  write(join(project, ".claude", "skills", "release-notes", "SKILL.md"), SKILL);
  write(join(project, ".mcp.json"), JSON.stringify(MCP, null, 2));
  return world;
}

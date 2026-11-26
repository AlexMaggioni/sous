/* sous view mock v3: sample data for workflows, agents, skills and MCP servers.
   Everything here is fake. The page labels it "Sample data". */
"use strict";

const NOW = Date.now();
const SEC = 1000, MIN = 60 * SEC, HR = 60 * MIN, DAY = 24 * HR;

const PROJECTS = ["orchestrator", "site", "docs", "billing"];
const PROJECT_PATH = { orchestrator: "~/code/orchestrator", site: "~/code/site", docs: "~/code/docs", billing: "~/code/billing", mobile: "~/code/mobile", infra: "~/code/infra" };

/* ------------------------------------------------------------------ workflow files */
const WF_TEXT = {};
WF_TEXT.ticket = `export const meta = {
  name: "ticket",
  description: "Implement a ticket, then review it until the reviewer approves",
  inputs: {
    ticket: { type: "string", description: "What to build", required: true },
    rounds: { type: "number", description: "Review rounds at most", default: 3 },
  },
  outputs: { summary: "What was built" },
  place: "worktree",
}

const built = await agent(\`Implement this ticket:\\n\${args.ticket}\`, {
  agentType: "implementer", label: "implementer", keepSession: true, ask: true,
})

const review = await gate(async (feedback) => {
  if (feedback) await agent(\`Address this review:\\n\${feedback}\`, { continue: "implementer", label: "address review" })
  return agent(\`Review the change for: \${args.ticket}\`, {
    agentType: "reviewer", label: "reviewer",
    schema: { approved: "boolean", review: "string" },
  })
}, (r) => ({ ok: r.approved, feedback: r.review }), { attempts: args.rounds })
if (!review.ok) return { summary: built, approved: false }

await sh("pnpm test", { label: "tests" })
await sh(\`git add -A && git commit -m "\${args.ticket}"\`, { label: "commit" })

return { summary: built }
`;
WF_TEXT.factory_approved = `export const meta = {
  name: "factory",
  description: "Triage the team's new tickets and build the clear ones",
  inputs: {
    team: { type: "string", description: "Linear team key", required: true },
    limit: { type: "number", description: "Tickets to build at most", default: 3 },
  },
  place: "worktree",
  startedBy: "people",
  schedule: { cron: "0 2 * * *", inputs: { team: "BILL" } },
}

const tickets = await sh(\`node scripts/tickets.js \${args.team}\`, { label: "fetch" })

const triage = await agent(\`Sort these tickets into clear and vague:\\n\${tickets.stdout}\`, {
  agentType: "triager", label: "triager",
  schema: { clear: "string[]", vague: "string[]" },
})

const clear = triage.clear.slice(0, args.limit)
const pick = await ask(\`The triager found \${clear.length} clear tickets. Build these?\`, {
  choices: ["Build all", ...clear.map((id) => \`Only \${id}\`), "Build none"],
})
if (pick === "Build none") return { built: [] }

const chosen = pick === "Build all" ? clear : [pick.replace("Only ", "")]
const built = await pipeline(chosen, (id, _, i) =>
  workflow("ticket", { ticket: id }, { label: \`ticket \${"ABCDEFGH"[i]}\` }))

return { built }
`;
WF_TEXT.factory = WF_TEXT.factory_approved
  .replace('default: 3 },\n  },\n  place', 'default: 5 },\n  },\n  place')
  .replace('label: "triager",\n', 'label: "triager", model: "codex",\n');
WF_TEXT["review-pr"] = `export const meta = {
  name: "review-pr",
  description: "Review a pull request for bugs and security, then post one comment",
  inputs: {
    pr: { type: "number", description: "The pull request number", required: true },
  },
  place: "folder",
}

const diff = await sh(\`gh pr diff \${args.pr}\`, { label: "diff" })

const [review, security] = await parallel([
  () => agent(\`Review this diff:\\n\${diff.stdout}\`, { agentType: "reviewer", label: "reviewer" }),
  () => agent(\`Look for security problems in:\\n\${diff.stdout}\`, {
    agentType: "security-reviewer", label: "security",
  }),
])

const comment = await breakpoint("Post this review?", () =>
  agent(\`Write one review comment from these two reviews:\\n\${review}\\n\\n\${security}\`, {
    agentType: "writer", label: "comment",
  }))

await sh(\`gh pr comment \${args.pr} --body-file -\`, { label: "post", input: comment })
`;
WF_TEXT["release-notes_approved"] = `export const meta = {
  name: "release-notes",
  description: "Write release notes from the merged pull requests",
  inputs: {
    since: { type: "string", description: "The last release tag", required: true },
  },
  place: "worktree",
}

const log = await sh(\`git log \${args.since}..HEAD --merges --oneline\`, { label: "log" })

const notes = await breakpoint("Notes look right?", () =>
  agent(\`Write release notes from these merges:\\n\${log.stdout}\`, {
    agentType: "writer", label: "draft",
  }))

await js("fs.appendFileSync('CHANGELOG.md', input)", notes, { label: "changelog" })
`;
WF_TEXT["release-notes"] = `export const meta = {
  name: "release-notes",
  description: "Write release notes from the merged pull requests",
  inputs: {
    since: { type: "string", description: "The last release tag", required: true },
    audience: { type: "string", description: "Who reads them", default: "users" },
  },
  place: "worktree",
}

const log = await sh(\`git log \${args.since}..HEAD --merges --oneline\`, { label: "log" })

const notes = await breakpoint("Notes look right?", () =>
  agent(\`Write release notes for \${args.audience} from these merges:\\n\${log.stdout}\`, {
    agentType: "writer", label: "draft",
  }))

await js("fs.appendFileSync('CHANGELOG.md', input)", notes, { label: "changelog" })
await workflow("docs-sync", { ref: "HEAD" }, { label: "docs" })
`;
WF_TEXT["fix-flaky"] = `export const meta = {
  name: "fix-flaky",
  description: "Find why a test fails now and then, and fix it",
  inputs: {
    test: { type: "string", description: "The test's name or file", required: true },
    tries: { type: "number", description: "Runs to call it fixed", default: 20 },
  },
  place: "worktree",
  timeout: "2h",
}

const repro = await run("scripts/flaky.sh", { label: "reproduce", args: [args.test, args.tries] })

const cause = await agent(\`This test fails now and then:\\n\${args.test}\\n\\n\${repro.stdout}\`, {
  agentType: "investigator", label: "investigate", ask: true,
})

await retry(async (attempt) => {
  await agent(\`Fix the cause (attempt \${attempt}):\\n\${cause}\`, { agentType: "implementer", label: "fix" })
  return sh(\`pnpm vitest run \${args.test} --repeat 5\`, { label: "check", allowFail: true })
}, { attempts: 2, until: (r) => r.code === 0 })

await sh(\`pnpm vitest run \${args.test} --repeat \${args.tries}\`, { label: "verify", retries: 2 })
`;
WF_TEXT["docs-sync"] = `export const meta = {
  name: "docs-sync",
  description: "Update the docs after a change",
  inputs: {
    ref: { type: "string", description: "Compare the docs against this ref", default: "main" },
  },
  place: "worktree",
}

const changes = await sh(\`git diff \${args.ref}...HEAD --stat\`, { label: "changes" })

await agent(\`Update the docs for these changes:\\n\${changes.stdout}\`, {
  agentType: "docs-writer", label: "update docs",
})

await agent("Check the docs read well and match the code", { agentType: "reviewer", label: "review" })
`;
WF_TEXT["deps-update"] = `export const meta = {
  name: "deps-update",
  description: "Update the outdated packages and test each one",
  inputs: {
    scope: { type: "string", description: "patch, minor or major", default: "minor" },
  },
  place: "worktree",
}

const outdated = await sh(\`pnpm outdated --json --\${args.scope}\`, { label: "outdated", allowFail: true })
const packages = Object.keys(JSON.parse(outdated.stdout || "{}"))

await pipeline(packages,
  (name) => agent(\`Update \${name} and fix what breaks\`, {
    agentType: "codex-fixer", label: \`upgrade \${name}\`, model: "codex",
  }),
  (_, name) => sh("pnpm vitest run --changed", { label: \`test \${name}\` }))

await sh("pnpm test", { label: "tests" })
`;
WF_TEXT["triage-bugs"] = `export const meta = {
  name: "triage-bugs",
  description: "Label the new bugs, then plan the urgent ones",
  inputs: {
    team: { type: "string", description: "Linear team key", required: true },
  },
  place: "none",
  startedBy: "people",
  schedule: { cron: "0 8 * * 1-5", inputs: { team: "BILL" } },
}

const triage = await agent(\`Label the new bugs of team \${args.team}\`, {
  agentType: "triager", label: "triage", mcp: ["linear"],
})

const go = await checkpoint("Plan the urgent ones now?", { kind: "confirm" })
if (!go) return

const plan = await agent(\`Plan a fix for each urgent bug:\\n\${triage}\`, {
  agentType: "planner", label: "plan", mcp: ["linear", "postgres"],
})

await choose(\`Pick what to run for this plan:\\n\${plan}\`, { workflows: ["fix-flaky", "ticket"], none: true })
`;
WF_TEXT["migrate-billing-webhooks-to-the-new-queue"] = `export const meta = {
  name: "migrate-billing-webhooks-to-the-new-queue",
  description: "Move the billing webhooks from the cron poller to the new queue, keeping their retry policy",
  inputs: {
    since: { type: "string", description: "Backfill the failed events from this date", required: true },
  },
  place: "worktree",
}

const handlers = await sh("node scripts/list-webhook-handlers.js", { label: "inventory" })

await agent(\`Move each handler to the queue. Keep 5 tries with backoff:\\n\${handlers.stdout}\`, {
  agentType: "implementer", label: "migrate",
})

await sh(\`node scripts/backfill-webhooks.js --since \${args.since}\`, { label: "backfill" })
await sh("pnpm test", { label: "tests" })
`;

/* A very long file: the release train builds, tests and publishes ten packages. */
const RT_PKGS = ["engine", "cli", "harnesses", "view", "docs-site", "create-sous", "eslint-config", "test-kit", "rulesync-bridge", "mcp-proxy"];
WF_TEXT["release-train"] = (() => {
  const L = [];
  L.push("// The release train. Each Monday it builds, tests and publishes every package");
  L.push("// that changed since the last tag. A person approves the versions and the notes");
  L.push("// before anything is published. Publishing runs one package at a time, in the");
  L.push("// order below, because later packages depend on earlier ones.");
  L.push("");
  L.push("export const meta = {");
  L.push('  name: "release-train",');
  L.push('  description: "Build, test and publish every package that changed since the last tag",');
  L.push("  inputs: {");
  L.push('    tag: { type: "string", description: "The last release tag", required: true },');
  L.push('    dryRun: { type: "boolean", description: "Build and test, publish nothing", default: false },');
  L.push("  },");
  L.push('  place: "worktree",');
  L.push('  timeout: "3h",');
  L.push('  schedule: { cron: "0 6 * * 1", inputs: { tag: "latest" } },');
  L.push("}");
  L.push("");
  L.push("// Which packages changed, and the next version of each.");
  L.push('const versions = await sh(`node scripts/versions.js --since ${args.tag} --json`, { label: "versions" })');
  L.push("const next = JSON.parse(versions.stdout)");
  L.push("");
  ["build", "test"].forEach((phase) => {
    L.push("// " + (phase === "build" ? "Build each package on its own, so one broken build names itself." : "Test each package against the built ones."));
    L.push("const " + phase + "s = await parallel([");
    RT_PKGS.forEach((p) => {
      L.push("  // @sous/" + p);
      L.push("  () => sh(\"pnpm --filter @sous/" + p + " " + phase + "\", {");
      L.push("    label: \"" + phase + " " + p + "\",");
      L.push("    retries: " + (phase === "build" ? 1 : 2) + ",");
      L.push("    timeout: \"" + (phase === "build" ? "10m" : "20m") + "\",");
      L.push("    env: { NODE_ENV: \"production\", SOUS_PACKAGE: \"" + p + "\" },");
      L.push("  }),");
    });
    L.push("])");
    L.push("");
  });
  L.push("// The notes, then a person says yes before anything is published.");
  L.push('const notes = await breakpoint("Ship these versions?", () =>');
  L.push("  agent(`Write release notes for these versions:\\n${versions.stdout}`, {");
  L.push('    agentType: "writer", label: "notes",');
  L.push("  }))");
  L.push("");
  L.push("if (args.dryRun) return { versions: next, notes }");
  L.push("");
  L.push("// Publish in dependency order.");
  L.push("await pipeline([");
  RT_PKGS.forEach((p) => L.push('  "@sous/' + p + '",'));
  L.push("], (name) => sh(`pnpm publish --filter ${name} --no-git-checks`, {");
  L.push("  label: `publish ${name}`,");
  L.push("  retries: 1,");
  L.push("}))");
  L.push("");
  L.push('await sh("git tag -a v$(node scripts/next-tag.js) -m release && git push --tags", { label: "tag" })');
  L.push("");
  L.push("return { versions: next, notes }");
  for (let i = 0; i < 4; i++) L.push("");
  return L.join("\n") + "\n";
})();

/* ------------------------------------------------------------------ saved graphs, read the way sous reads the file */
const St = (kind, label, o) => Object.assign({ t: "step", kind, label }, o || {});
const G = {};
G.ticket = [
  St("agent", "implementer", { agent: "implementer", opts: ["keepSession", "ask"] }),
  { t: "gate", label: "review", find: "gate(", max: 3, maxArg: "rounds", passes: "the reviewer approves", body: [
    { t: "if", cond: "feedback", note: "from attempt 2", find: "if (feedback)", body: [
      St("agent", "address review", { agent: "implementer", opts: ['continue: "implementer"'] })] },
    St("agent", "reviewer", { agent: "reviewer", opts: ["schema"] }),
  ] },
  { t: "dec", cond: "the reviewer never approved", find: "if (!review.ok)", end: "returns, no commit" },
  St("sh", "tests", { cmd: "pnpm test" }),
  St("sh", "commit", { cmd: 'git add -A && git commit -m "$ticket"' }),
];
const factoryGraph = (edited) => [
  St("sh", "fetch", { cmd: "node scripts/tickets.js $team" }),
  St("agent", "triager", edited
    ? { agent: "triager", model: "codex", opts: ['model: "codex"', "schema"], bad: "This step sends triager to Codex, but triager lives in ~/.claude/agents and runs only on Claude Code. Move it to .rulesync/subagents to run it on both, or drop model: \"codex\"." }
    : { agent: "triager", opts: ["schema"] }),
  St("ask", "Build these?", { find: "ask(", q: { choices: ["Build all", "Only <id>", "Build none"] } }),
  { t: "dec", cond: 'the answer is "Build none"', find: 'if (pick === "Build none")', end: "returns, builds nothing" },
  { t: "pipe", label: "pipeline over the chosen tickets", over: "the chosen tickets", find: "pipeline(", body: [St("workflow", "ticket {letter}", { wf: "ticket", find: "workflow(" })] },
];
G.factory = factoryGraph(true);
G.factory_approved = factoryGraph(false);
G["review-pr"] = [
  St("sh", "diff", { cmd: "gh pr diff $pr" }),
  { t: "par", label: "parallel", find: "parallel([", branches: [[St("agent", "reviewer", { agent: "reviewer" })], [St("agent", "security", { agent: "security-reviewer" })]] },
  { t: "bp", title: "Post this review?", find: 'breakpoint("Post', body: [St("agent", "comment", { agent: "writer" })] },
  St("sh", "post", { cmd: "gh pr comment $pr --body-file -" }),
];
const notesGraph = (edited) => [
  St("sh", "log", { cmd: "git log $since..HEAD --merges --oneline" }),
  { t: "bp", title: "Notes look right?", find: 'breakpoint("Notes', body: [St("agent", "draft", { agent: "writer" })] },
  St("js", "changelog", { cmd: "append the notes to CHANGELOG.md" }),
].concat(edited ? [St("workflow", "docs", { wf: "docs-sync", args: { ref: "HEAD" } })] : []);
G["release-notes"] = notesGraph(true);
G["release-notes_approved"] = notesGraph(false);
G["fix-flaky"] = [
  St("run", "reproduce", { cmd: "scripts/flaky.sh $test $tries" }),
  St("agent", "investigate", { agent: "investigator", opts: ["ask"] }),
  { t: "retry", label: "fix", find: "retry(", max: 2, passes: "check exits 0", body: [
    St("agent", "fix", { agent: "implementer" }),
    St("sh", "check", { cmd: "pnpm vitest run $test --repeat 5", opts: ["allowFail"] }),
  ] },
  St("sh", "verify", { cmd: "pnpm vitest run $test --repeat $tries", opts: ["retries: 2"] }),
];
G["docs-sync"] = [
  St("sh", "changes", { cmd: "git diff $ref...HEAD --stat" }),
  St("agent", "update docs", { agent: "docs-writer" }),
  St("agent", "review", { agent: "reviewer" }),
];
G["deps-update"] = [
  St("sh", "outdated", { cmd: "pnpm outdated --json --$scope", opts: ["allowFail"] }),
  { t: "pipe", label: "pipeline over packages", over: "packages", find: "pipeline(", body: [
    St("agent", "upgrade {name}", { agent: "codex-fixer", model: "codex", opts: ['model: "codex"'], find: 'agentType: "codex-fixer"' }),
    St("sh", "test {name}", { cmd: "pnpm vitest run --changed", find: "label: `test" }),
  ] },
  St("sh", "tests", { cmd: "pnpm test" }),
];
G["triage-bugs"] = [
  St("agent", "triage", { agent: "triager", opts: ['mcp: ["linear"]'], mcp: ["linear"] }),
  St("checkpoint", "Plan the urgent ones now?", { find: "checkpoint(", q: { kind: "confirm", choices: ["Yes", "No"] } }),
  { t: "dec", cond: "the answer is No", find: "if (!go)", end: "returns" },
  St("agent", "plan", { agent: "planner", opts: ['mcp: ["linear", "postgres"]'], mcp: ["linear", "postgres"] }),
  St("choose", "pick what to run", { find: "choose(", options: ["fix-flaky", "ticket", "none"] }),
];
G["migrate-billing-webhooks-to-the-new-queue"] = [
  St("sh", "inventory", { cmd: "node scripts/list-webhook-handlers.js" }),
  St("agent", "migrate", { agent: "implementer" }),
  St("sh", "backfill", { cmd: "node scripts/backfill-webhooks.js --since $since" }),
  St("sh", "tests", { cmd: "pnpm test" }),
];
G["release-train"] = [
  St("sh", "versions", { cmd: "node scripts/versions.js --since $tag --json" }),
  { t: "par", label: "builds", find: "const builds", branches: RT_PKGS.map((p) => [St("sh", "build " + p, { cmd: "pnpm --filter @sous/" + p + " build", opts: ["retries: 1"], find: 'label: "build ' + p }) ]) },
  { t: "par", label: "tests", find: "const tests", branches: RT_PKGS.map((p) => [St("sh", "test " + p, { cmd: "pnpm --filter @sous/" + p + " test", opts: ["retries: 2"], find: 'label: "test ' + p }) ]) },
  { t: "bp", title: "Ship these versions?", find: 'breakpoint("Ship', body: [St("agent", "notes", { agent: "writer" })] },
  { t: "dec", cond: "dryRun is set", find: "if (args.dryRun)", end: "returns, publishes nothing" },
  { t: "pipe", label: "pipeline over 10 packages", over: "10 packages", find: "await pipeline([", body: [St("sh", "publish {name}", { cmd: "pnpm publish --filter $name --no-git-checks", find: "label: `publish" })] },
  St("sh", "tag", { cmd: "git tag -a v$(node scripts/next-tag.js) -m release && git push --tags" }),
];

const WORKFLOWS = [
  { name: "ticket", where: "home", startedBy: "anyone", place: "worktree",
    inputs: [{ name: "ticket", type: "string", required: true, description: "What to build" }, { name: "rounds", type: "number", def: 3, description: "Review rounds at most" }],
    outputs: [["summary", "What was built"]],
    approved: { at: NOW - 3 * DAY, by: "you" } },
  { name: "factory", where: "billing", startedBy: "people", place: "worktree", schedule: "0 2 * * *, with team BILL",
    inputs: [{ name: "team", type: "string", required: true, description: "Linear team key" }, { name: "limit", type: "number", def: 5, description: "Tickets to build at most" }],
    approved: { at: NOW - 6 * DAY, by: "you", changedSince: true, editedBy: "Claude Code", editedAt: NOW - 4 * MIN },
    problems: [{ node: "triager", text: "Step \"triager\" sends agent triager to Codex, but triager is in ~/.claude/agents and runs only on Claude Code. Move it to .rulesync/subagents to run it on both." }] },
  { name: "review-pr", where: "home", startedBy: "anyone", place: "folder",
    inputs: [{ name: "pr", type: "number", required: true, description: "The pull request number" }],
    approved: { at: NOW - 12 * DAY, by: "you" } },
  { name: "release-notes", where: "home", startedBy: "anyone", place: "worktree",
    inputs: [{ name: "since", type: "string", required: true, description: "The last release tag" }, { name: "audience", type: "string", def: "users", description: "Who reads them", isNew: true }],
    approved: { at: NOW - 9 * DAY, by: "you", changedSince: true, editedBy: "you", editedAt: NOW - 6 * MIN } },
  { name: "fix-flaky", where: "home", startedBy: "anyone", place: "worktree", timeout: "2h",
    inputs: [{ name: "test", type: "string", required: true, description: "The test's name or file" }, { name: "tries", type: "number", def: 20, description: "Runs to call it fixed" }],
    approved: { at: NOW - 20 * DAY, by: "sous", seeded: true },
    notes: ["run(\"scripts/flaky.sh\") is not in this folder. It must exist in the project the run works in."] },
  { name: "docs-sync", where: "home", startedBy: "anyone", place: "worktree",
    inputs: [{ name: "ref", type: "string", def: "main", description: "Compare the docs against this ref" }],
    approved: { at: NOW - 15 * DAY, by: "you" } },
  { name: "deps-update", where: "site", startedBy: "anyone", place: "worktree",
    inputs: [{ name: "scope", type: "string", def: "minor", description: "patch, minor or major" }],
    approved: { at: NOW - 4 * DAY, by: "you" } },
  { name: "triage-bugs", where: "billing", startedBy: "people", place: "none", schedule: "0 8 * * 1-5, with team BILL",
    inputs: [{ name: "team", type: "string", required: true, description: "Linear team key" }],
    approved: { at: NOW - 30 * DAY, by: "you" } },
  { name: "migrate-billing-webhooks-to-the-new-queue", where: "billing", startedBy: "anyone", place: "worktree",
    inputs: [{ name: "since", type: "string", required: true, description: "Backfill the failed events from this date" }],
    approved: { at: NOW - 2 * DAY, by: "you" } },
  { name: "release-train", where: "home", startedBy: "anyone", place: "worktree", timeout: "3h", schedule: "0 6 * * 1, with tag latest",
    inputs: [{ name: "tag", type: "string", required: true, description: "The last release tag" }, { name: "dryRun", type: "boolean", def: false, description: "Build and test, publish nothing" }],
    approved: { at: NOW - 1 * DAY, by: "you" } },
];
const WF = Object.fromEntries(WORKFLOWS.map((w) => [w.name, w]));
WORKFLOWS.forEach((w) => {
  w.path = w.where === "home" ? "~/.sous/workflows/" + w.name + ".js" : PROJECT_PATH[w.where] + "/.sous/workflows/" + w.name + ".js";
  w.text = WF_TEXT[w.name];
  w.approvedText = WF_TEXT[w.name + "_approved"] || w.text;
  w.description = (w.text.match(/description: "([^"]+)"/) || [])[1];
  w.graph = G[w.name];
  w.approvedGraph = G[w.name + "_approved"] || w.graph;
  let n = 0;
  const ids = (nodes, pre) => nodes.forEach((x) => {
    x.id = pre + "-" + (++n);
    if (x.body) ids(x.body, pre);
    if (x.branches) x.branches.forEach((b) => ids(b, pre));
  });
  ids(w.graph, "s");
  if (w.approvedGraph !== w.graph) { n = 0; ids(w.approvedGraph, "a"); }
});
function walkSaved(nodes, fn) { nodes.forEach((x) => { fn(x); if (x.body) walkSaved(x.body, fn); if (x.branches) x.branches.forEach((b) => walkSaved(b, fn)); }); }
function wfCalls(w) {
  const out = [];
  walkSaved(w.graph, (x) => {
    if (x.kind === "workflow" && !out.includes(x.wf)) out.push(x.wf);
    if (x.kind === "choose") x.options.forEach((o) => { if (WF[o] && !out.includes(o)) out.push(o); });
  });
  return out;
}

/* ------------------------------------------------------------------ agents
   Each name can have copies in several folders. sous takes the first in lookup order. */
const FOLDERS = [
  { id: "p-rulesync", tier: 1, label: "project rulesync", dir: ".rulesync/subagents/", ext: ".md", project: true },
  { id: "g-rulesync", tier: 2, label: "global rulesync", dir: "~/rulesync/.rulesync/subagents/", ext: ".md" },
  { id: "p-claude", tier: 3, label: "project Claude Code", dir: ".claude/agents/", ext: ".md", project: true, harness: "Claude Code" },
  { id: "p-codex", tier: 3, label: "project Codex", dir: ".codex/agents/", ext: ".toml", project: true, harness: "Codex" },
  { id: "h-claude", tier: 4, label: "home Claude Code", dir: "~/.claude/agents/", ext: ".md", harness: "Claude Code" },
  { id: "h-codex", tier: 4, label: "home Codex", dir: "~/.codex/agents/", ext: ".toml", harness: "Codex" },
];
const FOLDER = Object.fromEntries(FOLDERS.map((f) => [f.id, f]));

const ARCHITECT_BODY = (() => {
  const L = [];
  L.push("You design one change before anyone builds it. You write the design, not the code.");
  L.push("");
  L.push("## Before you design");
  L.push("");
  L.push("1. Read the ticket twice. Write down what it asks for in one sentence.");
  L.push("2. Find every file the change touches. Read each one in full.");
  L.push("3. Find the tests that cover those files. Note what they check and what they miss.");
  L.push("4. Read the last ten commits that touched those files, and why they were made.");
  L.push("5. When two readings of the ticket fit, write a line that starts with `QUESTION:` and wait.");
  L.push("");
  L.push("## What a design holds");
  L.push("");
  L.push("- The problem, in the words of the person who asked.");
  L.push("- What changes for the person who uses it, step by step.");
  L.push("- Each module the change touches, and its interface before and after.");
  L.push("- The tests that prove it, written as names a reader understands.");
  L.push("- What you chose not to do, and why.");
  L.push("- The risks, each with the check that would catch it.");
  L.push("");
  L.push("## Interfaces");
  L.push("");
  L.push("Keep each interface small. A module that hides a lot behind a few calls is worth more than many thin layers.");
  L.push("Name things for what they do for the caller, not for how they work inside.");
  L.push("When a change adds a parameter, ask whether the caller should know about it at all.");
  L.push("");
  L.push("## Per module");
  L.push("");
  const mods = [
    ["engine", "the run loop, the step ledger and the journal"],
    ["cli", "the commands, their flags and their replies"],
    ["harnesses", "the Claude Code and Codex adapters"],
    ["runs", "the run records, their status and their limits"],
    ["steps", "agent steps, code steps and their activity"],
    ["workflows", "loading, checking and approving workflow files"],
    ["places", "worktrees, folders and their cleanup"],
    ["service", "the daemon, its slots and its schedule"],
    ["accounts", "logins, usage limits and switching"],
    ["questions", "checkpoints, asks and breakpoints"],
    ["tell", "steering a running step and its receipts"],
    ["view", "the local page sous serve opens"],
  ];
  mods.forEach(([m, what]) => {
    L.push("### " + m);
    L.push("");
    L.push("This module holds " + what + ".");
    L.push("");
    L.push("- List the calls the change adds or changes in " + m + ".");
    L.push("- Say which records it writes, and whether an older sous can still read them.");
    L.push("- Say what the module does when the call fails halfway.");
    L.push("- Name the test file that covers it, and the case you add.");
    L.push("- Say how a person sees the change in `sous show` or the view.");
    L.push("");
  });
  L.push("## How to end");
  L.push("");
  L.push("End with the design as one markdown file. Put the open questions at the top, then the design.");
  L.push("Keep it under 400 lines. A longer design is two changes.");
  return L.join("\n");
})();

const AGENT_DEFS = {
  implementer: { description: "Implements one ticket, tests first", copies: [{ at: "g-rulesync" }],
    top: { tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"] },
    claudecode: { model: "opus", effort: "high", permissionMode: "acceptEdits", skills: ["tdd", "git-commit"] },
    codexcli: { model: "gpt-6.1-sol", effort: "high", sandbox: "workspace-write" }, harness: "claude",
    body: "You implement one ticket in the repository you are in.\n\n## How\n\n1. Write a failing test first.\n2. Make the smallest change that passes it.\n3. Run the whole suite before you finish.\n\nCommit nothing. The workflow commits.\n\nWhen a choice is not yours to make, write a line that starts with `QUESTION:` and wait for the answer.\n\nEnd with a short summary of what you changed and why, file by file." },
  reviewer: { description: "Reviews one change and says what blocks it", copies: [
      { at: "p-rulesync", project: "orchestrator" },
      { at: "h-claude", alt: { model: "sonnet", body: "Review the diff. Be brief.\n\nList what blocks first, then the rest. Return `approved: true` only when nothing blocks." } },
      { at: "h-codex", alt: { model: "gpt-6-luna", body: "Review the diff. Be brief.\n\nList what blocks first, then the rest." } },
    ],
    top: { tools: ["Read", "Grep", "Glob"] },
    claudecode: { model: "haiku", effort: "high", permissionMode: "default", skills: ["code-review"] },
    codexcli: { model: "gpt-6-luna", effort: "high", sandbox: "read-only" }, harness: "claude",
    body: "You review one change. Read the diff, then the code around each change.\n\n## What to report\n\n1. What blocks the change: bugs, missing tests, broken contracts.\n2. What could be better, in a separate list.\n\nQuote the line you mean. Return `approved: true` only when nothing blocks." },
  "security-reviewer": { description: "Looks for security problems in a diff", copies: [{ at: "g-rulesync" }],
    top: { tools: ["Read", "Grep", "Glob", "WebFetch"], mcpServers: ["github"] },
    claudecode: { model: "opus", effort: "max", permissionMode: "default", skills: ["security-review"] },
    codexcli: { model: "gpt-6.1-sol", effort: "high", sandbox: "read-only" }, harness: "claude",
    body: "You look for security problems in one diff.\n\n## Look for\n\n- Input that reaches a shell, a query or a template.\n- Secrets in code, logs or test fixtures.\n- Routes that skip the auth check.\n- Deserialization of data from outside.\n\n## Report\n\nFor each finding, name the file and line, how bad it is, and the fix. Say plainly when you find nothing." },
  triager: { description: "Sorts tickets and bugs into clear and vague", copies: [{ at: "h-claude" }], claudeOnly: true,
    claudecode: { model: "sonnet", permissionMode: "default", tools: ["Read", "Grep"], skills: ["linear-triage"], mcpServers: ["linear", "sentry"] },
    body: "You sort tickets. A clear ticket says what to change and how to check it. Anything else is vague.\n\nFor each vague ticket, write the one question that would make it clear." },
  "docs-writer": { description: "Updates the docs to match the code", copies: [{ at: "g-rulesync" }],
    top: { tools: ["Read", "Edit", "Grep", "Glob"], mcpServers: ["docs"] },
    claudecode: { model: "sonnet", permissionMode: "acceptEdits", skills: ["write-docs"] },
    codexcli: { model: "gpt-6-luna", effort: "medium", sandbox: "workspace-write" }, harness: "claude",
    body: "You update the docs after a change.\n\n- Change only what the code change makes wrong or missing.\n- Keep the voice of the page you edit.\n- Plain, short sentences." },
  investigator: { description: "Finds the cause of a failure before anyone fixes it", copies: [{ at: "g-rulesync" }],
    top: { tools: ["Read", "Grep", "Glob", "Bash"] },
    claudecode: { model: "opus", effort: "high", permissionMode: "default", skills: ["flaky-tests"] },
    codexcli: { model: "gpt-6.1-sol", effort: "xhigh", sandbox: "read-only" }, harness: "codex",
    body: "You find why something fails. Change no code.\n\n1. Reproduce it.\n2. Narrow it down.\n3. When two causes fit, ask with a line that starts with `QUESTION:` and wait.\n\nEnd with the cause, the evidence, and the smallest fix you would make." },
  writer: { description: "Writes release notes and short prose", copies: [{ at: "g-rulesync" }],
    top: { tools: ["Read", "Grep"] },
    claudecode: { model: "sonnet", permissionMode: "default", skills: ["release-notes"] },
    codexcli: { model: "gpt-6-luna", sandbox: "read-only" }, harness: "claude",
    body: "You write for the people who use the product. Group the changes by what they let people do. Leave out internal changes unless they change behaviour.\n\nNo marketing words." },
  planner: { description: "Plans a fix as small steps", copies: [{ at: "h-claude" }], claudeOnly: true,
    claudecode: { model: "opus", effort: "high", permissionMode: "plan", tools: ["Read", "Grep", "Glob"], mcpServers: ["linear"] },
    body: "You plan a fix as a short list of steps, each one small enough to review alone.\n\nFor each step, name the files it touches and the test that proves it." },
  "codex-fixer": { description: "Updates one package and fixes what breaks", copies: [{ at: "h-codex" }], codexOnly: true,
    codexcli: { model: "gpt-6.1-sol", effort: "medium", sandbox: "workspace-write" },
    body: "Update the one package you are given. Run the tests. Fix what breaks, in the smallest way.\n\nIf a fix needs a design choice, stop and say so." },
  architect: { description: "Designs a change before anyone builds it", copies: [{ at: "g-rulesync" }],
    top: { tools: ["Read", "Grep", "Glob"] },
    claudecode: { model: "opus", effort: "max", permissionMode: "plan", skills: ["code-review"] },
    codexcli: { model: "gpt-6.1-sol", effort: "xhigh", sandbox: "read-only" }, harness: "claude",
    body: ARCHITECT_BODY },
};

const SKILLS = {
  "code-review": { description: "How to review a diff: what blocks, what could be better, and how to say it.", where: ["g-rulesync", "h-claude", "h-codex"],
    text: "---\nname: code-review\ndescription: How to review a diff\n---\n# Code review\n\nRead the diff, then the code around each change.\n\n## What blocks\n\n1. Bugs, including the edge cases the tests miss.\n2. Missing tests for new behavior.\n3. Broken contracts: a changed signature, output or file format.\n\n## What could be better\n\n- Names that hide what a thing does.\n- Code the change made dead.\n\n## How to say it\n\nQuote the line, then say what to change:\n\n```text\nsrc/invoices/total.ts:42\nBlocks: credit notes still round per line. Call total() here too.\n```\n\nSay plainly when **nothing** blocks." },
  tdd: { description: "Write the failing test first, then the smallest change that passes it.", where: ["g-rulesync", "h-claude", "h-codex"],
    text: "---\nname: tdd\ndescription: Test first\n---\n# Test first\n\n1. Write one test that fails for the right reason.\n2. Make the smallest change that passes it.\n3. Run the whole suite.\n4. Clean up while the tests stay green.\n\nNever weaken a test to make it pass." },
  "git-commit": { description: "Commit messages in this house style: a short subject and a why.", where: ["g-rulesync", "h-claude", "h-codex"],
    text: "---\nname: git-commit\ndescription: Commit messages\n---\n# Commits\n\n- A subject under 60 characters, in the imperative.\n- A blank line, then why the change is needed.\n- One logical change per commit.\n\n```text\nRound invoice totals once, at the end\n\nPer-line rounding left 3 decimals on PDF invoices.\n```" },
  "security-review": { description: "A checklist for injection, secrets, auth and unsafe input.", where: ["g-rulesync", "h-claude"],
    text: "---\nname: security-review\ndescription: Security checklist\n---\n# Security review\n\n## Check each of these\n\n- Input that reaches a shell, a query or a template.\n- Secrets in code, logs or test fixtures.\n- Routes that skip the auth check.\n- Deserialization of data from outside.\n\nRate each finding *high*, *medium* or *low*." },
  "write-docs": { description: "How the docs read: plain words, short sentences, one idea each.", where: ["g-rulesync", "h-claude", "h-codex"],
    text: "---\nname: write-docs\ndescription: How the docs read\n---\n# Writing docs\n\n- Plain, short sentences. One idea each.\n- Say what a command does, then show it.\n- Keep examples runnable.\n\n```sh\nsous run ticket --ticket \"Add a --json flag\"\n```" },
  "release-notes": { description: "Release notes grouped by what people can now do.", where: ["g-rulesync", "h-claude", "h-codex"],
    text: "---\nname: release-notes\ndescription: Release notes\n---\n# Release notes\n\nGroup by what people can do now, then fixes. Leave out internal changes.\n\n- One line per change.\n- End each line with the pull request number, like `(#388)`." },
  "flaky-tests": { description: "Find why a test fails sometimes: timing, order, shared state.", where: ["g-rulesync", "h-claude", "h-codex"],
    text: "---\nname: flaky-tests\ndescription: Flaky tests\n---\n# Flaky tests\n\nRun it many times, alone and with the suite. Look for:\n\n- timers and real clocks,\n- tests that share files or globals,\n- order between async steps." },
  "linear-triage": { description: "How to label Linear issues and when a ticket counts as clear.", where: ["h-claude"],
    text: "---\nname: linear-triage\ndescription: Triage in Linear\n---\n# Triage\n\nA clear ticket names what to change and how to check it.\n\n1. Label each bug by area and urgency.\n2. Ask one question on each vague ticket." },
};
const SKILL_FOLDERS = {
  "g-rulesync": { label: "global rulesync", dir: "~/rulesync/.rulesync/skills/", note: "rulesync generate copies from here" },
  "h-claude": { label: "Claude Code", dir: "~/.claude/skills/", note: "Claude Code agents see the skills their list names" },
  "h-codex": { label: "Codex", dir: "~/.codex/skills/", note: "Codex agents see every skill here" },
};

const MCPS = {
  linear: { type: "stdio", command: "npx", args: ["-y", "linear-mcp"], env: [["LINEAR_API_KEY", "${LINEAR_API_KEY}"]], from: "~/rulesync/.rulesync/mcp.jsonc", source: "global rulesync",
    also: "~/.codex/config.toml also has a server named linear. On Codex steps this one runs as linear_step, and the configured one is off for that step." },
  github: { type: "http", url: "https://mcp.github.example/v1", headers: [["Authorization", "Bearer ${GITHUB_TOKEN}"]], from: "~/rulesync/.rulesync/mcp.jsonc", source: "global rulesync" },
  docs: { type: "http", url: "https://docs.example.com/mcp", headers: [], from: "~/rulesync/.rulesync/mcp.jsonc", source: "global rulesync" },
  postgres: { type: "stdio", command: "npx", args: ["-y", "pg-mcp", "--read-only"], env: [["DATABASE_URL", "${BILLING_DB_URL}"], ["PGSSLMODE", "require"]], from: "~/code/billing/.rulesync/mcp.jsonc", source: "billing rulesync", project: "billing" },
};

/* agent lookup from a project */
function resolveAgent(name, project) {
  const def = AGENT_DEFS[name];
  const present = FOLDERS.map((f) => ({ folder: f, copy: def.copies.find((c) => c.at === f.id && (!f.project || c.project === project)) }));
  const found = present.filter((p) => p.copy);
  const winner = found[0];
  return { def, present, winner, hidden: found.filter((p) => p !== winner) };
}
function copyDef(def, p) {
  if (!p.copy.alt) return def;
  const f = p.folder;
  return Object.assign({}, def, {
    body: p.copy.alt.body, top: undefined,
    claudeOnly: f.harness === "Claude Code", codexOnly: f.harness === "Codex",
    claudecode: f.harness === "Claude Code" ? Object.assign({}, def.claudecode, { model: p.copy.alt.model, tools: (def.top || {}).tools }) : undefined,
    codexcli: f.harness === "Codex" ? Object.assign({}, def.codexcli, { model: p.copy.alt.model }) : undefined,
  });
}
function effDef(name, project) { const res = resolveAgent(name, project); return copyDef(res.def, res.winner); }
const agentHarness = (def) => def.claudeOnly ? "Claude Code" : def.codexOnly ? "Codex" : "both";
function agentPath(folder, name, project) { return (folder.project ? PROJECT_PATH[project] + "/" : "") + folder.dir + name + folder.ext; }
function agentField(def, harness, field) {
  const blk = harness === "claude" ? def.claudecode : def.codexcli;
  if (!blk) return null;
  if (blk[field] != null) return { v: blk[field], from: harness === "claude" ? "claudecode" : "codexcli" };
  if (def.top && def.top[field] != null) return { v: def.top[field], from: "top" };
  return null;
}
function agentUsers(name) {
  const out = [];
  WORKFLOWS.forEach((w) => { if (!w.deleted) walkSaved(w.graph, (x) => { if (x.agent === name) out.push({ wf: w.name, label: x.label, id: x.id }); }); });
  return out;
}
function savedModel(s, project) {
  if (s.kind !== "agent") return null;
  const d = effDef(s.agent, project);
  const codex = d.codexOnly || s.model === "codex" || (d.harness === "codex" && !d.claudeOnly);
  const blk = codex ? d.codexcli : d.claudecode;
  return { harness: codex ? "Codex" : "Claude Code", model: (blk && blk.model) || "default", effort: blk && blk.effort };
}

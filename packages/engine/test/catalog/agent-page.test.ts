// One agent's page: its settings on each harness, the files it hides and the steps that name it.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { agentPage } from "../../src/catalog/agent-page.js";
import { write } from "../helpers/files.js";
import { catalogPlace, reviewWorkflow } from "./place.js";

const REVIEWER = `---
name: reviewer
description: reviews the change
targets: ["*"]
skills: [deploy]
timeout: 10m
isolation: worktree
claudecode:
  model: haiku
  permissionMode: plan
  tools: [Read, Grep]
codexcli:
  model: gpt-test
  model_reasoning_effort: low
---
Review the change.
`;

/** A rulesync agent with a Claude Code copy it hides, a Codex agent, a broken one and a workflow. */
function planted() {
  const place = catalogPlace({ review: reviewWorkflow, other: "export const meta = { name: 'other', description: 'x' }\nreturn 1\n" });
  const p = place.projectDir;
  const files = {
    reviewer: join(p, ".rulesync", "subagents", "reviewer.md"),
    hidden: join(p, ".claude", "agents", "reviewer.md"),
    fixer: join(place.user, ".codex", "agents", "fixer.toml"),
    broken: join(p, ".rulesync", "subagents", "broken.md"),
  };
  write(files.reviewer, REVIEWER);
  write(files.hidden, "---\nname: reviewer\ndescription: Claude's own\n---\nReview it.\n");
  write(files.fixer, 'name = "fixer"\ndescription = "fixes"\nmodel = "gpt-test"\ndeveloper_instructions = "Fix it."\n');
  write(files.broken, "---\nname: broken\nsous:\n  harness: gemini\n---\nx\n");
  return { place, files };
}

describe("agentPage", () => {
  it("gives a rulesync agent's settings on each harness, its own harness first", () => {
    const { place, files } = planted();
    const page = agentPage(place.paths, place.projectDir, "reviewer", place.env);
    assert.ok(page);
    assert.equal(page.description, "reviews the change");
    assert.equal(page.prompt, "Review the change.");
    assert.equal(page.raw, REVIEWER);
    assert.equal(page.file, files.reviewer);
    assert.equal(page.from, "rulesync");
    assert.equal(page.scope, "project");
    assert.equal(page.harness, "claude");
    assert.equal(page.isolation, "worktree");
    assert.equal(page.timeout, "10m");
    assert.deepEqual(page.settings, [
      { harness: "claude", model: "haiku", mode: "plan", tools: ["Read", "Grep"], skills: ["deploy"] },
      { harness: "codex", model: "gpt-test", effort: "low", tools: "all", skills: ["deploy"] },
    ]);
    assert.equal(page.problem, undefined);
  });

  it("lists the files of the same name it hides, and the steps of the saved workflows that name it", () => {
    const { place, files } = planted();
    const page = agentPage(place.paths, place.projectDir, "reviewer", place.env);
    assert.deepEqual(page?.copies, [{ file: files.hidden, from: "claude", scope: "project" }]);
    assert.deepEqual(page?.usedBy, [
      { workflow: "review", step: "check" },
      { workflow: "review", step: "agent" },
    ]);
  });

  it("gives an agent from a harness's own folder the settings of that harness alone", () => {
    const { place, files } = planted();
    const page = agentPage(place.paths, place.projectDir, "fixer", place.env);
    assert.equal(page?.from, "codex");
    assert.equal(page?.scope, "global");
    assert.equal(page?.file, files.fixer);
    assert.equal(page?.prompt, "Fix it.");
    assert.deepEqual(page?.settings, [{ harness: "codex", model: "gpt-test", tools: "all" }]);
    assert.deepEqual(page?.copies, []);
    assert.deepEqual(page?.usedBy, []);
  });

  it("gives a name whose file does not parse a page with the problem and no settings", () => {
    const { place, files } = planted();
    const page = agentPage(place.paths, place.projectDir, "broken", place.env);
    assert.equal(page?.file, files.broken);
    assert.equal(page?.from, "rulesync");
    assert.equal(page?.scope, "project");
    assert.deepEqual(page?.settings, []);
    assert.match(page?.problem ?? "", /sous\.harness is "gemini"/);
    assert.match(page?.raw ?? "", /harness: gemini/);
  });

  it("gives nothing for a name sous finds no file of", () => {
    const { place } = planted();
    assert.equal(agentPage(place.paths, place.projectDir, "nope", place.env), undefined);
  });
});

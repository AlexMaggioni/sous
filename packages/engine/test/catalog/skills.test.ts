// The skills a project sees: where each copy is, which harness misses one, and who lists it.

import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listSkills, skillPage } from "../../src/catalog/skills.js";
import { write } from "../helpers/files.js";
import { catalogPlace, reviewWorkflow } from "./place.js";

const skill = (name: string, description: string, body = `Use ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

/** A skill in every folder sous reads, a link to a folder, a hidden folder and an agent that lists one. */
function planted() {
  const place = catalogPlace({ review: reviewWorkflow });
  const p = place.projectDir;
  const files = {
    rulesync: join(p, ".rulesync", "skills", "deploy", "SKILL.md"),
    claudeProject: join(p, ".claude", "skills", "deploy", "SKILL.md"),
    codexProject: join(p, ".agents", "skills", "deploy", "SKILL.md"),
    lint: join(place.user, ".agents", "skills", "lint", "SKILL.md"),
    notes: join(place.user, ".claude", "skills", "notes", "SKILL.md"),
    global: join(place.global, ".rulesync", "skills", "drafts", "SKILL.md"),
  };
  write(files.rulesync, skill("deploy", "Ships the build", "Run the deploy."));
  write(files.claudeProject, skill("deploy", "Claude's copy"));
  write(files.codexProject, skill("deploy", "Codex's copy"));
  write(files.lint, skill("lint", "Lints"));
  write(files.notes, "Take notes.\n");
  write(files.global, skill("drafts", "Drafts"));
  write(join(place.user, ".claude", "skills", ".system", "hidden", "SKILL.md"), skill("hidden", "never listed"));
  // `sous skill install` links the sous skill in, and a link to a folder counts.
  const sous = join(place.user, "sous-skill");
  write(join(sous, "SKILL.md"), skill("sous", "Runs sous"));
  mkdirSync(join(place.user, ".claude", "skills"), { recursive: true });
  symlinkSync(sous, join(place.user, ".claude", "skills", "sous"));
  write(join(p, ".rulesync", "subagents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\nskills: [deploy]\n---\nReview it.\n");
  return { place, files };
}

describe("listSkills", () => {
  it("lists each skill once, with the harnesses that find it and its first copy", () => {
    const { place, files } = planted();
    assert.deepEqual(listSkills(place.paths, place.projectDir, place.env), [
      { name: "deploy", description: "Ships the build", harnesses: ["claude", "codex"], file: files.rulesync },
      { name: "drafts", description: "Drafts", harnesses: [], file: files.global },
      { name: "lint", description: "Lints", harnesses: ["codex"], file: files.lint },
      { name: "notes", harnesses: ["claude"], file: files.notes },
      { name: "sous", description: "Runs sous", harnesses: ["claude"], file: join(place.user, ".claude", "skills", "sous", "SKILL.md") },
    ]);
  });

  it("finds nothing in an empty project and home", () => {
    const place = catalogPlace();
    assert.deepEqual(listSkills(place.paths, place.projectDir, place.env), []);
  });
});

describe("skillPage", () => {
  it("gives the first copy's text, every copy in order, and the agents and steps that list it", () => {
    const { place, files } = planted();
    const page = skillPage(place.paths, place.projectDir, "deploy", place.env);
    assert.ok(page);
    assert.equal(page.body, "Run the deploy.");
    assert.equal(page.raw, skill("deploy", "Ships the build", "Run the deploy."));
    assert.equal(page.file, files.rulesync);
    assert.deepEqual(page.copies, [
      { harness: "rulesync", scope: "project", file: files.rulesync },
      { harness: "claude", scope: "project", file: files.claudeProject },
      { harness: "codex", scope: "project", file: files.codexProject },
    ]);
    assert.deepEqual(page.missing, []);
    assert.deepEqual(page.usedBy, [
      { kind: "agent", name: "reviewer" },
      { kind: "step", name: "check", workflow: "review" },
    ]);
  });

  it("names the harness that misses a skill in the other's folder alone", () => {
    const { place, files } = planted();
    const lint = skillPage(place.paths, place.projectDir, "lint", place.env);
    assert.deepEqual(lint?.copies, [{ harness: "codex", scope: "global", file: files.lint }]);
    assert.deepEqual(lint?.missing, ["claude"]);
    assert.deepEqual(lint?.usedBy, []);
  });

  it("says both harnesses miss a skill only rulesync's global folder has, since neither reads it", () => {
    const { place, files } = planted();
    const drafts = skillPage(place.paths, place.projectDir, "drafts", place.env);
    assert.deepEqual(drafts?.copies, [{ harness: "rulesync", scope: "global", file: files.global }]);
    assert.deepEqual(drafts?.missing, ["claude", "codex"]);
  });

  it("names a skill with no frontmatter by its folder, and gives nothing for a name no folder has", () => {
    const { place } = planted();
    assert.equal(skillPage(place.paths, place.projectDir, "notes", place.env)?.body, "Take notes.");
    assert.equal(skillPage(place.paths, place.projectDir, "hidden", place.env), undefined);
    assert.equal(skillPage(place.paths, place.projectDir, "nope", place.env), undefined);
  });
});

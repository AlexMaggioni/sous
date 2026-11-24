import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { rememberProject, type HomePaths } from "../../src/runs/home.js";
import { setup } from "./fixture.js";

// Piece 9, workflow approval. approvals.ts keeps the person's yes to a workflow's exact text, by
// hash, in <home>/approvals.json: an object from the absolute file to its last 20 approvals, the
// newest last. Each approval also saves the text as <home>/approved/<hash>.json, {text}, so
// `workflows show --diff` has the approved text to compare. A text is approved when its hash is
// among the file's kept approvals.
//
// At first use, when approvals.json is absent, every workflow of every known project and of the
// home is approved with by "sous" and seeded true. A known project is one in projects.json, or one
// a schedule in schedules.json names. Every function that reads or writes approvals.json seeds
// first, so the first approval of all, a person's included, never skips the seed.
//
// The module is loaded inside each test, so a missing module fails each test on its own. The
// files are read raw, the way piece 10 and the monitoring app read them.

type Through =
  | { kind: "person" }
  | { kind: "agent"; program: "claude" | "codex"; session?: string }
  | { kind: "run"; runId: string }
  | { kind: "schedule"; schedule: string };
interface Who {
  by: "person" | "agent" | "sous";
  through: Through;
}
interface Approval {
  hash: string;
  by: "person" | "agent" | "sous";
  through?: Through;
  at: string;
  seeded?: true;
}
interface Approvals {
  workflowHash(text: string): string;
  isApproved(paths: HomePaths, file: string, text: string): boolean;
  approveWorkflow(paths: HomePaths, file: string, text: string, who: Who): Approval;
  seedApprovals(paths: HomePaths): void;
}

const approvals = async () => (await import("../../src/runs/approvals.js" as string)) as Approvals;

const PERSON: Who = { by: "person", through: { kind: "person" } };
const CLAUDE_FOR_PERSON: Who = { by: "person", through: { kind: "agent", program: "claude", session: "s1" } };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const script = (name: string, body = "return 1") => `export const meta = { name: "${name}", description: "${name}" }\n${body}\n`;

const approvalsFile = (paths: HomePaths) => join(paths.home, "approvals.json");
const copyFile = (paths: HomePaths, hash: string) => join(paths.home, "approved", `${hash}.json`);
function kept(paths: HomePaths): Record<string, Approval[]> {
  assert.ok(existsSync(approvalsFile(paths)), "approvals.json exists");
  return JSON.parse(readFileSync(approvalsFile(paths), "utf8")) as Record<string, Approval[]>;
}

/** A project of the test's home with its workflow files, by name. */
function project(paths: HomePaths, name: string, workflows: Record<string, string>): { dir: string; files: Record<string, string> } {
  const dir = join(paths.home, "..", name);
  mkdirSync(join(dir, ".sous", "workflows"), { recursive: true });
  const files: Record<string, string> = {};
  for (const [workflow, text] of Object.entries(workflows)) {
    files[workflow] = join(dir, ".sous", "workflows", `${workflow}.js`);
    writeFileSync(files[workflow]!, text);
  }
  return { dir, files };
}

/** A workflow in the home's own folder. */
function homeWorkflow(paths: HomePaths, name: string, text: string): string {
  mkdirSync(paths.workflows, { recursive: true });
  const file = join(paths.workflows, `${name}.js`);
  writeFileSync(file, text);
  return file;
}

describe("piece 9: workflowHash", () => {
  it("is the sha256 of the text, in hex", async () => {
    const { workflowHash } = await approvals();
    const text = script("greet");
    assert.equal(workflowHash(text), sha256(text));
    assert.match(workflowHash(text), /^[0-9a-f]{64}$/);
  });
});

describe("piece 9: seeding at first use", () => {
  it("an absent file seeds every workflow of a known project and of the home as seeded, by sous", async () => {
    const { seedApprovals, isApproved } = await approvals();
    const { paths, projectDir } = setup({ hello: script("hello"), asks: script("asks", "return 2") });
    rememberProject(paths, projectDir);
    const home = homeWorkflow(paths, "tidy", script("tidy", "return 3"));
    const files = { hello: join(projectDir, ".sous", "workflows", "hello.js"), asks: join(projectDir, ".sous", "workflows", "asks.js"), tidy: home };
    assert.equal(existsSync(approvalsFile(paths)), false);

    seedApprovals(paths);

    const saved = kept(paths);
    for (const [name, file] of Object.entries(files)) {
      const text = readFileSync(file, "utf8");
      const list = saved[file];
      assert.ok(list, `${name} is seeded under its absolute file ${file}: ${JSON.stringify(Object.keys(saved))}`);
      assert.equal(list.length, 1, JSON.stringify(list));
      const [seed] = list;
      assert.equal(seed!.hash, sha256(text));
      assert.equal(seed!.by, "sous");
      assert.equal(seed!.seeded, true);
      assert.equal(typeof seed!.at, "string");
      assert.ok(!Number.isNaN(Date.parse(seed!.at)), seed!.at);
      assert.equal(isApproved(paths, file, text), true, `${name} is approved`);
      // piece 10's --diff compares against the seeded text too.
      assert.equal(JSON.parse(readFileSync(copyFile(paths, seed!.hash), "utf8")).text, text, `${name}'s text is saved`);
    }
  });

  it("a project sous never saw is not seeded, and a project a schedule names is", async () => {
    const { seedApprovals, isApproved } = await approvals();
    const { paths } = setup();
    const unknown = project(paths, "stranger", { fresh: script("fresh") });
    const scheduled = project(paths, "nightly", { report: script("report") });
    writeFileSync(
      paths.schedules,
      JSON.stringify([{ name: "nightly-report", workflow: "report", projectDir: scheduled.dir, cron: "0 3 * * *", inputs: {}, enabled: true, createdAt: new Date().toISOString() }]),
    );

    seedApprovals(paths);

    assert.equal(isApproved(paths, unknown.files.fresh!, script("fresh")), false, "a workflow of an unknown project needs a yes");
    assert.equal(isApproved(paths, scheduled.files.report!, script("report")), true, "a scheduled workflow's project is known");
  });

  it("seeding happens once: with the file there, a workflow saved later is not seeded", async () => {
    const { seedApprovals, isApproved } = await approvals();
    const { paths, projectDir } = setup({ hello: script("hello") });
    rememberProject(paths, projectDir);
    seedApprovals(paths);
    const later = join(projectDir, ".sous", "workflows", "greet.js");
    writeFileSync(later, script("greet"));

    seedApprovals(paths);

    assert.equal(isApproved(paths, later, script("greet")), false);
    assert.equal(kept(paths)[later], undefined, "no approval for the later file");
  });

  it("the first check of all seeds first, so it finds an existing workflow approved", async () => {
    const { isApproved } = await approvals();
    const { paths, projectDir } = setup({ hello: script("hello") });
    rememberProject(paths, projectDir);
    const file = join(projectDir, ".sous", "workflows", "hello.js");

    assert.equal(isApproved(paths, file, script("hello")), true);
    assert.equal(kept(paths)[file]?.[0]?.seeded, true);
  });

  it("the first approval of all seeds first, so the other workflows stay approved", async () => {
    const { approveWorkflow, isApproved } = await approvals();
    const { paths, projectDir } = setup({ hello: script("hello"), asks: script("asks") });
    rememberProject(paths, projectDir);
    const hello = join(projectDir, ".sous", "workflows", "hello.js");
    const asks = join(projectDir, ".sous", "workflows", "asks.js");
    const edited = script("hello", "return 'edited'");
    writeFileSync(hello, edited);

    approveWorkflow(paths, hello, edited, PERSON);

    assert.equal(isApproved(paths, asks, script("asks")), true, "the seed ran before the first approval");
    assert.equal(isApproved(paths, hello, edited), true);
  });
});

describe("piece 9: isApproved", () => {
  it("changing one byte of an approved text makes it unapproved", async () => {
    const { approveWorkflow, isApproved } = await approvals();
    const { paths, projectDir } = setup();
    const file = join(projectDir, ".sous", "workflows", "greet.js");
    const text = script("greet", "return 'hello'");
    writeFileSync(file, text);

    approveWorkflow(paths, file, text, PERSON);

    assert.equal(isApproved(paths, file, text), true);
    assert.equal(isApproved(paths, file, text.replace("hello", "hellp")), false);
    assert.equal(isApproved(paths, file, `${text} `), false);
  });

  it("an approval is for one file: the same text in another file needs its own yes", async () => {
    const { approveWorkflow, isApproved } = await approvals();
    const { paths, projectDir } = setup();
    const text = script("greet");
    const file = join(projectDir, ".sous", "workflows", "greet.js");
    writeFileSync(file, text);

    approveWorkflow(paths, file, text, PERSON);
    // Saved after the first use, so the seed does not cover it.
    const other = homeWorkflow(paths, "greet", text);

    assert.equal(isApproved(paths, file, text), true);
    assert.equal(isApproved(paths, other, text), false, "a home workflow with the same name and text is another file");
  });
});

describe("piece 9: approveWorkflow", () => {
  it("records who approved, with the hash and the time, and saves the text", async () => {
    const { approveWorkflow } = await approvals();
    const { paths, projectDir } = setup();
    const file = join(projectDir, ".sous", "workflows", "greet.js");
    const text = script("greet");
    writeFileSync(file, text);

    const approval = approveWorkflow(paths, file, text, CLAUDE_FOR_PERSON);

    assert.equal(approval.hash, sha256(text));
    assert.equal(approval.by, "person");
    assert.deepEqual(approval.through, CLAUDE_FOR_PERSON.through);
    assert.ok(Math.abs(Date.now() - Date.parse(approval.at)) < 60_000, approval.at);
    assert.equal(approval.seeded, undefined);
    assert.deepEqual(kept(paths)[file], [approval]);
    assert.equal(JSON.parse(readFileSync(copyFile(paths, approval.hash), "utf8")).text, text);
  });

  it("keeps the last 20 approvals per file, and an older approved text stays approved while kept", async () => {
    const { approveWorkflow, isApproved } = await approvals();
    const { paths, projectDir } = setup();
    const file = join(projectDir, ".sous", "workflows", "greet.js");
    const other = join(projectDir, ".sous", "workflows", "other.js");
    const texts = Array.from({ length: 25 }, (_, i) => script("greet", `return ${i}`));
    writeFileSync(other, script("other"));
    approveWorkflow(paths, other, script("other"), PERSON);

    for (const text of texts) approveWorkflow(paths, file, text, PERSON);

    const list = kept(paths)[file]!;
    assert.equal(list.length, 20);
    assert.deepEqual(
      list.map((approval) => approval.hash),
      texts.slice(5).map(sha256),
      "the newest 20, oldest first",
    );
    assert.equal(isApproved(paths, file, texts[0]!), false, "the first text fell out");
    assert.equal(isApproved(paths, file, texts[4]!), false);
    assert.equal(isApproved(paths, file, texts[5]!), true, "an older text still kept is approved");
    assert.equal(isApproved(paths, file, texts[24]!), true);
    assert.equal(kept(paths)[other]?.length, 1, "another file keeps its own list");
    for (const text of texts.slice(-3)) {
      assert.equal(JSON.parse(readFileSync(copyFile(paths, sha256(text)), "utf8")).text, text, "each approved text is saved");
    }
  });

  it("works in a home whose approvals.json is absent and whose approved folder does not exist", async () => {
    const { approveWorkflow, isApproved } = await approvals();
    const root = mkdtempSync(join(tmpdir(), "sous-approvals-"));
    const { paths } = setup();
    const file = join(root, "loose.js");
    const text = script("loose");
    writeFileSync(file, text);
    assert.equal(existsSync(join(paths.home, "approved")), false);

    approveWorkflow(paths, file, text, PERSON);

    assert.equal(isApproved(paths, file, text), true, "a workflow run by path is keyed by its absolute file too");
  });
});

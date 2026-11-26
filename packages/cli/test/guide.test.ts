import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { testHome } from "@sous-run/engine/testing";
import { callProblem, words } from "./helpers/calls.js";
import { sous } from "./sous.js";

// Piece 6, the guide. `sous guide` lists the topics, `sous guide <topic>` prints one, and each topic
// is a file in packages/cli/guide/. `sous help` starts with the line for agents.

delete process.env.SOUS_RUN_ID;
delete process.env.CLAUDECODE;

const GUIDE = resolve(dirname(fileURLToPath(import.meta.url)), "../guide");
const TOPICS = ["start", "wait", "asks", "ends", "pauses", "steer", "writing", "errors", "inside", "replies"];
const topicFile = (topic: string) => join(GUIDE, `${topic}.md`);

/** The topic's text, or a failed assertion that names the missing file. */
function topicText(topic: string): string {
  assert.ok(existsSync(topicFile(topic)), `packages/cli/guide/${topic}.md is missing`);
  return readFileSync(topicFile(topic), "utf8");
}

/** The lines of a markdown text's fenced code blocks that call sous. */
function sousLines(text: string): string[] {
  const lines: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock && /^\s*(\$\s+)?sous(\s|$)/.test(line)) lines.push(line.trim());
  }
  return lines;
}

/** The inline `sous ...` spans outside the code blocks, such as `sous guide wait`. */
function inlineCalls(text: string): string[] {
  const calls: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inBlock = !inBlock;
      continue;
    }
    if (!inBlock) for (const span of line.matchAll(/`(sous\s[^`]+)`/g)) calls.push(span[1]!);
  }
  return calls;
}

/** The skill file, whose calls must parse too. */
const SKILL_FILE = resolve(GUIDE, "../skill/sous/SKILL.md");

/** The saved pause reasons: the "paused, <reason>" keys of the rule's table in the engine. */
function savedPauseReasons(): string[] {
  const rule = readFileSync(resolve(GUIDE, "../../engine/src/runs/rule.ts"), "utf8");
  return [...rule.matchAll(/^\s*"paused, ([^"]+)":/gm)].map((match) => match[1]!);
}

describe("the guide topics", () => {
  it("each of the ten topic files exists and is under 4,000 characters", () => {
    for (const topic of TOPICS) {
      const text = topicText(topic);
      assert.ok(text.trim().length > 0, `${topic}.md is empty`);
      assert.ok(text.length < 4000, `${topic}.md has ${text.length} characters, over 4,000`);
    }
  });

  it("every sous call in the topics and the skill, in code blocks and inline, parses against COMMANDS", () => {
    const problems: string[] = [];
    let calls = 0;
    let inline = 0;
    const files: Array<[string, string]> = [...TOPICS.map((topic): [string, string] => [`${topic}.md`, topicText(topic)]), ["SKILL.md", readFileSync(SKILL_FILE, "utf8")]];
    for (const [name, text] of files) {
      const spans = inlineCalls(text);
      inline += spans.length;
      for (const line of [...sousLines(text), ...spans]) {
        calls++;
        const problem = callProblem(line);
        if (problem) problems.push(`${name}: ${problem}`);
        // A call to a topic names one that exists.
        const [, command, topicName] = words(line.replace(/^\$\s+/, ""));
        if (command === "guide" && topicName !== undefined && !topicName.startsWith("-") && !TOPICS.includes(topicName)) problems.push(`${name}: "${line}" names no topic`);
      }
    }
    assert.ok(calls > 0, "no topic has a sous call in a code block");
    assert.ok(inline > 0, "no topic or skill has an inline sous call");
    assert.deepEqual(problems, []);
  });

  it("the pauses topic has one row for each pause reason the rule knows", () => {
    const saved = savedPauseReasons();
    assert.ok(saved.length > 0, "found no paused rows in rule.ts");
    const firstCells = topicText("pauses")
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.split("|")[1]!.trim())
      .filter((cell) => cell !== "pauseReason" && !/^-+$/.test(cell));
    const named = firstCells.filter((cell) => cell.startsWith("`")).map((cell) => cell.replace(/`/g, ""));
    const known = saved.filter((reason) => reason !== "other text");
    assert.deepEqual([...named].sort(), [...known].sort(), "the pauses table names other reasons than rule.ts saves");
    if (saved.includes("other text")) assert.ok(firstCells.includes("any other text"), "the pauses table has no row for any other text");
  });

  it("the topics use no em dash and no emoji", () => {
    for (const topic of TOPICS) {
      const text = topicText(topic);
      assert.ok(!text.includes("—"), `${topic}.md has an em dash`);
      assert.ok(!/\p{Extended_Pictographic}/u.test(text), `${topic}.md has an emoji`);
    }
  });
});

describe("sous guide", () => {
  it("lists the ten topics with one line each", async () => {
    const { paths } = testHome();
    const { code, out } = await sous(paths, ["guide"]);
    assert.equal(code, 0, out);
    const lines = out.split("\n");
    for (const topic of TOPICS) {
      const rows = lines.filter((line) => new RegExp(`^\\s*${topic}\\s+\\S`).test(line));
      assert.equal(rows.length, 1, `sous guide has ${rows.length} lines for ${topic}, not one:\n${out}`);
    }
  });

  it("lists the ten topics with --json, each with its line", async () => {
    const { paths } = testHome();
    const { code, out } = await sous(paths, ["guide", "--json"]);
    assert.equal(code, 0, out);
    const listed = JSON.parse(out) as { topics: Array<{ name: string; about: string }>; notes: unknown; next: unknown };
    assert.ok(Array.isArray(listed.notes) && Array.isArray(listed.next), out);
    assert.deepEqual(listed.topics.map((topic) => topic.name).sort(), [...TOPICS].sort());
    for (const topic of listed.topics) {
      assert.equal(typeof topic.about, "string", JSON.stringify(topic));
      assert.ok(topic.about.trim().length > 0, `${topic.name} has no line`);
      assert.ok(!topic.about.includes("\n"), `${topic.name}'s line is more than one line`);
    }
  });

  it("prints one topic as its file holds it", async () => {
    const { paths } = testHome();
    const text = topicText("start");
    const { code, out } = await sous(paths, ["guide", "start"]);
    assert.equal(code, 0, out);
    assert.ok(out.includes(text.trim()), `sous guide start does not print start.md:\n${out}`);
  });

  it("prints one topic with --json as its name and text", async () => {
    const { paths } = testHome();
    const text = topicText("writing");
    const { code, out } = await sous(paths, ["guide", "writing", "--json"]);
    assert.equal(code, 0, out);
    const shown = JSON.parse(out) as { topic: string; text: string; notes: unknown; next: unknown };
    assert.equal(shown.topic, "writing");
    assert.equal(shown.text, text);
    assert.ok(Array.isArray(shown.notes) && Array.isArray(shown.next), out);
  });

  it("sous guide nosuch exits 65 and gives the call that lists the topics", async () => {
    const { paths } = testHome();
    const { code, out } = await sous(paths, ["guide", "nosuch", "--json"]);
    assert.equal(code, 65, out);
    const { error } = JSON.parse(out) as { error: { code: string; message: string; change: string; call: string | null } };
    assert.equal(error.code, "no_such_topic");
    assert.equal(error.call, "sous guide --json");
    assert.ok(error.change.length > 0, out);
    const text = await sous(paths, ["guide", "nosuch"]);
    assert.equal(text.code, 65, text.out);
  });
});

describe("sous help", () => {
  it("starts with the line for agents", async () => {
    const { paths } = testHome();
    const { code, out } = await sous(paths, ["help"]);
    assert.equal(code, 0, out);
    assert.match(out.split("\n")[0]!, /^Agents: run `?sous guide`?\.$/);
  });
});

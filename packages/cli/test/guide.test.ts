import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { testHome } from "@sous/engine/testing";
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

describe("the guide topics", () => {
  it("each of the ten topic files exists and is under 4,000 characters", () => {
    for (const topic of TOPICS) {
      const text = topicText(topic);
      assert.ok(text.trim().length > 0, `${topic}.md is empty`);
      assert.ok(text.length < 4000, `${topic}.md has ${text.length} characters, over 4,000`);
    }
  });

  it("every sous line in the topics' code blocks parses against COMMANDS", () => {
    const problems: string[] = [];
    let calls = 0;
    for (const topic of TOPICS) {
      for (const line of sousLines(topicText(topic))) {
        calls++;
        const problem = callProblem(line);
        if (problem) problems.push(`${topic}.md: ${problem}`);
        // A call to a topic names one that exists.
        const [, command, topicName] = words(line.replace(/^\$\s+/, ""));
        if (command === "guide" && topicName !== undefined && !topicName.startsWith("-") && !TOPICS.includes(topicName)) problems.push(`${topic}.md: "${line}" names no topic`);
      }
    }
    assert.ok(calls > 0, "no topic has a sous call in a code block");
    assert.deepEqual(problems, []);
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

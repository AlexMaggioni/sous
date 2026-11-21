import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify, titleCase, wordCount } from "../src/textkit.js";

test("slugify joins words with dashes", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("wordCount counts words", () => {
  assert.equal(wordCount("one two three"), 3);
});

test("titleCase capitalizes each word", () => {
  assert.equal(titleCase("hello wORLD"), "Hello World");
});

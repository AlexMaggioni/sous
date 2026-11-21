# Proof: the ticket workflow

Run on 2026-11-21 with real agents on `claude/haiku`, in a copy of `examples/textkit` made by
`examples/setup-textkit.sh`. Paths are shortened to `~/.orchestrator` and `~/textkit`.

## TK-1: one round, approved

The ticket:

```
# wordCount says an empty text has one word

wordCount("") returns 1. It should return 0. A text of only spaces, such as "   ", should also
return 0, and leading or trailing spaces should not count as words: wordCount("  a b ") is 2.
```

```sh
orc run ticket --ticket "$(cat tickets/TK-1.md)" --rounds 3
```

`orc show`:

```
ticket  mwqtrqtx-82y7d9
status    completed
place     worktree  ~/.orchestrator/worktrees/mwqtrqtx-82y7d9  (branch orc/mwqtrqtx-82y7d9)
started   2026-11-21T19:52:48.830Z  by cli
inputs    {"ticket":"# wordCount says an empty text has one word\n\nwordCount(\"\") returns 1. It should return 0. A text of only spaces, such as \"   \", should also\nreturn 0, and leading or trailing spaces should not count as words: wordCount(\"  a b \") is 2.","rounds":3,"test":"npm test"}
tokens    484576  in 143s
steps
  done  implementer  (66s, 259848 tokens)  haiku
  done  diff 1  (1s)  exec
  done  reviewer 1  (31s, 62938 tokens)  haiku
  done  tests  (0s)  exec
  done  verifier  (44s, 161790 tokens)  haiku
  done  commit  (0s)  exec
result
{
  "approved": true,
  "verified": true,
  "rounds": 1,
  "commit": "39f8ee2",
  "evidence": "Verified all test cases for the wordCount fix:\n\n1. Test case: wordCount(\"\")\n   Command: node -e 'import(\"./src/textkit.js\").then(m => console.log(\"Test 1 - wordCount(\\\"\\\"):\", m.wordCount(\"\")))'\n   Output: Test 1 - wordCount(\"\"): 0 ✓\n\n2. Test case: wordCount(\"   \")\n   Command: node -e 'import(\"./src/textkit.js\").then(m => console.log(\"Test 2 - wordCount(\\\"   \\\"):\", m.wordCount(\"   \")))'\n   Output: Test 2 - wordCount(\"   \"): 0 ✓\n\n3. Test case: wordCount(\"  a b \")\n   Command: node -e 'import(\"./src/textkit.js\").then(m => console.log(\"Test 3 - wordCount(\\\"  a b \\\"):\", m.wordCount(\"  a b \")))'\n   Output: Test 3 - wordCount(\"  a b \"): 2 ✓\n\n4. Full test suite:\n   Command: npm test\n   Output: All 6 tests passed\n   - ✔ wordCount returns 0 for empty text\n   - ✔ wordCount returns 0 for only spaces\n   - ✔ wordCount ignores leading and trailing spaces\n   - All other tests passed\n\nImplementation (src/textkit.js:10): text.trim().split(/\\s+/).filter(Boolean).length correctly handles all cases."
}
```

`orc log`:

```
19:52:52 run        ticket in ~/.orchestrator/worktrees/mwqtrqtx-82y7d9
19:52:52 phase      implement
19:52:52 start      implementer (claude/haiku)
19:53:58 done       implementer, 259848 tokens
19:53:59 phase      review
19:53:59 start      diff 1 (exec)
19:54:00 done       diff 1
19:54:00 start      reviewer 1 (claude/haiku)
19:54:31 done       reviewer 1, 62938 tokens
19:54:31 log        review 1: approved
19:54:31 phase      verify
19:54:31 start      tests (exec)
19:54:31 done       tests
19:54:31 start      verifier (claude/haiku)
19:55:15 done       verifier, 161790 tokens
19:55:15 start      commit (exec)
19:55:15 done       commit
19:55:15 log        Logs persisted to ~/.orchestrator/runs/projects/mwqtrqtx-82y7d9-0a49f777644f/runs/mwqtrqtx-82y7d9.log
19:55:17 completed  ticket
```

The commit on the run's branch, `orc/mwqtrqtx-82y7d9`:

```diff
39f8ee2 wordCount says an empty text has one word
diff --git a/src/textkit.js b/src/textkit.js
index 43a9ee2..466b026 100644
--- a/src/textkit.js
+++ b/src/textkit.js
@@ -7,7 +7,7 @@ export function slugify(text) {
 
 /** The number of words in the text. */
 export function wordCount(text) {
-  return text.split(/\s+/).length;
+  return text.trim().split(/\s+/).filter(Boolean).length;
 }
 
 /** Each word starts with a capital letter, the rest lower case. */
diff --git a/test/textkit.test.js b/test/textkit.test.js
index bdb339a..6a76a5d 100644
--- a/test/textkit.test.js
+++ b/test/textkit.test.js
@@ -10,6 +10,18 @@ test("wordCount counts words", () => {
   assert.equal(wordCount("one two three"), 3);
 });
 
+test("wordCount returns 0 for empty text", () => {
+  assert.equal(wordCount(""), 0);
+});
+
+test("wordCount returns 0 for only spaces", () => {
+  assert.equal(wordCount("   "), 0);
+});
+
+test("wordCount ignores leading and trailing spaces", () => {
+  assert.equal(wordCount("  a b "), 2);
+});
+
 test("titleCase capitalizes each word", () => {
   assert.equal(titleCase("hello wORLD"), "Hello World");
 });
```

## TK-2: the review loop

This run swaps in `strict-reviewer`, which asks for tests of the edge cases a ticket implies.

The ticket:

```
# slugify leaves a dash at the end

slugify("Hello, World!") returns "hello-world-". A slug never starts or ends with a dash, so it
should return "hello-world". slugify("--Rock & Roll--") should return "rock-roll".
```

```sh
orc run ticket --ticket "$(cat tickets/TK-2.md)" --rounds 3 --reviewer strict-reviewer
```

`orc show`, without the result's evidence:

```
ticket  mwqu1bzf-wkytdr
status    completed
place     worktree  ~/.orchestrator/worktrees/mwqu1bzf-wkytdr  (branch orc/mwqu1bzf-wkytdr)
started   2026-11-21T20:00:16.150Z  by cli
tokens    762270  in 276s
steps
  done  implementer  (52s, 257830 tokens)  haiku
  done  diff 1  (1s)  exec
  done  reviewer 1  (106s, 110360 tokens)  haiku
  done  implementer 2  (19s, 107420 tokens)  haiku
  done  diff 2  (0s)  exec
  done  reviewer 2  (43s, 95355 tokens)  haiku
  done  tests  (2s)  exec
  done  verifier  (52s, 191305 tokens)  haiku
  done  commit  (0s)  exec
result
  approved true, verified true, rounds 2, commit d0f25bb
```

`orc log`:

```
20:00:18 phase      implement
20:00:18 start      implementer (claude/haiku)
20:01:10 done       implementer, 257830 tokens
20:01:10 phase      review
20:01:11 start      reviewer 1 (claude/haiku)
20:02:57 done       reviewer 1, 110360 tokens
20:02:57 log        review 1: changes asked
20:02:57 start      implementer 2 (claude/haiku)
20:03:16 done       implementer 2, 107420 tokens
20:03:16 start      reviewer 2 (claude/haiku)
20:04:00 done       reviewer 2, 95355 tokens
20:04:00 log        review 2: approved
20:04:00 phase      verify
20:04:02 start      verifier (claude/haiku)
20:04:54 done       verifier, 191305 tokens
20:04:54 start      commit (exec)
20:04:56 completed  ticket
```

The first review, which went to the implementer as plain text:

```json
{
  "approved": false,
  "review": "The implementation correctly fixes the trailing dash bug by adding `.replace(/-$/, \"\")`, and all tests pass. However, the test suite is missing edge case coverage. [...]\n\nMissing test cases:\n- `assert.equal(slugify(\"\"), \"\");` (test/textkit.test.js) — empty input should return empty string without leading/trailing dashes\n- `assert.equal(slugify(\"!!!\"), \"\");` (test/textkit.test.js) — input with only punctuation should return empty string, not a dash-only string\n\n[...]"
}
```

`implementer 2` ran in the first implementer's session. `orc show --json` gives both steps the
same `session.sessionId`, `506b5943-dd39-4ab0-8803-adb511119e36`, and it took 19 seconds instead
of 52, since it already knew the code.

The commit on the run's branch, `orc/mwqu1bzf-wkytdr`, with the two tests the review asked for:

```diff
d0f25bb slugify leaves a dash at the end
--- a/src/textkit.js
+++ b/src/textkit.js
 export function slugify(text) {
-  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-/, "");
+  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-/, "").replace(/-$/, "");
 }
--- a/test/textkit.test.js
+++ b/test/textkit.test.js
+test("slugify removes trailing dashes", () => {
+  assert.equal(slugify("Hello, World!"), "hello-world");
+});
+
+test("slugify removes leading and trailing dashes", () => {
+  assert.equal(slugify("--Rock & Roll--"), "rock-roll");
+});
+
+test("slugify handles empty string", () => {
+  assert.equal(slugify(""), "");
+});
+
+test("slugify handles string with only punctuation", () => {
+  assert.equal(slugify("!!!"), "");
+});
```

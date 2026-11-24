// The settings edit behind `sous hook install` and `sous hook remove`, as pure functions from the
// old settings to the new. The cli tests in packages/cli/test/hook.test.ts cover the files.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOOK_COMMAND, withoutSessionHook, withSessionHook } from "../src/hook-settings.js";

const ours = { type: "command", command: HOOK_COMMAND };

describe("the session hook settings edit", () => {
  it("adds hooks.SessionStart to settings that have none, and takes both away again", () => {
    const before = { model: "opus" };
    const after = withSessionHook(before, HOOK_COMMAND);
    assert.deepEqual(after, { model: "opus", hooks: { SessionStart: [{ hooks: [ours] }] } });
    assert.deepEqual(before, { model: "opus" }, "the edit changed its input");
    assert.deepEqual(withoutSessionHook(after, HOOK_COMMAND), before);
  });

  it("finds the command in any group, and adds nothing when it is there", () => {
    const settings = { hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo me" }, ours] }] } };
    assert.equal(withSessionHook(settings, HOOK_COMMAND), undefined);
  });

  it("removes only the command from a group that holds another hook too", () => {
    const settings = { hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo me" }, ours] }] } };
    assert.deepEqual(withoutSessionHook(settings, HOOK_COMMAND), { hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo me" }] }] } });
  });

  it("keeps other hook events when SessionStart goes", () => {
    const pre = [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }];
    const settings = { hooks: { PreToolUse: pre, SessionStart: [{ hooks: [ours] }] } };
    assert.deepEqual(withoutSessionHook(settings, HOOK_COMMAND), { hooks: { PreToolUse: pre } });
  });

  it("gives undefined for a remove when the command is not there", () => {
    assert.equal(withoutSessionHook({}, HOOK_COMMAND), undefined);
    assert.equal(withoutSessionHook({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo me" }] }] } }, HOOK_COMMAND), undefined);
  });

  it("throws on a shape it can't edit, and names what is wrong", () => {
    assert.throws(() => withSessionHook([], HOOK_COMMAND), /is not a JSON object/);
    assert.throws(() => withSessionHook("text", HOOK_COMMAND), /is not a JSON object/);
    assert.throws(() => withSessionHook({ hooks: [] }, HOOK_COMMAND), /hooks key that is not an object/);
    assert.throws(() => withoutSessionHook({ hooks: { SessionStart: {} } }, HOOK_COMMAND), /SessionStart key that is not a list/);
  });
});

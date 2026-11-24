# Steering spike findings, 2026-11-24

Scripts and logs are in this folder (logs in `logs/`).

## 1. Claude Agent SDK 0.3.330, Claude Code 2.1.331, haiku

Script: `claude-tell.mjs <next|later|now> <midturn|afterresult> [afterTools]`.

- `next`: the step reads the message after its current tool call and keeps going in the same turn. It stopped at 5, one result. `command_lifecycle` frames (queued, started, completed or cancelled) carry the uuid set on the message. The result's `user_message_uuids` lists consumed messages. The tell is never echoed as a user message.
- `later`: waits until the turn ends, then runs as a second turn with a second result.
- `now`: interrupts. The first result is empty, is_error false, terminal_reason aborted_streaming. Never use it: the runner would take the empty result as the answer.
- After the result: a yielded message starts a new turn and a second result. `run.ts` calls `release()` on the first result and closes the query, so a tell landing after the last tool call is dropped or cut off. Design: refuse a tell once the result has arrived, or wait for the second result.

## 2. Codex app-server, codex-cli 0.169.0

- `codex app-server generate-ts --out schema-ts` gives `TurnSteerParams = {threadId, clientUserMessageId?, input: UserInput[], expectedTurnId}`, `TurnSteerResponse = {turnId}`, `NonSteerableTurnKind = "review" | "compact"`.
- The repo's `packages/harnesses/src/codex/generated` has no `turn/steer`. Regenerate before the build.
- Mid-turn steer works: a `userMessage` item appears in the same turn, the agent stopped at 5, turn completed.
- Errors (JSON-RPC -32600): wrong id gives "expected active turn id ... but found ..."; after turn/completed gives "no active turn to steer"; during compact gives `activeTurnNotSteerable {turnKind: "compact"}`.
- Script: `codex-steer.mjs <midturn|wrongid|afterturn|compact|models> [model]`.

## 3. Shell markers

- Codex: `CODEX_THREAD_ID` equals the thread id (exec and app server). Also `CODEX_SESSION_ID`, `CODEX_TOOL_CALL_ID`, `CODEX_SANDBOX`, `CODEX_CI` and others.
- Claude Code: `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID` equals the session id. Also `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_PID`.
- Both pass down to children. A Codex started inside Claude carries both sets, so check `CODEX_THREAD_ID` first.

## 4. Codex sandbox

- Default `codex exec` in an untrusted folder is read-only; every write fails.
- `-s workspace-write`: the working folder, /tmp and $TMPDIR are writable. Outside folders and `~/.sous-spike-test` fail.
- `-c 'sandbox_workspace_write.writable_roots=[...]'` makes all writes pass.
- App server "agent" mode with `writableRoots: []` (what the runner sends today) fails; adding the sous home to `writableRoots` in `turn/start` passes.
- A Codex driver calling `sous` needs `[sandbox_workspace_write] writable_roots = ["~/.sous" absolute]` in config, `--add-dir ~/.sous`, an untested `prefix_rule(pattern=["sous"], decision="allow")`, or a sous home inside the workspace.
- `codex exec` with non-terminal stdin waits forever; pass `< /dev/null`.

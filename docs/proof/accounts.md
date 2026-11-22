# Proof: accounts

Run on 2026-11-22 (UTC), on this machine's Claude and ChatGPT subscriptions, with Claude Code
2.1.330 and Codex 0.169.0. orc ran from a Claude Code session, which sets `CLAUDECODE=1`, and from
the same shell with that variable removed, as from a plain terminal. Neither shell had a login
token or an API key in its environment. The scratch folder is written `$A`, and home paths `~`.

## orc account

From the Claude Code session:

```
Claude Code
* default        Claude Code's own login, in ~/.claude
Codex
* codex/default  Codex's own login, in ~/.codex

This shell is a Claude Code session. A run started here uses that session's login for its Claude Code steps.
```

From the plain shell, the same list without the last line.

Two refusals, each with exit 1:

```
$ orc account add codex/team
orc: Codex accounts come later. Codex steps use Codex's own login, from CODEX_HOME where orc starts.
$ orc account use nobody
orc: no account nobody. orc account lists them, and orc account add nobody adds it.
```

## orc doctor

It exits with 0, and names the account it checked:

```
Claude Code 2.1.330
  program   ~/.local/bin/claude, found on PATH
  skipped   ~/.paradev/bin/claude, a wrapper script
  account   default, Claude Code's own login in ~/.claude (orc account lists the others)
  talks     yes, default model opus
  ...
Codex 0.169.0
  program   /opt/homebrew/bin/codex, found on PATH
  skipped   ~/.paradev/bin/codex, a wrapper script
  account   default, Codex's own login in ~/.codex (set CODEX_HOME where orc starts to use another)
  talks     yes, default model gpt-6.1-sol
  ...
```

## A run from a session and one from a plain shell

`$A/p1/.orchestrator/workflows/hello.js`:

```js
export const meta = { name: 'hello', description: 'one tiny step on Claude Code' }
return await agent("Answer with the single word OK.", { label: "claude code on haiku", model: "claude/haiku" })
```

```sh
orc run hello --place none --wait                    # from the Claude Code session
env -u CLAUDECODE orc run hello --place none --wait  # as from a plain terminal
```

Both completed with `OK`. `orc show mwrhlrzd-zxh0zs`, the run from the session:

```
program   Claude Code 2.1.330  ~/.local/bin/claude
account   Claude Code: the login of the agent that started it, in ~/.claude
account   Codex: default, Codex's own login in ~/.codex
tokens    50410  in 13s
```

`orc show mwrhm5a0-rvqdo9`, the run from the plain shell:

```
program   Claude Code 2.1.330  ~/.local/bin/claude
account   Claude Code: default, Claude Code's own login in ~/.claude
account   Codex: default, Codex's own login in ~/.codex
tokens    50513  in 11s
```

Their records hold the account names and folders, and no token:

```
mwrhlrzd-zxh0zs {"claude": {"name": "caller", "folder": "~/.claude"}, "codex": {"name": "default", "folder": "~/.codex"}}
mwrhm5a0-rvqdo9 {"claude": {"name": "default", "folder": "~/.claude"}, "codex": {"name": "default", "folder": "~/.codex"}}
```

Since neither shell had a token, orc kept none, and `~/.orchestrator/accounts.json` was not
created. The checksum of `~/.claude/settings.json` was the same before and after.

## The usage limit and the switch

A real usage limit can't be called up on demand, so `packages/orc/test/accounts.test.ts` covers
it, with a stand-in agent that stops at the limit the way Claude Code does. Its seven tests check
that:

- `orc account add` reads the token from stdin off a terminal, keeps it in a file with mode 600,
  and refuses a token that is not `sk-ant-oat...`, a taken name, `default`, `caller`, a token kept
  under another name, and `codex/<name>`.
- A run records orc's account. Its steps get that login, and `ANTHROPIC_API_KEY` is out of the way
  during the step. The worker puts the environment back afterwards.
- A run from a Claude Code session on a login orc has gets that account's name. On another token,
  orc keeps the token, and a worker started without it, as the service starts one, runs the step
  on it. A session on Claude Code's own login gets no token, even when the worker's shell has one.
- A run that an agent of another run starts takes that run's accounts, even after
  `orc account use` changed orc's.
- At the limit the run pauses, and the log, the notice and `orc show` say:

  ```
  Claude Code's own login (default) hit its usage limit. It resets at 09:54. orc account use <name> goes on now on another account.
  ```

  When orc uses another account by then, the last sentence reads
  `orc account use default moves it to the account orc uses now.`
- `orc account use spare` moves the waiting run to spare, keeps its settings folder, and resumes
  it. The resumed step runs on spare's token, and the limit is gone from the record. A run waiting
  at spare's own limit is listed, not resumed.
- `orc account remove` is refused while an unfinished run uses the account.

## Waiting for a real login token

This needs a second Claude login, made by its owner in a terminal of their own, so the token never
shows in a session's transcript:

```sh
orc account add <name>      # logs in through the browser, then asks for the token, hidden
orc account use <name>
orc doctor                  # the account line names <name>, with the same models as default
env -u CLAUDECODE orc run hello --place none --wait
orc account use default
```

## Tests

- `pnpm build` and `pnpm typecheck` pass.
- orc: 64 tests pass, 57 before and the 7 above. acp-agents' docs check passes.

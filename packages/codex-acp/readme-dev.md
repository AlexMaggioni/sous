This fork does not bundle Codex. It runs the `codex` installed on PATH, or the one `CODEX_PATH` names.
The app-server protocol is meant to stay backward compatible, so a newer Codex should work. `orc doctor` checks it.

### Runtime environment

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the `codex` on PATH.
- `CODEX_CONFIG` - JSON object merged into the Codex session config.
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `workspace-write`, `agent`, or `agent-full-access`.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.

### Quick start

#### Develop on Windows?

- Download and install [C++ redistributable package](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170#latest-supported-redistributable-version)

#### Adjust ACP client config

Run from sources

1. Install dependencies `npm install`
2. Adjust ACP client config

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "npm",
      "args": ["run", "start", "--prefix", "/path/to/project/"],
      "env": {
        "CODEX_PATH": "/path/to/codex",
        "APP_SERVER_LOGS": "optional/path/to/existing/log/directory"
      }
    }
  }
}
```

Run from binaries

1. Download a `codex-acp-<platform>.zip` archive from https://github.com/agentclientprotocol/codex-acp/releases (`<platform>` is one of: `linux`, `darwin`, `win32`)
2. Unzip the archive:
   ```bash
   unzip codex-acp-<platform>.zip
   ```
3. Adjust ACP client config

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "/path/to/codex-acp",
      "env": {
        "CODEX_PATH": "/path/to/codex"
      }
    }
  }
}
```

### Build binaries

Building standalone binaries requires [bun](https://bun.com/docs/installation).

Build single-file executables in `dist/bin` directory:

```bash
npm run bundle:all
```

Package binaries into zip archives:

```bash
npm run package:all
```

### Update supported Codex version

1. Install the Codex version to support, so `codex` on PATH is that version.
2. Regenerate Codex types in `src/app-server/`: `npm run generate-types`
3. Ensure there are no type errors or failed tests: `npm run typecheck` and `npm run test`

The tests that talk to a real Codex run the installed one, at `CODEX_PATH` or the first `codex` on PATH,
each with its own temporary `CODEX_HOME`. Set `CODEX_PATH` when the first `codex` on PATH is a wrapper script.

### Session notices

The adapter implements [Session Notices](https://agentclientprotocol.com/rfds/session-notices)
for Codex warnings, configuration warnings, deprecation notices, model rerouting, and the legacy
`thread/compacted` advisory when the client advertises `clientCapabilities.session.notices: {}`.
These are live `session/update` notifications with
`sessionUpdate: "notice"`, a severity, a plain-text title, and optional description.
They are not replayed from session history and repeated notices remain independent events.

Without that capability (including absent or null capability objects), the adapter preserves
the existing assistant/thought text or AIR `sessionFailure` advisory records. When notices are
enabled, they take precedence over AIR advisory records. Clients control their presentation;
the adapter does not rely on notices being displayed.

Command replies, review results, and terminal/retrying errors retain their existing response or
failure channels. Clients advertising session compaction support continue to receive the dedicated
compaction lifecycle instead of the legacy completion advisory.

### AIR diff statistics

See the [diff statistics specification](docs/diff-statistics-extension.md) for the
`_meta.jetbrains.air.diffStats` payload and its compatibility rules.

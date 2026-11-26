// The MCP servers a project sees, from each config file, with every secret masked.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listMcpServers, mcpPage } from "../../src/catalog/mcp.js";
import { write } from "../helpers/files.js";
import { catalogPlace, reviewWorkflow } from "./place.js";

/** Every secret the planted files hold. No page may hold one whole. */
const SECRETS = [
  "sk-live-abcdefghijklmnopqrstuvwxyz123456",
  "supersecretquery123",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "plainsecretvalue-0000-1111",
  "hunter2",
  "tok_1234567890abcdef",
  "abcd1234efgh5678ijkl",
  "lin_api_0123456789abcdef",
];

/** A server in each file sous reads, and an agent and a step that name one. */
function planted() {
  const place = catalogPlace({ review: reviewWorkflow });
  const p = place.projectDir;
  write(place.paths.secrets, "LINEAR_API_KEY=lin_api_0123456789abcdef\n");
  write(
    join(p, ".rulesync", "mcp.jsonc"),
    `{
  // rulesync's file, which both harnesses see.
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "linear-mcp", "--token", "sk-live-abcdefghijklmnopqrstuvwxyz123456"],
      "env": { "LINEAR_API_KEY": "\${LINEAR_API_KEY}", "TEAM": "core", "SHARED": "\${OTHER_VAR}" },
    },
  },
}`,
  );
  write(
    join(p, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        docs: {
          type: "http",
          url: "https://example.com/mcp?key=supersecretquery123&team=${TEAM_ID}",
          headers: { Authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789", "X-Trace": "${TRACE_TOKEN}" },
        },
      },
    }),
  );
  write(
    join(place.user, ".claude", ".claude.json"),
    JSON.stringify({
      projects: { [p]: { mcpServers: { local: { command: "node", args: ["server.js"], env: { API_TOKEN: "plainsecretvalue-0000-1111" } } } } },
      mcpServers: { everywhere: { command: "uvx", args: ["everywhere"], env: { PASSWORD: "hunter2" } } },
    }),
  );
  write(join(p, ".codex", "config.toml"), '[mcp_servers.search]\nurl = "https://search.example/mcp"\nhttp_headers = { "X-Api-Key" = "abcd1234efgh5678ijkl" }\n');
  write(
    join(place.user, ".codex", "config.toml"),
    '[mcp_servers.tickets]\ncommand = "tickets"\nargs = ["serve"]\nenv = { TICKETS_TOKEN = "tok_1234567890abcdef" }\n\n[mcp_servers.linear]\ncommand = "linear-codex"\n',
  );
  write(join(p, ".rulesync", "subagents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\nmcpServers: [linear]\n---\nReview it.\n");
  return place;
}

const NAMES = ["docs", "everywhere", "linear", "local", "search", "tickets"];

describe("listMcpServers", () => {
  it("lists the servers of every file, with the harnesses that see each and the file that wins", () => {
    const place = planted();
    assert.deepEqual(listMcpServers(place.paths, place.projectDir, place.env), [
      { name: "docs", type: "http", seenBy: ["claude"], source: ".mcp.json" },
      { name: "everywhere", type: "stdio", seenBy: ["claude"], source: "~/.claude/.claude.json" },
      { name: "linear", type: "stdio", seenBy: ["claude", "codex"], source: ".rulesync/mcp.jsonc" },
      { name: "local", type: "stdio", seenBy: ["claude"], source: "~/.claude/.claude.json (this project)" },
      { name: "search", type: "http", seenBy: ["codex"], source: ".codex/config.toml" },
      { name: "tickets", type: "stdio", seenBy: ["codex"], source: "~/.codex/config.toml" },
    ]);
  });

  it("skips a file that does not parse and lists the others", () => {
    const place = planted();
    write(join(place.projectDir, ".mcp.json"), "{ not json");
    assert.deepEqual(
      listMcpServers(place.paths, place.projectDir, place.env).map((row) => row.name),
      NAMES.filter((name) => name !== "docs"),
    );
  });
});

describe("mcpPage", () => {
  it("holds no secret whole, anywhere in a page or the list", () => {
    const place = planted();
    const pages = NAMES.map((name) => mcpPage(place.paths, place.projectDir, name, place.env));
    assert.ok(pages.every(Boolean));
    const json = JSON.stringify([pages, listMcpServers(place.paths, place.projectDir, place.env)]);
    for (const secret of SECRETS) assert.ok(!json.includes(secret), `a page holds ${secret}`);
  });

  it("keeps each reference whole, says where sous reads it, and masks each literal", () => {
    const place = planted();
    const page = mcpPage(place.paths, place.projectDir, "linear", place.env);
    assert.equal(page?.command, "npx");
    assert.deepEqual(page?.args, ["-y", "linear-mcp", "--token", "••••"]);
    assert.deepEqual(page?.env, [
      { key: "LINEAR_API_KEY", value: "${LINEAR_API_KEY}", secret: true, from: "secrets.env" },
      { key: "TEAM", value: "••••", secret: false },
      { key: "SHARED", value: "${OTHER_VAR}", secret: true, from: "the environment" },
    ]);
    assert.deepEqual(page?.headers, []);
    assert.deepEqual(page?.files, [
      { file: join(place.projectDir, ".rulesync", "mcp.jsonc"), scope: "project", harness: "rulesync" },
      { file: join(place.user, ".codex", "config.toml"), scope: "global", harness: "codex" },
    ]);
    assert.deepEqual(page?.usedBy, [
      { kind: "agent", name: "reviewer" },
      { kind: "step", name: "check", workflow: "review" },
    ]);
    assert.deepEqual(JSON.parse(page!.raw), {
      linear: {
        command: "npx",
        args: ["-y", "linear-mcp", "--token", "••••"],
        env: { LINEAR_API_KEY: "${LINEAR_API_KEY}", TEAM: "••••", SHARED: "${OTHER_VAR}" },
      },
    });
  });

  it("masks an http server's query values and headers, and shows a long literal's last four characters", () => {
    const place = planted();
    const docs = mcpPage(place.paths, place.projectDir, "docs", place.env);
    assert.equal(docs?.url, "https://example.com/mcp?key=••••&team=${TEAM_ID}");
    assert.deepEqual(docs?.headers, [
      { key: "Authorization", value: "••••6789", secret: true },
      { key: "X-Trace", value: "${TRACE_TOKEN}", secret: true, from: "the environment" },
    ]);
    assert.deepEqual(docs?.env, []);
    assert.equal(docs?.command, undefined);
    const search = mcpPage(place.paths, place.projectDir, "search", place.env);
    assert.deepEqual(search?.headers.map(({ key, value }) => ({ key, value })), [{ key: "X-Api-Key", value: "••••ijkl" }]);
  });

  it("writes a Codex server's raw entry as config.toml does", () => {
    const place = planted();
    const tickets = mcpPage(place.paths, place.projectDir, "tickets", place.env);
    assert.match(tickets!.raw, /^\[mcp_servers\.tickets\]$/m);
    assert.match(tickets!.raw, /TICKETS_TOKEN = "••••cdef"/);
    assert.deepEqual(tickets?.env, [{ key: "TICKETS_TOKEN", value: "••••cdef", secret: true }]);
  });

  it("reads a Claude Code server from the project's entry in ~/.claude.json and from its top level", () => {
    const place = planted();
    const local = mcpPage(place.paths, place.projectDir, "local", place.env);
    assert.deepEqual(local?.env, [{ key: "API_TOKEN", value: "••••1111", secret: true }]);
    assert.deepEqual(local?.files, [{ file: join(place.user, ".claude", ".claude.json"), scope: "project", harness: "claude" }]);
    const everywhere = mcpPage(place.paths, place.projectDir, "everywhere", place.env);
    assert.deepEqual(everywhere?.env.map(({ key, value }) => ({ key, value })), [{ key: "PASSWORD", value: "••••" }]);
    assert.deepEqual(everywhere?.files.map(({ scope }) => scope), ["global"]);
  });

  it("gives nothing for a name no file has", () => {
    const place = planted();
    assert.equal(mcpPage(place.paths, place.projectDir, "nope", place.env), undefined);
  });
});

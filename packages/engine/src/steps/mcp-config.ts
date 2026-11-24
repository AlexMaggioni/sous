// The MCP servers a step can be given: from sous's settings, or from the workflow's agent()
// call. The steps module hands each one to the harness as stdio or http.
//
// IDENTITY NOTE: mcpServers is an ADDITIVE run input. It is NOT part of the resume
// identity hash (hashAgentCall) — it changes which tools an agent can reach, not the
// logical call, and tying it to the hash would needlessly bust every cached result when
// tool wiring changes. The engine threads it past the hash, straight to the runner.

/** A name/value pair: an HTTP header or an environment variable. */
export interface McpNameValue {
  name: string;
  value: string;
}

/** Stdio transport: launch an MCP server subprocess. It has no `type`. */
export interface McpStdioServerConfig {
  /** Human-readable name identifying this MCP server. */
  name: string;
  /** Path to the MCP server executable. */
  command: string;
  /** Command-line arguments to pass to the MCP server. */
  args: string[];
  /** Environment variables to set when launching the MCP server. */
  env: McpNameValue[];
}

/** HTTP transport. */
export interface McpHttpServerConfig {
  type: "http";
  name: string;
  url: string;
  headers: McpNameValue[];
}

/** SSE transport. The steps module sends it as http. */
export interface McpSseServerConfig {
  type: "sse";
  name: string;
  url: string;
  headers: McpNameValue[];
}

/** One MCP server a step can reach. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

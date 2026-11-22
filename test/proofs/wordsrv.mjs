#!/usr/bin/env node
// A tiny MCP server over stdio, for the shared proof. Its one tool, get_word, returns the word
// given as the first argument. Usage: node wordsrv.mjs ORCHID
import { createInterface } from "node:readline";

const word = process.argv[2] ?? "WORD";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // A notification has no id and gets no answer.
  if (message.id === undefined || message.id === null) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "wordsrv", version: "1.0.0" },
      });
    case "tools/list":
      return reply({
        tools: [{ name: "get_word", description: "Returns this server's word.", inputSchema: { type: "object", properties: {} } }],
      });
    case "tools/call":
      return reply({ content: [{ type: "text", text: word }] });
    case "ping":
      return reply({});
    default:
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
  }
});

// Reading a step's tool lists, the same way for both adapters.

/** A tool name without its rule, such as Bash for "Bash(git *)". */
export const toolName = (entry: string) => entry.replace(/\(.*\)$/, "").trim();

/** An entry matches a tool by name, ignoring case, or when one name holds the other. */
export function matches(entry: string, tool: string): boolean {
  const a = toolName(entry).toLowerCase();
  const b = tool.toLowerCase();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Why the lists refuse a tool, or undefined when they let it run. A deny entry wins. */
export function refusal(tools: { allow?: string[]; deny?: string[] } | undefined, tool: string): string | undefined {
  const deny = tools?.deny?.find((entry) => matches(entry, tool));
  if (deny) return `${tool} is on the step's deny list (${deny}).`;
  if (tools?.allow?.length && !tools.allow.some((entry) => matches(entry, tool))) return `${tool} is not on the step's allow list.`;
  return undefined;
}

/** The server and tool of an mcp__server__tool entry. */
export function mcpTool(entry: string): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName(entry));
  return match ? { server: match[1]!, tool: match[2]! } : undefined;
}

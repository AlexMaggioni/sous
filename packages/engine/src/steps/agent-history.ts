// Lifted from pi agent-history.ts (types only). Delivered diagnostically via
// RunOptions.onHistory; never gates the result. The steps module builds it from the
// harness events.
export type AgentHistoryRole = "user" | "assistant" | "tool";
export type AgentHistoryKind = "text" | "toolCall" | "toolResult" | "error";

export interface AgentHistoryEntry {
  role: AgentHistoryRole;
  kind: AgentHistoryKind;
  text: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}

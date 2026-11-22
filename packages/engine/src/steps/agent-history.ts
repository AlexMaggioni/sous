// A step's message and tool history, for diagnosis only. The steps module builds it from
// the harness events and delivers it through RunOptions.onHistory. It never gates the result.
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

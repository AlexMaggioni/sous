import { Bot, BookOpen, CirclePlay, Plug, Workflow, type LucideIcon } from "lucide-react";

/** The five rail sections, in rail order. `key` is the second key of its `g` shortcut. `noun` is the
 *  label inside a sentence, as in "Go to workflows". */
export type Section = { id: "runs" | "workflows" | "agents" | "skills" | "mcp"; label: string; noun: string; path: string; key: string; icon: LucideIcon };

export const SECTIONS: readonly Section[] = [
  { id: "runs", label: "Runs", noun: "runs", path: "/runs", key: "r", icon: CirclePlay },
  { id: "workflows", label: "Workflows", noun: "workflows", path: "/workflows", key: "w", icon: Workflow },
  { id: "agents", label: "Agents", noun: "agents", path: "/agents", key: "a", icon: Bot },
  { id: "skills", label: "Skills", noun: "skills", path: "/skills", key: "s", icon: BookOpen },
  { id: "mcp", label: "MCP servers", noun: "MCP servers", path: "/mcp", key: "m", icon: Plug },
];

/** The section a path belongs to, or undefined for settings and the kit. */
export function sectionOf(pathname: string): Section | undefined {
  return SECTIONS.find((s) => pathname === s.path || pathname.startsWith(`${s.path}/`));
}

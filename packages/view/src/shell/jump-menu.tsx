import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useMemo } from "react";
import { useAgents, useMcps, useOverview, useRuns, useSkills, useWorkflows } from "../api/queries.ts";
import { useSeenFrom } from "../api/seen-from.ts";
import { groupRuns } from "../lists/run-groups.ts";
import { SECTIONS } from "../sections.ts";
import { openStart } from "../start/start-store.ts";
import { CommandMenu, type CommandEntry, type CommandSection } from "../ui/command-menu.tsx";

// ⌘K: jump to any run, workflow, agent, skill or MCP server, or start a workflow. The shell
// mounts it on the first ⌘K, so the page reads the catalog only once the person asks for it.

const icon = (id: string) => SECTIONS.find((s) => s.id === id)?.icon;

export function JumpMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const seen = useSeenFrom();
  const runs = useRuns().data;
  const workflows = useWorkflows(seen).data;
  const agents = useAgents(seen).data;
  const skills = useSkills(seen).data;
  const mcps = useMcps(seen).data;
  const overview = useOverview().data;
  const from = overview?.projects.find((p) => p.dir === seen)?.name ?? overview?.project.name;

  const { groups, actions } = useMemo(() => {
    const actions = new Map<string, () => void>();
    const entry = (value: string, run: () => void, rest: Omit<CommandEntry, "value">): CommandEntry => {
      actions.set(value, run);
      return { value, ...rest };
    };
    // The runs in the list's own order, what needs the person first.
    const runRows = groupRuns(runs ?? [], "status").flatMap((g) => g.items);
    const groups: CommandSection[] = [
      {
        label: "Runs",
        items: runRows.map((run) =>
          entry(`run:${run.id}`, () => void navigate({ to: "/runs/$runId", params: { runId: run.id } }), {
            label: run.title,
            icon: icon("runs"),
            meta: `${run.statusText}, ${run.workflow === run.title ? "" : `${run.workflow}, `}${run.project.name}`,
            keywords: [run.id, run.workflow, run.project.name],
          }),
        ),
      },
      {
        label: "Workflows",
        items: (workflows ?? []).map((w) =>
          entry(`workflow:${w.from}:${w.name}`, () => void navigate({ to: "/workflows/$name", params: { name: w.name } }), { label: w.name, icon: icon("workflows"), meta: w.description, keywords: w.description ? [w.description] : undefined }),
        ),
      },
      {
        label: "Agents",
        items: (agents ?? []).map((a) => entry(`agent:${a.name}`, () => void navigate({ to: "/agents/$name", params: { name: a.name } }), { label: a.name, icon: icon("agents"), meta: a.description, keywords: a.description ? [a.description] : undefined })),
      },
      {
        label: "Skills",
        items: (skills ?? []).map((s) => entry(`skill:${s.name}`, () => void navigate({ to: "/skills/$name", params: { name: s.name } }), { label: s.name, icon: icon("skills"), meta: s.description, keywords: s.description ? [s.description] : undefined })),
      },
      {
        label: "MCP servers",
        items: (mcps ?? []).map((m) => entry(`mcp:${m.name}`, () => void navigate({ to: "/mcp/$name", params: { name: m.name } }), { label: m.name, icon: icon("mcp"), meta: `${m.type}, ${m.source}`, keywords: [m.type, m.source] })),
      },
      {
        label: "Start",
        items: [
          entry("start:", () => openStart(), { label: "Start a workflow", icon: Plus }),
          ...(workflows ?? []).filter((w) => w.from === "project" || !workflows?.some((o) => o.from === "project" && o.name === w.name)).map((w) => entry(`start:${w.name}`, () => openStart(w.name), { label: `Start ${w.name}`, icon: Plus })),
        ],
      },
    ];
    return { groups, actions };
  }, [runs, workflows, agents, skills, mcps, navigate]);

  return (
    <CommandMenu
      open={open}
      onOpenChange={onOpenChange}
      label="Jump to"
      placeholder="Jump to a run, workflow, agent, skill or MCP server"
      groups={groups}
      onRun={(value) => actions.get(value)?.()}
      empty={(query) => (
        <>
          Nothing matches "{query}". The search looks at the titles, ids, workflows and projects of runs, and at the names and descriptions of workflows, agents, skills and MCP servers{from ? `, seen from ${from}` : ""}.
        </>
      )}
    />
  );
}

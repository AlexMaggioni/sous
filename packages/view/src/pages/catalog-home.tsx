import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { AgentRow, McpRow, SkillRow, WorkflowRow } from "../api/contract.ts";
import { useAgents, useMcps, useSkills, useWorkflows } from "../api/queries.ts";
import { useProjectName, useSeenFrom } from "../api/seen-from.ts";
import { formatAgo, plural } from "../format.ts";
import { HARNESS_NAME, workflowMark } from "../lists/catalog-rows.ts";
import type { Section } from "../sections.ts";
import { EmptyState } from "../ui/empty-state.tsx";
import { StatusIcon } from "../ui/status-icon.tsx";
import { agentsSummary, harnesses, mcpSummary, skillsSummary, workflowsSummary } from "./catalog-summary.ts";
import { HomeTable, notReady, Part, type Column } from "./home-parts.tsx";
import { Page } from "./page.tsx";

// The homes of Workflows, Agents, Skills and MCP: what the section holds and where sous finds it,
// one sentence that counts it, what needs a look and why, then every item with the facts the list
// column has no room for.

type CatalogPath = "/workflows/$name" | "/agents/$name" | "/skills/$name" | "/mcp/$name";

/** The name column, a link to the item's page. */
function nameColumn<T extends { name: string }>(to: CatalogPath): Column<T> {
  return {
    head: "Name",
    cell: (row) => (
      <Link to={to} params={{ name: row.name }} className="block py-2 font-medium text-fg no-underline hover:underline">
        {row.name}
      </Link>
    ),
  };
}

const descriptionColumn = <T extends { description?: string }>(): Column<T> => ({ head: "Description", fill: true, muted: true, hideBelow: 600, cell: (row) => row.description ?? "" });

interface HomeProps<T> {
  section: Section;
  lead: ReactNode;
  summary: string;
  query: Parameters<typeof notReady>[0] & { data?: T[] };
  look: { name: string; why: string }[];
  lookTitle: string;
  columns: Column<T>[];
  empty: ReactNode;
}

function CatalogHome<T extends { name: string }>({ section, lead, summary, query, look, lookTitle, columns, empty }: HomeProps<T>) {
  const waiting = notReady(query, `Loading ${section.noun}`);
  const rows = query.data ?? [];
  const to = `${section.path}/$name` as CatalogPath;
  return (
    <Page title={section.label}>
      <p className="mt-1 max-w-[42em] text-md text-muted">{lead}</p>
      {waiting ??
        (rows.length === 0 ? (
          empty
        ) : (
          <>
            <p className="mt-4 text-md text-fg">{summary}</p>
            {look.length > 0 && (
              <Part title={lookTitle} count={look.length}>
                <ul className="border-t border-line">
                  {look.map((item) => (
                    <li key={item.name} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-2">
                      <Link to={to} params={{ name: item.name }} className="font-medium text-fg">
                        {item.name}
                      </Link>
                      <span className="min-w-0 text-muted">{item.why}</span>
                    </li>
                  ))}
                </ul>
              </Part>
            )}
            <Part title={`All ${section.noun}`} count={rows.length}>
              <HomeTable rows={[...rows].sort((a, b) => a.name.localeCompare(b.name))} columns={[nameColumn<T>(to), ...columns]} rowKey={(row) => row.name} />
            </Part>
          </>
        ))}
    </Page>
  );
}

/** The name of the project the lists are seen from. */
const useSeenName = (): string => useProjectName(useSeenFrom()) ?? "this project";

export function WorkflowsHome({ section }: { section: Section }) {
  const query = useWorkflows(useSeenFrom());
  const name = useSeenName();
  const rows = query.data ?? [];
  const columns: Column<WorkflowRow>[] = [
    descriptionColumn(),
    { head: "Lives in", muted: true, hideBelow: 700, cell: (row) => (row.from === "project" ? name : "Your home") },
    {
      head: "Last run",
      num: true,
      muted: true,
      cell: (row) =>
        row.lastRun ? (
          <Link to="/runs/$runId" params={{ runId: row.lastRun.id }} className="inline-flex items-center gap-1.5 text-xs text-muted no-underline hover:underline">
            <StatusIcon status={row.lastRun.status} label={false} size={12} />
            {formatAgo(Date.parse(row.lastRun.startedAt))}
          </Link>
        ) : (
          <span className="text-xs">Never</span>
        ),
    },
  ];
  return (
    <CatalogHome
      section={section}
      query={query}
      lead={`The saved workflows sous can run from ${name}: the project's own, then the ones in your home folder.`}
      summary={workflowsSummary(rows, name)}
      lookTitle="Need a look"
      look={rows.flatMap((w) => {
        const mark = workflowMark(w);
        return mark ? [{ name: w.name, why: mark === "problem" ? `The check finds ${plural(w.problems, "problem")}.` : "Changed since your last yes. A run asks you first." }] : [];
      })}
      columns={columns}
      empty={<EmptyState title="No saved workflows" command="sous guide">A workflow is a file in the project's .sous/workflows or in your home's workflows folder. The guide shows how to write one.</EmptyState>}
    />
  );
}

const AGENT_COLUMNS: Column<AgentRow>[] = [
  descriptionColumn(),
  { head: "Runs in", muted: true, cell: (row) => (row.only ? `${HARNESS_NAME[row.only]} only` : "Both") },
  { head: "Model", muted: true, hideBelow: 700, cell: (row) => row.model ?? "The harness's default" },
];

export function AgentsHome({ section }: { section: Section }) {
  const query = useAgents(useSeenFrom());
  const name = useSeenName();
  const rows = query.data ?? [];
  return (
    <CatalogHome
      section={section}
      query={query}
      lead={`The agents a step can name, as sous finds them from ${name}. rulesync's folders come first, then each harness's own.`}
      summary={agentsSummary(rows)}
      lookTitle="Can't run as they are"
      look={rows.flatMap((a) => (a.problem ? [{ name: a.name, why: a.problem }] : []))}
      columns={AGENT_COLUMNS}
      empty={<EmptyState title="No agents yet">sous looks in the project's .rulesync/subagents, .claude/agents and .codex/agents, then in the global rulesync folder, ~/.claude/agents and ~/.codex/agents.</EmptyState>}
    />
  );
}

const SKILL_COLUMNS: Column<SkillRow>[] = [descriptionColumn(), { head: "Found by", muted: true, cell: (row) => harnesses(row.harnesses) }];

export function SkillsHome({ section }: { section: Section }) {
  const query = useSkills(useSeenFrom());
  const name = useSeenName();
  const rows = query.data ?? [];
  return (
    <CatalogHome
      section={section}
      query={query}
      lead={`The skills Claude Code and Codex find from ${name}, each in its own folders.`}
      summary={skillsSummary(rows)}
      lookTitle="One harness misses"
      look={rows.flatMap((s) => (s.harnesses.length === 1 ? [{ name: s.name, why: `Only ${HARNESS_NAME[s.harnesses[0] ?? "claude"]} finds it.` }] : []))}
      columns={SKILL_COLUMNS}
      empty={<EmptyState title="No skills yet">A skill is a folder with a SKILL.md in it. sous looks in the project's .claude/skills, .agents/skills and .rulesync/skills, then in ~/.claude/skills and ~/.agents/skills.</EmptyState>}
    />
  );
}

const MCP_COLUMNS: Column<McpRow>[] = [
  { head: "Type", muted: true, cell: (row) => row.type },
  { head: "Harness", muted: true, hideBelow: 600, cell: (row) => harnesses(row.seenBy) },
  { head: "Defined in", fill: true, muted: true, hideBelow: 700, cell: (row) => <span className="font-mono text-xs">{row.source}</span> },
];

export function McpHome({ section }: { section: Section }) {
  const query = useMcps(useSeenFrom());
  const name = useSeenName();
  const rows = query.data ?? [];
  return (
    <CatalogHome
      section={section}
      query={query}
      lead={`The MCP servers a step or an agent can name from ${name}. rulesync's mcp.jsonc wins over a harness's own config.`}
      summary={mcpSummary(rows)}
      lookTitle="One harness only"
      look={rows.flatMap((m) => (m.seenBy.length === 1 ? [{ name: m.name, why: `Only ${HARNESS_NAME[m.seenBy[0] ?? "claude"]} steps can name it. It comes from ${m.source}.` }] : []))}
      columns={MCP_COLUMNS}
      empty={<EmptyState title="No MCP servers yet">sous reads .rulesync/mcp.jsonc in the project and in the global rulesync folder, then .mcp.json and ~/.claude.json for Claude Code, and config.toml for Codex.</EmptyState>}
    />
  );
}

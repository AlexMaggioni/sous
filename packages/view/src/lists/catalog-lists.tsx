import { useParams } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { WorkflowRow } from "../api/contract.ts";
import { useAgents, useMcps, useOverview, useSkills, useWorkflows } from "../api/queries.ts";
import { useSeenFrom } from "../api/seen-from.ts";
import { Button } from "../ui/button.tsx";
import { CommandBox } from "../ui/copy.tsx";
import { Refusal } from "../ui/refusal.tsx";
import { LoadingRows } from "../ui/skeleton.tsx";
import { StatusIcon } from "../ui/status-icon.tsx";
import { groupWorkflows, onlyOn, pickAgents, pickMcps, pickSkills, workflowMark } from "./catalog-rows.ts";
import { NameRow } from "./list-row.tsx";
import { ColumnNote, GroupedList, GroupHeading, ListBody } from "./list-view.tsx";
import type { ListGroup } from "./run-groups.ts";
import { SeenFromMenu } from "./view-menu.tsx";

// The Workflows, Agents, Skills and MCP lists. Each reads its rows as seen from the picked project,
// and shows the same loading, error, empty and no-match states.

type ListProps = { query: string; clearQuery: () => void };

/** The loading rows or the refusal while the list can't show, else null. */
function notReady(query: UseQueryResult<unknown>, loading: string): ReactNode {
  if (query.isPending) {
    return (
      <ListBody>
        <div className="pt-4">
          <LoadingRows label={loading} rows={6} rowHeight={28} />
        </div>
      </ListBody>
    );
  }
  if (query.isError) {
    return (
      <ListBody>
        <div className="px-2 pt-4">
          <Refusal error={query.error} action={<Button size="sm" onClick={() => query.refetch()}>Try again</Button>} />
        </div>
      </ListBody>
    );
  }
  return null;
}

/** A list with nothing to show: what fills it when it is empty, or what the search looked at. */
function Nothing({ label, menu, query, clearQuery, looked, empty }: ListProps & { label: string; menu: ReactNode; looked: string; empty: ReactNode }) {
  return (
    <ListBody>
      <GroupHeading label={label} count={0} menu={menu} />
      <ColumnNote>
        {query ? (
          <>
            <p>
              Nothing matches "{query}". The search looks at {looked}.
            </p>
            <Button size="sm" onClick={clearQuery}>
              Clear the search
            </Button>
          </>
        ) : (
          empty
        )}
      </ColumnNote>
    </ListBody>
  );
}

const MARK: Record<"problem" | "changed", { node: ReactNode; tip: string }> = {
  problem: { node: <StatusIcon status="failed" size={12} label={false} />, tip: "Its check finds a problem." },
  changed: { node: <span aria-hidden="true" className="size-1.5 rounded-full bg-needs" />, tip: "Changed since your last yes." },
};

function workflowTip(row: WorkflowRow): string {
  const mark = workflowMark(row);
  return [row.description ?? row.file, mark && MARK[mark].tip].filter(Boolean).join(" ");
}

export function WorkflowsList({ query, clearQuery }: ListProps) {
  const seen = useSeenFrom();
  const overview = useOverview().data;
  const workflows = useWorkflows(seen);
  const { name } = useParams({ strict: false });
  const waiting = notReady(workflows, "Loading workflows");
  if (waiting || !workflows.data) return waiting;

  const menu = <SeenFromMenu />;
  const dir = seen ?? overview?.project.dir;
  const projectName = overview?.projects.find((p) => p.dir === dir)?.name ?? dir?.split("/").pop() ?? "Project";
  const groups = groupWorkflows(workflows.data, projectName, query);
  if (!groups.length) {
    return (
      <Nothing
        label="Workflows"
        menu={menu}
        query={query}
        clearQuery={clearQuery}
        looked="names and descriptions"
        empty={
          <>
            <p>No saved workflows. A workflow is a file in the project's .sous/workflows or in the home's workflows folder. The guide shows how to write one.</p>
            <CommandBox command="sous guide" />
          </>
        }
      />
    );
  }
  // On a name clash the project's workflow wins, so its row is the one the page shows.
  const rows = groups.flatMap((g) => g.items);
  const open = rows.find((row) => row.name === name && row.from === "project") ?? rows.find((row) => row.name === name);
  const keyOf = (row: WorkflowRow) => `${row.from}:${row.name}`;
  return (
    <GroupedList
      groups={groups}
      keyOf={keyOf}
      selected={open && keyOf(open)}
      menu={menu}
      row={(row, index) => {
        const mark = workflowMark(row);
        return (
          <NameRow
            to="/workflows/$name"
            name={row.name}
            index={index}
            selected={row === open}
            tip={workflowTip(row)}
            mark={
              mark && (
                <>
                  {MARK[mark].node}
                  {mark}
                </>
              )
            }
          />
        );
      }}
    />
  );
}

/** One group of names under the list's own heading, for agents, skills and MCP servers. */
function NameList<T extends { name: string }>({ label, items, menu, row }: { label: string; items: T[]; menu: ReactNode; row: (item: T, index: number, selected: boolean) => ReactNode }) {
  const { name } = useParams({ strict: false });
  const groups: ListGroup<T>[] = [{ key: label, label, items }];
  return <GroupedList groups={groups} keyOf={(item) => item.name} selected={name} menu={menu} row={(item, index) => row(item, index, item.name === name)} />;
}

export function AgentsList({ query, clearQuery }: ListProps) {
  const seen = useSeenFrom();
  const agents = useAgents(seen);
  const waiting = notReady(agents, "Loading agents");
  if (waiting || !agents.data) return waiting;
  const menu = <SeenFromMenu />;
  const rows = pickAgents(agents.data, query);
  if (!rows.length) {
    return (
      <Nothing
        label="Agents"
        menu={menu}
        query={query}
        clearQuery={clearQuery}
        looked="names, descriptions, harnesses and models"
        empty={
          <>
            <p>No agents in the folders sous reads. sous looks in the project's .rulesync/subagents, .claude/agents and .codex/agents, then in the global rulesync folder, ~/.claude/agents and ~/.codex/agents.</p>
            <CommandBox command="~/.claude/agents/reviewer.md" label="Copy the path" />
          </>
        }
      />
    );
  }
  return (
    <NameList
      label="Agents"
      items={rows}
      menu={menu}
      row={(row, index, selected) => {
        const only = onlyOn(row);
        return <NameRow to="/agents/$name" name={row.name} index={index} selected={selected} tip={row.problem ?? row.description} mark={only} />;
      }}
    />
  );
}

export function SkillsList({ query, clearQuery }: ListProps) {
  const seen = useSeenFrom();
  const skills = useSkills(seen);
  const waiting = notReady(skills, "Loading skills");
  if (waiting || !skills.data) return waiting;
  const menu = <SeenFromMenu />;
  const rows = pickSkills(skills.data, query);
  if (!rows.length) {
    return (
      <Nothing
        label="Skills"
        menu={menu}
        query={query}
        clearQuery={clearQuery}
        looked="names and descriptions"
        empty={
          <>
            <p>No skills in the folders sous reads. sous looks in the project's .claude/skills, .agents/skills and .rulesync/skills, then in ~/.claude/skills and ~/.agents/skills. A skill is a folder with a SKILL.md in it.</p>
            <CommandBox command="~/.claude/skills/code-review/SKILL.md" label="Copy the path" />
          </>
        }
      />
    );
  }
  return <NameList label="Skills" items={rows} menu={menu} row={(row, index, selected) => <NameRow to="/skills/$name" name={row.name} index={index} selected={selected} tip={row.description} />} />;
}

export function McpList({ query, clearQuery }: ListProps) {
  const seen = useSeenFrom();
  const mcps = useMcps(seen);
  const waiting = notReady(mcps, "Loading MCP servers");
  if (waiting || !mcps.data) return waiting;
  const menu = <SeenFromMenu />;
  const rows = pickMcps(mcps.data, query);
  if (!rows.length) {
    return (
      <Nothing
        label="MCP servers"
        menu={menu}
        query={query}
        clearQuery={clearQuery}
        looked="names, types and the files that define them"
        empty={
          <>
            <p>No MCP servers in the files sous reads. sous reads .rulesync/mcp.jsonc in the project and in the global rulesync folder, then .mcp.json and ~/.claude.json for Claude Code, and config.toml for Codex.</p>
            <CommandBox command=".rulesync/mcp.jsonc" label="Copy the path" />
          </>
        }
      />
    );
  }
  return <NameList label="MCP servers" items={rows} menu={menu} row={(row, index, selected) => <NameRow to="/mcp/$name" name={row.name} index={index} selected={selected} tip={`${row.type}, from ${row.source}`} />} />;
}

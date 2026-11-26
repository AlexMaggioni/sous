import { ListFilter } from "lucide-react";
import type { ReactNode } from "react";
import type { Project } from "../api/contract.ts";
import { useOverview } from "../api/queries.ts";
import { setSeenFrom, useSeenFrom } from "../api/seen-from.ts";
import { setGroupBy, setRunProject, useGroupBy, useRunProject } from "../shell/prefs.ts";
import { Menu, MenuChoice, MenuSeparator } from "../ui/menu.tsx";
import type { GroupBy } from "./run-groups.ts";

// The one icon menu of a list, at the right of its first heading: Group by and the project filter
// for runs, "Seen from" for the others. Its icon gets a dot while a filter other than the default is on.

function ViewMenu({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span className="relative inline-flex flex-none">
      <Menu label={on ? "View options, a filter is on" : "View options"} icon={ListFilter} align="end">
        {children}
      </Menu>
      {on && <span aria-hidden="true" className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-fg ring-[1.5px] ring-side" />}
    </span>
  );
}

const ALL = "all";

/** A project's name, or its folder when two projects share the name. */
function projectOptions(projects: readonly Project[]) {
  return projects.map((p) => ({ value: p.dir, label: projects.filter((q) => q.name === p.name).length > 1 ? p.dir : p.name }));
}

/** Group by status or project, and show one project or all of them. */
export function RunsViewMenu({ projects }: { projects: readonly Project[] }) {
  const groupBy = useGroupBy();
  const project = useRunProject();
  return (
    <ViewMenu on={!!project}>
      <MenuChoice<GroupBy>
        label="Group by"
        value={groupBy}
        onChange={setGroupBy}
        options={[
          { value: "status", label: "Status" },
          { value: "project", label: "Project" },
        ]}
      />
      {projects.length > 1 && (
        <>
          <MenuSeparator />
          <MenuChoice label="Project" value={project || ALL} onChange={(dir) => setRunProject(dir === ALL ? "" : dir)} options={[{ value: ALL, label: "All projects" }, ...projectOptions(projects)]} />
        </>
      )}
    </ViewMenu>
  );
}

/**
 * The project a workflow, agent, skill or MCP list is seen from. Picking the project sous serve
 * started in clears the choice, so the lists and the pages share one cache entry for it.
 */
export function SeenFromMenu() {
  const overview = useOverview().data;
  const dir = useSeenFrom();
  if (!overview) return null;
  const own = overview.project.dir;
  return (
    <ViewMenu on={!!dir && dir !== own}>
      <MenuChoice label="Seen from" value={dir ?? own} onChange={(next) => setSeenFrom(next === own ? undefined : next)} options={projectOptions(overview.projects)} />
    </ViewMenu>
  );
}

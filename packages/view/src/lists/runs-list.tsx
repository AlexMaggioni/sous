import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { Project, RunRow } from "../api/contract.ts";
import { useOverview, useRemoveRun, useRuns } from "../api/queries.ts";
import { FILTER_ID } from "../shell/list-nav.ts";
import { setRunProject, useGroupBy, useRunProject } from "../shell/prefs.ts";
import { Button } from "../ui/button.tsx";
import { CommandBox } from "../ui/copy.tsx";
import { leave } from "../ui/motion.ts";
import { Refusal } from "../ui/refusal.tsx";
import { LoadingRows } from "../ui/skeleton.tsx";
import { RunLine } from "./list-row.tsx";
import { ColumnNote, GroupedList, GroupHeading, ListBody } from "./list-view.tsx";
import { removeLater, useHiddenRuns } from "./removals.ts";
import { groupRuns, pickRuns } from "./run-groups.ts";
import { RunsViewMenu } from "./view-menu.tsx";

/** The time now, a minute at a time, so the ages in the rows stay true. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The projects of the overview, and any project a run names that the overview left out. */
function projectsOf(known: readonly Project[], runs: readonly RunRow[]): Project[] {
  const out = new Map(known.map((p) => [p.dir, p]));
  for (const run of runs) if (!out.has(run.project.dir)) out.set(run.project.dir, run.project);
  return [...out.values()];
}

/** After a row leaves, focus goes to the row that took its place, or to the one above, or to the search. */
function refocus(index: number) {
  requestAnimationFrame(() => {
    const at = (i: number) => document.querySelector<HTMLElement>(`#list-body [data-row="${i}"]`);
    (at(index) ?? at(index - 1) ?? document.getElementById(FILTER_ID))?.focus();
  });
}

/** Every run, grouped by status or by project, with what needs the person first. */
export function RunsList({ query, clearQuery }: { query: string; clearQuery: () => void }) {
  const runs = useRuns();
  const known = useOverview().data?.projects;
  const groupBy = useGroupBy();
  const project = useRunProject();
  const hidden = useHiddenRuns();
  const remove = useRemoveRun();
  const now = useMinute();
  const { runId } = useParams({ strict: false });

  const all = runs.data;
  const projects = useMemo(() => projectsOf(known ?? [], all ?? []), [known, all]);
  const shown = useMemo(() => pickRuns(all ?? [], { query, project, hidden }), [all, query, project, hidden]);
  const groups = useMemo(() => groupRuns(shown, groupBy), [shown, groupBy]);

  if (runs.isPending) {
    return (
      <ListBody>
        <div className="pt-4">
          <LoadingRows label="Loading runs" rows={9} rowHeight={28} />
        </div>
      </ListBody>
    );
  }
  if (runs.isError) {
    return (
      <ListBody>
        <div className="px-2 pt-4">
          <Refusal error={runs.error} action={<Button size="sm" onClick={() => runs.refetch()}>Try again</Button>} />
        </div>
      </ListBody>
    );
  }

  const menu = <RunsViewMenu projects={projects} />;
  if (!all?.some((run) => !hidden.has(run.id))) {
    return (
      <ListBody>
        <GroupHeading label="Runs" count={0} />
        <ColumnNote>
          <p>No runs yet. Start one with the button above, or from a terminal.</p>
          <CommandBox command="sous run <workflow>" />
        </ColumnNote>
      </ListBody>
    );
  }
  if (!groups.length) {
    const others = pickRuns(all, { query, hidden }).length;
    return (
      <ListBody>
        <GroupHeading label="Runs" count={0} menu={menu} />
        <ColumnNote>
          {query && <p>No run matches "{query}". The search looks at titles, workflows, projects and ids.</p>}
          {query && <Button size="sm" onClick={clearQuery}>Clear the search</Button>}
          {project && others > 0 && <p>The project filter hides {others === 1 ? "1 run" : `${others} runs`} in other projects.</p>}
          {project && others > 0 && <Button size="sm" onClick={() => setRunProject("")}>Show all projects</Button>}
        </ColumnNote>
      </ListBody>
    );
  }

  const mixed = groupBy === "status" && new Set(shown.map((run) => run.project.dir)).size > 1;
  return (
    <GroupedList
      groups={groups}
      keyOf={(run) => run.id}
      selected={runId}
      menu={menu}
      filter={`${query}\n${project}\n${groupBy}`}
      row={(run, index) => (
        <RunLine
          run={run}
          index={index}
          selected={run.id === runId}
          withProject={mixed}
          now={now}
          onRemove={() => {
            // The row fades out, then leaves, and the rows below slide up into its place.
            const row = document.querySelector<HTMLElement>(`#list-body [data-motion-key="${CSS.escape(run.id)}"]`);
            leave(row, () => {
              removeLater(run, remove.mutateAsync);
              refocus(index);
            });
          }}
        />
      )}
    />
  );
}

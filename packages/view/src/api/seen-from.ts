import { useSyncExternalStore } from "react";
import { readStored, store } from "../storage.ts";
import { useOverview } from "./queries.ts";

// The project the workflows, agents, skills and MCP servers are seen from, since what sous finds
// depends on it. Unset means the project `sous serve` started in. The lists and the pages share it,
// and this browser remembers it. A link to a catalog page can name its own project in
// ?project=, such as a link from a run to its workflow, and the page reads that first.

const KEY = "sous.seenFrom";
const listeners = new Set<() => void>();

let current = readStored(KEY) ?? undefined;

/** See the catalog from another project sous knows, or from the server's own with undefined. */
export function setSeenFrom(dir: string | undefined): void {
  current = dir || undefined;
  store(KEY, current);
  for (const listener of listeners) listener();
}

/** The project to pass as `project` to the catalog's queries. */
export function useSeenFrom(): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** The project a catalog page is seen from: the one its link names, else the lists'. */
export function usePageProject(named: string | undefined): string | undefined {
  const seen = useSeenFrom();
  return named ?? seen;
}

/** The search of a link to a catalog page, so it opens seen from `project`. Empty when the lists are seen from there already. */
export function useProjectSearch(project: string | undefined): { project?: string } {
  const seen = useSeenFrom();
  return project && project !== seen ? { project } : {};
}

/**
 * The name of a project, such as "shop": the server's own when `project` is unset. A folder sous
 * no longer lists, such as a remembered one that went away, goes by its last part.
 */
export function useProjectName(project: string | undefined): string | undefined {
  const overview = useOverview().data;
  const dir = project ?? overview?.project.dir;
  return overview?.projects.find((p) => p.dir === dir)?.name ?? dir?.split("/").pop();
}

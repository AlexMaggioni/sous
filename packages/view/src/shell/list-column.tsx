import { Plus, Search, X } from "lucide-react";
import { useRef, type Ref } from "react";
import { AgentsList, McpList, SkillsList, WorkflowsList } from "../lists/catalog-lists.tsx";
import { RunsList } from "../lists/runs-list.tsx";
import { sectionOf, type Section } from "../sections.ts";
import { openStart } from "../start/start-store.ts";
import { Button, IconButton } from "../ui/button.tsx";
import { useArrive } from "../ui/motion.ts";
import { COLUMN_ID, FILTER_ID, moveInList } from "./list-nav.ts";
import { setListQuery, useListQuery } from "./prefs.ts";

const LISTS = { runs: RunsList, workflows: WorkflowsList, agents: AgentsList, skills: SkillsList, mcp: McpList } as const;

/**
 * The Search row: a field that filters the list below as the person types. `/` focuses it. Escape
 * clears it, then leaves it. Down moves to the first row, and Enter opens it.
 */
function FilterRow({ section }: { section: Section }) {
  const query = useListQuery(section.id);
  const clear = () => setListQuery(section.id, "");
  return (
    <div className="group/search relative flex h-7 items-center rounded-md text-muted focus-within:bg-hover hover:bg-hover max-[699px]:h-10">
      <Search size={16} strokeWidth={1.5} aria-hidden="true" className="pointer-events-none absolute left-2 text-icon" />
      <input
        id={FILTER_ID}
        type="search"
        value={query}
        onChange={(e) => setListQuery(section.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (query) clear();
            else e.currentTarget.blur();
          } else if (e.key === "ArrowDown" || e.key === "Enter") {
            const first = document.querySelector<HTMLElement>('#list-body [data-row="0"]');
            if (!first) return;
            e.preventDefault();
            if (e.key === "Enter") first.click();
            else moveInList(1);
          }
        }}
        placeholder="Search"
        aria-label={`Search ${section.noun}`}
        aria-keyshortcuts="/"
        aria-controls="list-body"
        autoComplete="off"
        spellCheck={false}
        className="h-full w-full min-w-0 rounded-md bg-transparent pr-8 pl-8 text-fg outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-fg focus-visible:outline-solid [&::-webkit-search-cancel-button]:appearance-none"
      />
      {query ? (
        <span className="absolute right-0.5 flex">
          <IconButton icon={X} label="Clear the search" size="sm" onClick={clear} />
        </span>
      ) : (
        <kbd aria-hidden="true" className="pointer-events-none absolute right-2 text-muted group-focus-within/search:hidden">
          /
        </kbd>
      )}
    </div>
  );
}

/** The rows of one section, filtered by its search. */
function SectionList({ section }: { section: Section }) {
  const query = useListQuery(section.id);
  const List = LISTS[section.id];
  return <List query={query} clearQuery={() => setListQuery(section.id, "")} />;
}

/**
 * The list column, as references/paradev-sidebar.png: the section's create action, the Search
 * row, then the section's headed groups of 28px rows. Another section's list arrives like a new
 * page. While `leaving`, it slides away over the page, which already took its width, and takes no
 * press or focus.
 */
export function ListColumn({ ref, pathname, overlay, leaving = false }: { ref?: Ref<HTMLElement>; pathname: string; overlay: boolean; leaving?: boolean }) {
  const section = sectionOf(pathname);
  const canStart = section?.id === "runs" || section?.id === "workflows";
  const content = useRef<HTMLDivElement>(null);
  useArrive(content, section?.id ?? "");
  const over = overlay || leaving;

  return (
    <aside
      ref={ref}
      id={COLUMN_ID}
      data-overlay={overlay || undefined}
      aria-label={section ? `${section.label} list` : "List"}
      aria-hidden={leaving || undefined}
      inert={leaving}
      data-surface="side"
      className={`flex min-h-0 w-[var(--colw)] flex-none flex-col border-r border-line bg-side ${
        over ? "absolute inset-y-0 left-[var(--rail)] z-30 max-[699px]:top-12 max-[699px]:left-0 max-[699px]:w-full max-[699px]:border-r-0" : ""
      } ${overlay ? "shadow-pop" : ""} ${leaving ? "pointer-events-none" : ""}`}
    >
      <div ref={content} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-col gap-0.5 px-2 pt-3">
          {canStart && (
            <Button size="sm" icon={Plus} onClick={() => openStart()} className="w-full justify-start!">
              Start a workflow
            </Button>
          )}
          {section && <FilterRow section={section} />}
        </div>
        {section ? <SectionList section={section} /> : <p className="px-4 pt-4 text-xs text-muted">Pick a section in the rail to see its list here.</p>}
      </div>
    </aside>
  );
}

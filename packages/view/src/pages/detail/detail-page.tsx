// The layout the workflow, agent, skill and MCP pages share, as DESIGN.md draws a Linear issue:
// the header, a banner only for what needs the person or is wrong, then the content on the left
// and the details on the right. Under 1100px, or on a page under 800px wide, the details sit
// under the header as a compact block. The details come first in the page, so the tab order goes
// from the header's buttons down the details, then to the content.
import { Link } from "@tanstack/react-router";
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { SousError } from "../../api/client.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyState } from "../../ui/empty-state.tsx";
import { Facts, type Fact } from "../../ui/facts.tsx";
import { Refusal } from "../../ui/refusal.tsx";
import { LoadingRows, Skel } from "../../ui/skeleton.tsx";
import { StatusIcon } from "../../ui/status-icon.tsx";
import { useMedia, useWidth, WIDE } from "../../ui/use-media.ts";
import { Page } from "../page.tsx";

export type CatalogSection = "workflows" | "agents" | "skills" | "mcp";

const LIST = { workflows: "/workflows", agents: "/agents", skills: "/skills", mcp: "/mcp" } as const;
const SECTION_NAME: Record<CatalogSection, string> = { workflows: "Workflows", agents: "Agents", skills: "Skills", mcp: "MCP servers" };
const ONE: Record<CatalogSection, string> = { workflows: "workflow", agents: "agent", skills: "skill", mcp: "MCP server" };

/** A link in a value or a sentence, underlined as DESIGN.md asks of links in running text. */
export const LINK = "rounded-sm underline decoration-1 underline-offset-2 hover:text-fg";

/** The breadcrumb's parts: the list, then the name. Page puts them in its own nav. */
function Crumbs({ section, name }: { section: CatalogSection; name: string }) {
  return (
    <>
      <Link to={LIST[section]} className="rounded-sm hover:text-fg">
        {SECTION_NAME[section]}
      </Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page" className="min-w-0 truncate">
        {name}
      </span>
    </>
  );
}

/** True when the details get their own column: a window of 1100px and up, and a page of 800px and up. */
function useDetailsBeside(ref: RefObject<HTMLElement | null>): boolean {
  const wideWindow = useMedia(WIDE);
  // Both hooks run on each render, so a window that narrows keeps the same hooks.
  const width = useWidth(ref);
  return wideWindow && width >= 800;
}

export type DetailPageProps = {
  section: CatalogSection;
  name: string;
  description?: string;
  /** The primary action and the "More" menu, at the right of the title. */
  actions?: ReactNode;
  /** Banners, only for what needs the person or is wrong. */
  banners?: ReactNode;
  /** What spans the whole width above the two columns, such as a workflow's graph. */
  top?: ReactNode;
  facts: readonly Fact[];
  /** The content column. */
  children: ReactNode;
};

export function DetailPage({ section, name, description, actions, banners, top, facts, children }: DetailPageProps) {
  const box = useRef<HTMLDivElement>(null);
  const beside = useDetailsBeside(box);
  const details = (
    <aside aria-label="Details" className={beside ? "col-start-2 row-start-1 min-w-0" : "mt-6"}>
      <Facts items={facts} layout={beside ? "column" : "row"} />
    </aside>
  );
  return (
    <Page crumbs={<Crumbs section={section} name={name} />} title={name} actions={actions}>
      <div ref={box}>
        {description && <p className="mt-1 max-w-[60em] text-pretty text-muted">{description}</p>}
        {banners}
        {!beside && details}
        {top && <div className="mt-8">{top}</div>}
        <div className={beside ? "mt-8 grid grid-cols-[minmax(0,1fr)_260px] gap-x-12" : "mt-8"}>
          {beside && details}
          <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-8">{children}</div>
        </div>
      </div>
    </Page>
  );
}

/** A heading and its content. Space separates sections, not lines. */
export function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="font-medium">
          {title}
        </h2>
        {meta !== undefined && <span className="text-xs text-muted tabular-nums">{meta}</span>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * A line under the header for what needs the person (the copper dot) or what is wrong (the red ×).
 * The icon carries the color, so the box has none, as the run page's notes do.
 */
export function Banner({ tone, title, children, actions }: { tone: "needs" | "failed"; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div role="note" className="mt-4 flex items-start gap-2">
      <span className="flex h-5 flex-none items-center">
        <StatusIcon status={tone} label={false} />
      </span>
      <div className="max-w-[40em] min-w-0 flex-1 text-pretty">
        <div>
          <span className="font-medium">{title}</span>
          {children && <> {children}</>}
        </div>
        {actions && <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** A value that says nothing is set, such as "None" or "No step". */
export function None({ children = "None" }: { children?: ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

/** Values one per line, such as the workflows that use this one. */
export function Stack({ children }: { children: ReactNode }) {
  return <span className="flex flex-col items-start gap-0.5">{children}</span>;
}

/** The page while it loads: the header and the details in gray, then rows, in the same places. */
export function DetailLoading({ section, name }: { section: CatalogSection; name: string }) {
  return (
    <Page crumbs={<Crumbs section={section} name={name} />} title={name}>
      <div className="mt-1 h-5">
        <Skel className="inline-block h-4 w-72 max-w-full" />
      </div>
      <div className="mt-6 flex flex-wrap gap-x-10 gap-y-3">
        {["w-20", "w-24", "w-16", "w-28"].map((w) => (
          <Skel key={w} className={`inline-block h-9 ${w}`} />
        ))}
      </div>
      <div className="mt-8">
        <LoadingRows label={`Loading the ${ONE[section]}`} rows={6} />
      </div>
    </Page>
  );
}

/** The server has no such name: the file went away, or the link has a typo. */
export const isMissing = (error: unknown) => error instanceof SousError && (error.status === 404 || error.code.startsWith("no_such_"));

/** No such name says so and links back to the list. Any other error shows as a refusal, with a retry. */
export function DetailFailed({ section, name, error, retry, seenFrom }: { section: CatalogSection; name: string; error: unknown; retry: () => void; seenFrom?: string }) {
  const missing = isMissing(error);
  return (
    <Page crumbs={<Crumbs section={section} name={name} />} title={name}>
      {missing ? (
        <EmptyState
          title={`No ${ONE[section]} named ${name}`}
          action={
            <Link to={LIST[section]} className="inline-flex h-8 items-center rounded-md bg-hover px-3 font-medium hover:bg-selected max-[699px]:h-10">
              Back to {SECTION_NAME[section].toLowerCase().replace("mcp", "MCP")}
            </Link>
          }
        >
          {seenFrom ? `Seen from ${seenFrom}, sous finds no ${ONE[section]} by that name. ` : `sous finds no ${ONE[section]} by that name. `}
          It was moved or removed, or the link has a typo.
        </EmptyState>
      ) : (
        <div className="mt-4">
          <Refusal
            error={error}
            action={
              <Button size="sm" onClick={retry}>
                Try again
              </Button>
            }
          />
        </div>
      )}
    </Page>
  );
}

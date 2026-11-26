import type { ReactNode } from "react";

/**
 * The frame every page shares: the breadcrumb row, kept on pages without one so titles line up,
 * then the serif title and the page's actions at its right. Content at most 1080px wide, 16px from the
 * top, 32px from the sides and 16px under 700px.
 */
export function Page({ crumbs, title, actions, children }: { crumbs?: ReactNode; title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="max-w-[1080px] px-8 pt-4 pb-24 max-[699px]:px-4">
      <div className="mb-2 flex min-h-7 items-center gap-1.5 text-xs text-muted">
        {crumbs && (
          <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-1.5">
            {crumbs}
          </nav>
        )}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="page-title min-w-0">{title}</h1>
        {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

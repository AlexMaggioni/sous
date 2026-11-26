import type { ReactNode } from "react";

/** One kit section: a heading, then its examples. Page sections sit 32px apart. */
export function KitSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="mb-3">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A group of examples inside a section, such as Buttons inside Components. */
export function KitGroup({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="mt-6 first:mt-0">
      <h3 className="mb-1 text-xs font-medium text-muted">{title}</h3>
      {note && <p className="mb-3 max-w-[34em] text-xs text-pretty text-muted">{note}</p>}
      <div className={note ? "" : "mt-2"}>{children}</div>
    </div>
  );
}

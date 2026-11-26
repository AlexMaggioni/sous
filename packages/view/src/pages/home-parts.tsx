import type { ReactNode } from "react";
import { Button } from "../ui/button.tsx";
import { Refusal } from "../ui/refusal.tsx";
import { LoadingRows } from "../ui/skeleton.tsx";

// What the section homes share: a part with its heading and count, the stand-in while a read can't
// show, and the plain table, with a muted header row, hairlines between rows, numbers at the right
// in tabular figures, and columns that drop out on narrow screens.

/** A heading over one part of a home page, with its count. */
export function Part({ title, count, needs = false, children }: { title: string; count?: number; needs?: boolean; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className={`mb-2 text-sm font-medium ${needs ? "text-needs-text" : "text-fg"}`}>
        {title} {count !== undefined && <span className="ml-0.5 font-normal text-muted tabular-nums">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

/** The loading rows or the refusal while a read can't show, else null. */
export function notReady(query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }, label: string): ReactNode {
  if (query.isPending) {
    return (
      <div className="mt-8">
        <LoadingRows label={label} rows={5} />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="mt-8">
        <Refusal error={query.error} action={<Button onClick={() => query.refetch()}>Try again</Button>} />
      </div>
    );
  }
  return null;
}

/** Under which page width a column hides, so the name and the main number always stay. */
const HIDE = { 450: "max-[449px]:hidden", 600: "max-[599px]:hidden", 700: "max-[699px]:hidden", 900: "max-[899px]:hidden" } as const;

export interface Column<T> {
  head: string;
  cell: (row: T) => ReactNode;
  /** Right-aligned in tabular figures. */
  num?: boolean;
  /** Takes the room left over and fades a long value at its end. */
  fill?: boolean;
  muted?: boolean;
  hideBelow?: keyof typeof HIDE;
}

export function HomeTable<T>({ rows, columns, rowKey }: { rows: readonly T[]; columns: readonly Column<T>[]; rowKey: (row: T) => string }) {
  const cls = (column: Column<T>, first: boolean) =>
    [first ? "pr-3" : "px-3 last:pr-0", column.num ? "text-right tabular-nums whitespace-nowrap" : "text-left", column.fill ? "w-full max-w-0" : "whitespace-nowrap", column.muted ? "text-muted" : "", column.hideBelow ? HIDE[column.hideBelow] : ""].join(" ");
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-line">
          {columns.map((column, i) => (
            <th key={column.head} scope="col" className={`py-1.5 text-xs font-normal text-muted ${cls(column, i === 0)}`}>
              {column.head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} className="h-9 border-b border-line max-[699px]:h-10">
            {columns.map((column, i) => {
              const cell = column.cell(row);
              return (
                <td key={column.head} className={cls(column, i === 0)}>
                  {/* A faded text keeps all of it in its tooltip. */}
                  {column.fill ? (
                    <span className="fade-end block" title={typeof cell === "string" ? cell : undefined}>
                      {cell}
                    </span>
                  ) : (
                    cell
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

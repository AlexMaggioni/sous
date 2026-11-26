// Label and value pairs, as the details column and the run header show them, and a path with its copy button.
import type { ReactNode } from "react";
import { CopyButton } from "./copy.tsx";
import { Tip } from "./tooltip.tsx";

export type Fact = { label: string; value: ReactNode; sub?: ReactNode };

/**
 * A 12px muted label above a 13px value. `column` stacks the pairs, for the details column.
 * `row` lays them side by side and wraps, for the run header. `sub` is a muted line under the value.
 */
export function Facts({ items, layout = "column" }: { items: readonly Fact[]; layout?: "column" | "row" }) {
  return (
    <dl className={layout === "row" ? "flex flex-wrap gap-x-10 gap-y-3 max-[699px]:gap-x-5" : "flex flex-col gap-3"}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-muted">{item.label}</dt>
          <dd className="mt-0.5 tabular-nums [overflow-wrap:anywhere]">
            {item.value}
            {item.sub && <span className="block text-xs text-muted">{item.sub}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The last part of a path, such as "ticket.js" for ".sous/workflows/ticket.js". */
export function fileName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** A path shortened to its file name in mono, with the full path in a tooltip and a copy button. */
export function Path({ path }: { path: string }) {
  const name = fileName(path);
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 align-middle">
      <Tip text={path}>
        <button type="button" className="min-w-0 cursor-default truncate rounded-sm font-mono text-xs">
          {name}
        </button>
      </Tip>
      <CopyButton text={path} label="Copy the path" />
    </span>
  );
}

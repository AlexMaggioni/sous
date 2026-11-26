// Gray rows that hold the layout while a list loads. No spinner over the page.
const WIDTHS = ["62%", "48%", "71%", "38%", "55%", "66%", "44%", "58%"];

/** One gray bar, such as a title's place. Its size comes from `className`. */
export function Skel({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`skel ${className}`} />;
}

/**
 * Rows of the height the loaded list will have: 28 in the list column, 36 for runs and steps, and
 * 40 under 700px. `label` says what loads, such as "Loading runs", for screen readers.
 */
export function LoadingRows({ label, rows = 5, rowHeight = 36 }: { label: string; rows?: number; rowHeight?: 28 | 36 }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden="true" className={`flex items-center gap-2 px-2 max-[699px]:h-10 ${rowHeight === 28 ? "h-7" : "h-9"}`}>
          <span className="size-3.5 flex-none rounded-full bg-skel" />
          <span className="skel" style={{ width: WIDTHS[i % WIDTHS.length] }} />
        </div>
      ))}
    </div>
  );
}

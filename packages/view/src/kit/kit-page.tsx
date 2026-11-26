import { formatAgo, formatCost, formatDuration, formatFull, formatTokens } from "../format.ts";
import { Page } from "../pages/page.tsx";
import { STATUS_LABEL, StatusIcon, type Status } from "../ui/status-icon.tsx";
import { GraphSection } from "./graph-section.tsx";
import { KitSection } from "./kit-section.tsx";
import { MarkdownSection } from "./markdown-section.tsx";
import { UiSection } from "./ui-section.tsx";

// The kit: every token and component of the view, in each of its states, on one page at #/kit.
// Build a component here first, then use it on a page. Only the dev server has this page.

/** The tokens of tokens.css. In Tailwind, --bg is base, --bg-side side, --border line, --text fg, --text-muted muted, --icon-muted icon. */
const COLORS = [
  "bg", "bg-side", "bg-raised", "bg-hover", "bg-selected", "border", "border-strong", "edge", "text", "text-muted", "icon-muted",
  "needs", "needs-tint", "run", "run-tint", "fail", "fail-tint", "done-tint", "ink", "skel",
] as const;

const NOW = Date.UTC(2026, 10, 25, 15, 0, 0);

export function KitPage() {
  return (
    <Page title="Kit">
      <p className="mt-1 text-muted">Every token and component of the view, in each state. Switch the theme in the rail to check both.</p>

      <KitSection id="kit-colors" title="Colors">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
          {COLORS.map((c) => (
            <div key={c} className="flex items-center gap-2">
              <span className="size-6 flex-none rounded-sm border border-line" style={{ background: `var(--${c})` }} />
              <code className="text-muted">--{c}</code>
            </div>
          ))}
        </div>
      </KitSection>

      <KitSection id="kit-type" title="Type">
        <div className="flex flex-col gap-3">
          <p className="page-title">Page title, Newsreader 24px</p>
          <h3>Section heading, 13px 500</h3>
          <p>Body, row names and values, 13px 400.</p>
          <p className="text-xs text-muted">Labels and meta, 12px, muted</p>
          <p>
            <code>r-2c8f1d</code> <code>sous resume r-8d2v7f --step verify</code>
          </p>
        </div>
      </KitSection>

      <KitSection id="kit-status" title="Status icons">
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
            <span key={s} className="flex items-center gap-2">
              <StatusIcon status={s} label={false} />
              {STATUS_LABEL[s]}
            </span>
          ))}
        </div>
      </KitSection>

      <KitSection id="kit-formats" title="Formats">
        <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          <dt className="text-xs text-muted">Durations</dt>
          <dd className="m-0 mono">{[840, 12_000, 248_000, 4_320_000].map(formatDuration).join(", ")}</dd>
          <dt className="text-xs text-muted">Tokens</dt>
          <dd className="m-0 mono">{[980, 12_400, 1_250_000].map(formatTokens).join(", ")}</dd>
          <dt className="text-xs text-muted">Cost</dt>
          <dd className="m-0 mono">{formatCost(0.42)}</dd>
          <dt className="text-xs text-muted">Times</dt>
          <dd className="m-0" title={formatFull(NOW - 3 * 60_000)}>
            {[NOW - 20_000, NOW - 3 * 60_000, NOW - 5 * 3_600_000, NOW - 2 * 86_400_000].map((t) => formatAgo(t, NOW)).join(", ")}
          </dd>
        </dl>
      </KitSection>

      <UiSection />
      <GraphSection />
      <MarkdownSection />
    </Page>
  );
}

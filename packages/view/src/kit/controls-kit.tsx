// The kit's switch, folding sections and scroll boxes.
import { useState } from "react";
import { Fold } from "../ui/fold.tsx";
import { ScrollBox } from "../ui/scroll-area.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { KitGroup } from "./kit-section.tsx";

const VIEWS = [
  { value: "graph", label: "Graph" },
  { value: "steps", label: "Steps" },
  { value: "source", label: "Source" },
] as const;

const STEPS = ["implementer", "reviewer", "address review", "reviewer", "tests", "commit"];

export function ControlsKit() {
  const [view, setView] = useState<(typeof VIEWS)[number]["value"]>("graph");
  const [open, setOpen] = useState(false);
  return (
    <>
      <KitGroup title="Switch" note="Two or three views of the same thing. Arrow keys move, and the group is one tab stop.">
        <div className="flex flex-wrap items-center gap-6">
          <Segmented label="View" value={view} onChange={setView} options={VIEWS} />
          <Segmented label="Show as" value={view === "graph" ? "rendered" : "raw"} onChange={(v) => setView(v === "rendered" ? "graph" : "steps")} options={[{ value: "rendered", label: "Rendered" }, { value: "raw", label: "Raw" }]} size="sm" />
          <span className="text-xs text-muted">Showing {view}</span>
        </div>
      </KitGroup>

      <KitGroup title="Folding section" note="Closed, open, and opened from outside, as a link to a step does.">
        <div className="flex max-w-[560px] flex-col gap-1">
          <Fold title="Prompt" meta="12 lines">
            <p className="text-muted">Implement this ticket: round invoice totals once, at the end.</p>
          </Fold>
          <Fold title="Raw input" meta="3 keys" defaultOpen>
            <pre className="font-mono text-xs text-muted">{'{ "ticket": "BILL-142", "rounds": 3 }'}</pre>
          </Fold>
          <Fold title="reviewer, attempt 2 of 3" open={open} onOpenChange={setOpen}>
            <p className="text-muted">Blocks: credit notes still round per line. Call total() here too.</p>
          </Fold>
          <button type="button" className="mt-1 self-start text-xs text-muted underline underline-offset-2" onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : "Open"} the reviewer from here
          </button>
        </div>
      </KitGroup>

      <KitGroup title="Scroll box" note="Wide or long content scrolls in its own box, never the page. The box takes focus, so arrow keys scroll it.">
        <div className="grid grid-cols-1 items-start gap-4 min-[900px]:grid-cols-2">
          <div className="rounded-lg border border-line">
            <ScrollBox label="Steps of r-2c8f1d">
              <table className="w-max min-w-full text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    {["Step", "Agent", "Model", "Tokens", "Cost", "Started", "Duration", "Worktree"].map((h) => (
                      <th key={h} className="px-3 py-2 font-normal">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {STEPS.map((step, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-3 py-2 font-mono text-xs">{step}</td>
                      <td className="px-3 py-2">{step === "tests" || step === "commit" ? "code" : "Claude Code"}</td>
                      <td className="px-3 py-2">claude/opus</td>
                      <td className="px-3 py-2 tabular-nums">12.4k</td>
                      <td className="px-3 py-2 tabular-nums">$0.42</td>
                      <td className="px-3 py-2">14:05:09</td>
                      <td className="px-3 py-2 tabular-nums">4m 08s</td>
                      <td className="px-3 py-2 font-mono text-xs">~/.sous/worktrees/billing/r-2c8f1d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollBox>
          </div>
          <div className="rounded-lg border border-line">
            <ScrollBox label="Activity of reviewer" maxHeight={180}>
              <ol className="px-3 py-2 font-mono text-xs leading-[1.6]">
                {Array.from({ length: 30 }, (_, i) => (
                  <li key={i}>
                    <span className="text-muted">14:{String(5 + Math.floor(i / 6)).padStart(2, "0")}</span> {i % 3 === 0 ? "Read src/invoices/total.ts" : i % 3 === 1 ? "Ran pnpm test --run invoices" : "Wrote a note on line 42"}
                  </li>
                ))}
              </ol>
            </ScrollBox>
          </div>
        </div>
      </KitGroup>
    </>
  );
}

// A section that opens and closes under its name, such as a step's prompt or a run's raw input.
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The name is a button with a chevron that turns as the section opens. `meta` sits at the right of
 * the name, such as "12 lines". Pass `open` and `onOpenChange` when a link must open it.
 */
export function Fold({ title, meta, defaultOpen = false, open, onOpenChange, children }: { title: ReactNode; meta?: ReactNode; defaultOpen?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode }) {
  return (
    <Collapsible {...(open === undefined ? { defaultOpen } : { open })} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      <CollapsibleTrigger className="group -mx-1.5 flex min-h-7 w-[calc(100%+12px)] items-center gap-1.5 rounded-md px-1.5 text-left font-medium hover:bg-hover max-[699px]:min-h-10">
        <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" className="flex-none text-icon transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {meta && <span className="flex-none text-xs font-normal text-muted">{meta}</span>}
      </CollapsibleTrigger>
      <CollapsiblePanel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--base) data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-opacity motion-reduce:data-starting-style:opacity-0">
        <div className="pt-2 pb-1">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

// A box that scrolls on its own, for wide or long content such as code, a diff or a table.
import { ScrollArea, ScrollAreaContent, ScrollAreaCorner, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport } from "@ui-sdk/react/scroll-area";
import type { ReactNode } from "react";

/**
 * The page never scrolls sideways: wide content scrolls here, with a scroll bar that shows while
 * the content overflows. `label` names the region, and the box takes keyboard focus when nothing
 * inside it can. `maxHeight` in px caps a long box, which then scrolls down too.
 */
export function ScrollBox({ label, maxHeight, children }: { label: string; maxHeight?: number; children: ReactNode }) {
  return (
    <ScrollArea type="auto" data-scroll-x="" className="relative min-w-0">
      <ScrollAreaViewport role="region" aria-label={label} className="w-full rounded-[inherit] focus-visible:-outline-offset-2" style={maxHeight ? { maxHeight } : undefined}>
        <ScrollAreaContent className="min-w-full">{children}</ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar orientation="horizontal">
        <ScrollAreaThumb />
      </ScrollAreaScrollbar>
      <ScrollAreaScrollbar orientation="vertical">
        <ScrollAreaThumb />
      </ScrollAreaScrollbar>
      <ScrollAreaCorner />
    </ScrollArea>
  );
}

// Tooltips: a short name or hint on hover and on keyboard focus, in ink, like the mock's .tip.
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@ui-sdk/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { POPUP } from "./motion.ts";

export type Side = "top" | "bottom" | "left" | "right";

/** The ink box every tooltip shares. With `shortcut`, the keys follow the text, as in "Hide sidebar ⌘B". */
export function TipContent({ side = "top", shortcut = false, children }: { side?: Side; shortcut?: boolean; children: ReactNode }) {
  return (
    <TooltipContent
      side={side}
      sideOffset={6}
      collisionPadding={8}
      className={`z-50 max-w-80 rounded-md bg-ink px-2 py-1 text-xs text-on-ink [overflow-wrap:anywhere] ${POPUP} data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:transition-none`}
    >
      {children}
      {shortcut && <TooltipShortcut className="ml-2 opacity-70" />}
    </TooltipContent>
  );
}

/**
 * A tooltip on a button, or on a part that renders one. Text that only shows more on hover, such
 * as a time or a file name, goes in a plain `<button type="button">` too, as UI SDK's tooltip docs
 * do, so it has a name and the keyboard reaches it. The tooltip names a trigger with no text of its
 * own, and describes any other. `shortcut`, such as "mod+b", shows the keys. It doesn't bind them.
 */
export function Tip({ text, shortcut, side, children }: { text: ReactNode; shortcut?: string; side?: Side; children: ReactElement }) {
  return (
    <Tooltip shortcut={shortcut}>
      <TooltipTrigger render={children} />
      <TipContent side={side} shortcut={!!shortcut}>
        {text}
      </TipContent>
    </Tooltip>
  );
}

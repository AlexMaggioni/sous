// The dialog: a title, a body that scrolls, and the actions at the bottom right, over a scrim.
import { DialogBackdrop, DialogContent, DialogDescription, DialogTitle, Dialog as SdkDialog } from "@ui-sdk/react/dialog";
import type { ReactNode } from "react";
import { POPUP } from "./motion.ts";

/**
 * The scrim and the box every dialog shares, the confirm question too. 460px wide, 12vh from the top.
 * The box arrives like the rest, up 4px with a fade, and both leave with a fade.
 */
export const SCRIM = `fixed inset-0 z-50 bg-scrim ${POPUP} data-ending-style:opacity-0 data-starting-style:opacity-0`;
export const BOX = `fixed inset-x-0 top-[12vh] z-50 mx-auto flex max-h-[76dvh] w-[min(460px,calc(100%-32px))] flex-col rounded-lg border border-line-strong bg-raised p-0 text-fg outline-none ${POPUP} data-ending-style:opacity-0 data-starting-style:translate-y-1 data-starting-style:opacity-0`;

/**
 * A dialog for a task that needs the person's full attention, such as starting a workflow.
 * The header and the actions stay put while a long body scrolls. Escape and the scrim close it,
 * and focus goes back to where it was. `wide` gives a diff or a long file 720px.
 */
export function Dialog({ open, onOpenChange, title, description, actions, wide = false, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: ReactNode; actions?: ReactNode; wide?: boolean; children?: ReactNode }) {
  return (
    <SdkDialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogBackdrop className={SCRIM} />
      <DialogContent className={wide ? `${BOX} sm:w-[min(720px,calc(100%-32px))]` : BOX}>
        <div className="flex-none px-5 pt-5">
          <DialogTitle className="text-[15px] font-medium">{title}</DialogTitle>
          {description && <DialogDescription className="mt-2 text-muted">{description}</DialogDescription>}
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-1">{children}</div>}
        {actions && <div className="flex flex-none flex-wrap justify-end gap-2 px-5 pt-4 pb-5">{actions}</div>}
        {!actions && <div className="h-5 flex-none" />}
      </DialogContent>
    </SdkDialog>
  );
}

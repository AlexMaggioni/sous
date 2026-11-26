// The confirm question: names the thing and the path it removes, and asks once before a step that can't be undone.
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  createConfirm,
} from "@ui-sdk/react/alert-dialog";
import { useRef, type ReactNode } from "react";
import { Button } from "./button.tsx";
import { BOX, SCRIM } from "./dialog.tsx";
import { Refusal } from "./refusal.tsx";

export type ConfirmQuestion = {
  /** The question, naming the thing, such as "Remove fix-tests.js?". */
  title: string;
  /** What agreeing does, in plain words. */
  body: ReactNode;
  /** The file or folder it touches, shown whole in mono. */
  path?: string;
  /** The button's sous verb, such as "Remove" or "Stop the run". */
  confirmLabel: string;
  /** Paints the button red, for a removal. */
  danger?: boolean;
  /**
   * The work itself. The dialog stays open and the button busy while it runs. A refusal shows
   * in the dialog, and the person can try again or cancel.
   */
  run?: () => Promise<unknown>;
};

const ask = createConfirm<ConfirmQuestion>();

/** Asks the question and resolves true once the person agrees and `run`, if any, succeeded. Cancel and Escape resolve false. */
export function confirm(question: ConfirmQuestion): Promise<boolean> {
  return ask(question);
}

/** Renders the open question. Mounted once, by Overlays. Questions wait their turn. */
export function ConfirmHost() {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog controller={ask.controller} pendingAnnouncement="Working">
      <AlertDialogBackdrop className={SCRIM} />
      <AlertDialogContent<ConfirmQuestion> className={BOX} initialFocus={() => cancel.current}>
        {(state) => {
          const q = state.payload;
          if (!q) return null;
          return (
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
              <AlertDialogTitle className="text-[15px] font-medium">{q.title}</AlertDialogTitle>
              <AlertDialogDescription render={<div />}>{q.body}</AlertDialogDescription>
              {q.path && <code className="block rounded-md bg-hover px-2 py-1 leading-[18px] [overflow-wrap:anywhere]">{q.path}</code>}
              <AlertDialogClose
                value="confirm"
                {...(q.run ? { action: q.run } : {})}
                render={(props, close) => (
                  <div className="flex flex-col gap-3">
                    {close.error !== undefined && close.error !== null && <Refusal error={close.error} />}
                    <div className="mt-1 flex flex-wrap justify-end gap-2">
                      <AlertDialogClose render={<Button ref={cancel}>Cancel</Button>} />
                      <Button {...props} variant={q.danger ? "danger" : "primary"} busy={close.pending}>
                        {q.confirmLabel}
                      </Button>
                    </div>
                  </div>
                )}
              />
            </div>
          );
        }}
      </AlertDialogContent>
    </AlertDialog>
  );
}

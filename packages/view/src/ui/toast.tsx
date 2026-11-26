// Toasts: a short line at the bottom that says what a press did, with its sous command and an Undo.
import { toast as sdkToast, Toast, ToastAction, ToastDescription, ToastRegion, ToastTitle } from "@ui-sdk/react/toast";

/** A toast lasts 5 seconds, or 8 with an Undo, while the pointer or focus is not on it. */
const TOAST_MS = 5000;
const UNDO_MS = 8000;

export type ToastOptions = {
  /** A toast with the same id replaces the one showing. The message is the id unless this names another. */
  id?: string;
  /** The sous command that does the same in the terminal, shown in mono, such as "sous stop r-2c8f1d". */
  command?: string;
  /** Adds an Undo button that runs this, and keeps the toast for 8 seconds. */
  undo?: () => unknown;
};

/**
 * Says what a press did, in the button's own verb: "Stopped r-2c8f1d", "Answer sent", "Removed".
 * Call it from anywhere. The same message again replaces the one showing, unless `id` tells them
 * apart, as a toast with an Undo must. Returns the toast's id.
 */
export function toast(message: string, { id = message, command, undo }: ToastOptions = {}): string {
  return sdkToast({
    id,
    title: message,
    ...(command ? { description: command } : {}),
    ...(undo ? { action: { label: "Undo", onAction: () => undo() } } : {}),
    duration: undo ? UNDO_MS : TOAST_MS,
  });
}

/** Where toasts show: centered at the bottom, in ink. Mounted once, by Overlays. F6 moves focus into it. */
export function Toasts() {
  return (
    <ToastRegion side="bottom" align="center" maxVisible={3} expanded>
      {() => (
        <Toast className="flex min-h-10 max-w-[calc(100vw-32px)] items-center gap-3 rounded-lg bg-ink py-1.5 pr-3.5 pl-3.5 text-on-ink has-[button]:pr-1.5">
          <ToastTitle className="flex-none" />
          <ToastDescription className="min-w-0 truncate font-mono text-xs opacity-80" />
          <ToastAction className="h-7 flex-none rounded-md bg-on-ink/16 px-2.5 font-medium hover:bg-on-ink/24 focus-visible:outline-on-ink max-[699px]:h-10" />
        </Toast>
      )}
    </ToastRegion>
  );
}

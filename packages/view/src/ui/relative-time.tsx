// A time in words, such as "3m ago", with the full date and time in a tooltip.
import { useSyncExternalStore } from "react";
import { formatAgo, formatFull } from "../format.ts";
import { Tip } from "./tooltip.tsx";

// One timer for every time on the page. The snapshot moves in 15 second steps, so a render
// between two steps reads the same value.
const STEP = 15_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => listeners.forEach((l) => l()), STEP);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const snapshot = () => Math.floor(Date.now() / STEP) * STEP;

/**
 * `at` is an ISO string, a Date or a number. `now` fixes the clock, for tests and for times that
 * must agree. The time sits in a button, so the keyboard reaches the full date too. Inside a link,
 * such as a run row, show `formatAgo` as plain text instead.
 */
export function RelativeTime({ at, now }: { at: string | number | Date; now?: number }) {
  const tick = useSyncExternalStore(subscribe, snapshot, snapshot);
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <Tip text={formatFull(date)}>
      <button type="button" className="cursor-default rounded-sm whitespace-nowrap tabular-nums">
        <time dateTime={date.toISOString()}>{formatAgo(date, now ?? tick)}</time>
      </button>
    </Tip>
  );
}

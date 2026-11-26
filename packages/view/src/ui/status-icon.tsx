// The status icons of DESIGN.md: line icons, 14px, a 1.5px stroke. Only "needs you" is filled.
// The same icon shows in the list row, the run header, the step row and the graph node, and each
// status reads by its shape alone. A status that changes while it shows draws its new shape.
import { useChanged } from "./motion.ts";

export type Status = "queued" | "running" | "done" | "paused" | "stopped" | "skipped" | "failed" | "needs";

export const STATUS_LABEL: Record<Status, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  paused: "Paused",
  stopped: "Stopped",
  skipped: "Skipped",
  failed: "Failed",
  needs: "Needs you",
};

type Props = {
  status: Status;
  /** The accessible name. Defaults to the status's label. Pass false when text beside it says the same. */
  label?: string | false;
  /** 14 by default, 12 in dense rows. */
  size?: 12 | 14;
  className?: string;
};

export function StatusIcon({ status, label, size = 14, className = "" }: Props) {
  const a11y = label === false ? { "aria-hidden": true } : { role: "img", "aria-label": label ?? STATUS_LABEL[status] };
  const gray = "var(--icon-muted)";
  const changed = useChanged(status);
  // A new element for each status, so its shape draws from the start.
  return (
    <svg
      key={status}
      {...a11y}
      data-status={status}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`block flex-none ${status === "running" ? "spin" : ""} ${changed ? "status-in" : ""} ${className}`}
    >
      {status === "done" && <path d="m2.9 7.3 2.7 2.7 5.5-5.9" stroke={gray} pathLength={1} />}
      {status === "running" && (
        <>
          <circle cx="7" cy="7" r="5.25" stroke="var(--run)" strokeOpacity={0.28} />
          <path d="M7 1.75A5.25 5.25 0 0 1 12.25 7" stroke="var(--run)" />
        </>
      )}
      {status === "failed" && <path d="m3.6 3.6 6.8 6.8M10.4 3.6l-6.8 6.8" stroke="var(--fail)" strokeWidth={1.7} pathLength={1} />}
      {status === "needs" && <circle cx="7" cy="7" r="4.6" fill="var(--needs)" />}
      {status === "paused" && <path d="M5.1 3.6v6.8M8.9 3.6v6.8" stroke={gray} pathLength={1} />}
      {status === "stopped" && <rect x="3.75" y="3.75" width="6.5" height="6.5" rx="1.2" stroke={gray} pathLength={1} />}
      {status === "skipped" && <path d="M3.5 7h7" stroke={gray} pathLength={1} />}
      {status === "queued" && <circle cx="7" cy="7" r="3.6" stroke={gray} pathLength={1} />}
    </svg>
  );
}

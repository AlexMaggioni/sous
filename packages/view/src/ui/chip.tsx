// The status of a run or a step, and where a run came from, each as an icon and a word.
import { AppWindow, Bot, CalendarClock, ListChecks, RotateCcw, SquareTerminal, type LucideIcon } from "lucide-react";
import type { RunOrigin } from "../api/contract.ts";
import { STATUS_LABEL, StatusIcon, type Status } from "./status-icon.tsx";

/** The status icon and its label, or sous's own words such as "Paused, budget". Only "needs you" reads in full text color. */
export function StatusChip({ status, text }: { status: Status; text?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted data-[status=needs]:text-fg" data-status={status}>
      <StatusIcon status={status} label={false} />
      {text ?? STATUS_LABEL[status]}
    </span>
  );
}

const ORIGIN: Record<RunOrigin, { icon: LucideIcon; label: string }> = {
  cli: { icon: SquareTerminal, label: "Terminal" },
  view: { icon: AppWindow, label: "This page" },
  schedule: { icon: CalendarClock, label: "Schedule" },
  rerun: { icon: RotateCcw, label: "Rerun" },
  agent: { icon: Bot, label: "Agent" },
  check: { icon: ListChecks, label: "Check" },
};

/** Who or what started a run: the terminal, this page, its schedule, a rerun, an agent, or sous check. */
export function OriginChip({ origin }: { origin: RunOrigin }) {
  const { icon: Icon, label } = ORIGIN[origin];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted">
      <Icon size={14} strokeWidth={1.5} aria-hidden="true" className="flex-none text-icon" />
      {label}
    </span>
  );
}

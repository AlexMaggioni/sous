import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { RunRow } from "../api/contract.ts";
import { formatFull, shortAge } from "../format.ts";
import { IconButton } from "../ui/button.tsx";
import { useWash } from "../ui/motion.ts";
import { StatusIcon } from "../ui/status-icon.tsx";
import { Tip } from "../ui/tooltip.tsx";
import { hasEnded, needsPerson, runMeta } from "./run-groups.ts";

// The rows of the list column, as DESIGN.md draws them: 28px, 40px under 700px, a hover fill,
// and the selected row filled a little more. A long name fades at its right edge and its tooltip
// holds all of it. Tooltips open to the right, so they never cover the rows next to them.

const rowClass = (selected: boolean) =>
  `group flex h-7 items-center rounded-md transition-colors max-[699px]:h-10 ${selected ? "bg-selected" : "hover:bg-hover focus-within:bg-hover"}`;
const LINK = "flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-fg no-underline focus-visible:outline-offset-[-2px]";
/** The age and the x show on hover and on focus, and always under 700px, where there is no hover. */
const ON_HOVER = "hidden flex-none group-hover:flex group-focus-within:flex max-[699px]:flex";

/**
 * One run: its status icon, its title, and the workflow muted after it. The project follows when
 * the list mixes projects. A run that ended has an x that removes it.
 */
export function RunLine({ run, index, selected, withProject, now, onRemove }: { run: RunRow; index: number; selected: boolean; withProject: boolean; now: number; onRemove: () => void }) {
  const meta = runMeta(run, { withProject });
  const status = needsPerson(run) ? "needs" : run.status;
  const wash = useWash(status);
  return (
    <div className={`${rowClass(selected)} ${wash}`}>
      <Tip side="right" text={`${run.title}${run.workflow === run.title ? "" : `, ${run.workflow}`} in ${run.project.name}. Started ${formatFull(Date.parse(run.startedAt))}.`}>
        <Link to="/runs/$runId" params={{ runId: run.id }} activeOptions={{ includeSearch: false }} data-row={index} className={`${LINK} pr-1.5`}>
          <StatusIcon status={status} label={run.statusText} />
          <span className="fade-end min-w-0 flex-1">
            {run.title}
            {meta && <span className="ml-1 text-muted"> {meta}</span>}
          </span>
          <time dateTime={run.startedAt} className={`${ON_HOVER} text-xs text-muted tabular-nums`}>
            <span className="sr-only">started </span>
            {shortAge(run.startedAt, now)}
          </time>
        </Link>
      </Tip>
      {hasEnded(run) && (
        <span className={`${ON_HOVER} pr-0.5`}>
          <IconButton icon={X} label={`Remove ${run.title}`} size="sm" onClick={onRemove} />
        </span>
      )}
    </div>
  );
}

type NamedPath = "/workflows/$name" | "/agents/$name" | "/skills/$name" | "/mcp/$name";

/** A workflow, agent, skill or MCP server: the name, and a muted mark at the right when something is off. */
export function NameRow({ to, name, index, selected, tip, mark }: { to: NamedPath; name: string; index: number; selected: boolean; tip?: string; mark?: ReactNode }) {
  const link = (
    <Link to={to} params={{ name }} data-row={index} className={LINK}>
      <span className="fade-end min-w-0 flex-1">{name}</span>
      {mark && <span className="flex flex-none items-center gap-1.5 text-xs text-muted">{mark}</span>}
    </Link>
  );
  return <div className={rowClass(selected)}>{tip ? (
        <Tip side="right" text={tip}>
          {link}
        </Tip>
      ) : (
        link
      )}</div>;
}

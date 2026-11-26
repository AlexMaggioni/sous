// A step's activity, one line per event with its time and kind, as the mock's feed. Five or more
// tool calls in a row fold into one line, and a long feed shows its last 50 lines first. A line
// that arrives while the feed shows rises in. The lines there when it opened don't move.
import { useState } from "react";
import type { Activity } from "../../api/contract.ts";
import { clock, plural } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { Fold } from "../../ui/fold.tsx";
import { StatusIcon } from "../../ui/status-icon.tsx";
import { foldActivity, type ActivityItem } from "./activity-fold.ts";

/** Lines past this many wait behind "Show N earlier lines". */
const LIMIT = 50;

const KIND: Record<Activity["kind"], string> = {
  prompt: "prompt",
  text: "says",
  tool: "tool",
  "tool-result": "result",
  command: "command",
  output: "output",
  error: "error",
  note: "note",
};

/** The class of what arrived after the feed opened. */
const ARRIVED = "animate-arrive";

function Line({ line, since }: { line: Activity; since: number }) {
  const tone = line.kind === "error" ? "text-fail" : line.kind === "text" || line.kind === "note" ? "text-fg" : "text-muted";
  return (
    <div className={`grid grid-cols-[64px_56px_minmax(0,1fr)] gap-2 py-0.5 max-[699px]:grid-cols-[56px_minmax(0,1fr)] ${tone} ${line.seq > since ? ARRIVED : ""}`}>
      <time dateTime={line.at} className="font-mono text-xs leading-5 text-muted tabular-nums max-[699px]:hidden">
        {clock(line.at)}
      </time>
      <span className="text-xs leading-5 text-muted">{KIND[line.kind]}</span>
      {line.kind === "tool" ? (
        <span className="min-w-0 leading-5 [overflow-wrap:anywhere]">
          <span className="font-mono text-xs font-medium text-fg">{line.tool ?? "tool"}</span> <code className="font-mono text-xs">{line.text}</code>
        </span>
      ) : (
        <span className={`min-w-0 leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] ${line.kind === "text" || line.kind === "note" || line.kind === "error" ? "" : "font-mono text-xs"}`}>{line.text}</span>
      )}
    </div>
  );
}

function Item({ item, since }: { item: ActivityItem; since: number }) {
  if (item.t === "line") return <Line line={item.line} since={since} />;
  return (
    <div className={`py-0.5 ${item.lines[0]!.seq > since ? ARRIVED : ""}`}>
      <Fold title={<span className="text-xs font-normal text-muted">{item.summary}</span>}>
        <div className="pl-5">
          {item.lines.map((line) => (
            <Line key={line.seq} line={line} since={since} />
          ))}
        </div>
      </Fold>
    </div>
  );
}

/**
 * The feed of one step call, oldest first. `live` keeps the last run of tool calls open and ends
 * the feed with "Working". `empty` says why there is nothing yet.
 */
export function ActivityList({ activity, live, empty = "No activity." }: { activity: readonly Activity[]; live: boolean; empty?: string }) {
  const [all, setAll] = useState(false);
  // The last line there when the feed opened. Key the feed by its call, so another call starts again.
  const [since] = useState(() => activity.reduce((max, line) => Math.max(max, line.seq), -Infinity));
  const items = foldActivity(activity, live);
  const hidden = all ? 0 : Math.max(0, items.length - LIMIT);
  if (items.length === 0 && !live) return <p className="text-xs text-muted">{empty}</p>;
  return (
    <div className="max-w-[900px]">
      {hidden > 0 && (
        <Button variant="quiet" size="sm" className="mb-1" onClick={() => setAll(true)}>
          Show {plural(hidden, "earlier line")}
        </Button>
      )}
      {items.slice(hidden).map((item) => (
        <Item key={item.t === "line" ? item.line.seq : `tools-${item.lines[0]!.seq}`} item={item} since={since} />
      ))}
      {items.length === 0 && <p className="text-xs text-muted">{empty}</p>}
      {live && (
        <div className="flex items-center gap-2 py-1 text-xs text-muted">
          <StatusIcon status="running" label={false} size={12} />
          Working
        </div>
      )}
    </div>
  );
}

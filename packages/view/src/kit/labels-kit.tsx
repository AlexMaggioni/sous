// The kit's labels: status and origin, times, facts, paths, commands and copy buttons.
import { useState } from "react";
import type { RunOrigin } from "../api/contract.ts";
import { formatDate } from "../format.ts";
import { StatusChip, OriginChip } from "../ui/chip.tsx";
import { CommandBox, CopyButton } from "../ui/copy.tsx";
import { Facts, Path } from "../ui/facts.tsx";
import { RelativeTime } from "../ui/relative-time.tsx";
import { STATUS_LABEL, type Status } from "../ui/status-icon.tsx";
import { WORKFLOW_PATH } from "./kit-data.ts";
import { KitGroup } from "./kit-section.tsx";

const ORIGINS: RunOrigin[] = ["cli", "view", "schedule", "rerun", "agent", "check"];

export function LabelsKit() {
  const [now] = useState(() => Date.now());
  return (
    <>
      <KitGroup title="Status and origin" note="An icon and a word. Color only for running, failed and needs you.">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
              <StatusChip key={s} status={s} />
            ))}
            <StatusChip status="paused" text="Paused, budget" />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {ORIGINS.map((o) => (
              <OriginChip key={o} origin={o} />
            ))}
          </div>
        </div>
      </KitGroup>

      <KitGroup title="Times" note="Relative under a day, the date past it. Hover or focus shows the full date and time.">
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <RelativeTime at={now - 20_000} />
          <RelativeTime at={now - 3 * 60_000} />
          <RelativeTime at={new Date(now - 5 * 3_600_000).toISOString()} />
          <RelativeTime at={now - 2 * 86_400_000} />
          <RelativeTime at={now + 4 * 60_000} />
          <span className="text-muted">A date alone: {formatDate(now - 2 * 86_400_000)}</span>
        </div>
      </KitGroup>

      <KitGroup title="Facts" note="A 12px muted label above a 13px value, stacked in the details column or side by side in the run header.">
        <div className="grid gap-8 min-[900px]:grid-cols-[240px_minmax(0,1fr)]">
          <Facts
            items={[
              { label: "Lives in", value: "billing" },
              { label: "Started by", value: "People only", sub: "and its schedule" },
              { label: "Approved", value: <RelativeTime at={now - 26 * 3_600_000} />, sub: "by maya" },
              { label: "File", value: <Path path={WORKFLOW_PATH} /> },
            ]}
          />
          <Facts
            layout="row"
            items={[
              { label: "Project", value: "billing" },
              { label: "Started", value: <RelativeTime at={now - 4 * 60_000} /> },
              { label: "Duration", value: "4m 08s" },
              { label: "Tokens", value: "12.4k" },
              { label: "Cost", value: "$0.42" },
            ]}
          />
        </div>
      </KitGroup>

      <KitGroup title="Commands and copy" note="A command in mono on a gray fill, wrapping at spaces. Copy says so in a toast.">
        <div className="flex max-w-[560px] flex-col items-start gap-2">
          <CommandBox command="sous run ticket --ticket BILL-142" />
          <CommandBox command={`sous resume r-8d2v7f --note "Use the fixtures in test/invoices" --step reviewer --budget 400000`} />
          <span className="inline-flex items-center gap-1">
            <code className="font-mono text-xs">r-2c8f1d</code>
            <CopyButton text="r-2c8f1d" label="Copy the run id" />
          </span>
        </div>
      </KitGroup>
    </>
  );
}

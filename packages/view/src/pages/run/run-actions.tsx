// The run's actions in the header: at most one primary, Stop while it runs, and the "More" menu.
// Each one sends the words of one sous command through useSend, and a refusal shows under the header.
import { useNavigate } from "@tanstack/react-router";
import { Copy, Pause, Play, RotateCcw, Square, SquareTerminal, Trash2 } from "lucide-react";
import { useState } from "react";
import type { RunPage } from "../../api/contract.ts";
import { useRemoveRun } from "../../api/queries.ts";
import { commandOf, type Send } from "../../api/send.ts";
import { Button } from "../../ui/button.tsx";
import { confirm } from "../../ui/confirm.tsx";
import { Dialog } from "../../ui/dialog.tsx";
import { Menu, MenuItem, MenuSeparator } from "../../ui/menu.tsx";
import { toast } from "../../ui/toast.tsx";
import { primaryAction, resumeFor, words } from "./run-words.ts";

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`, { command: text });
  } catch {
    toast("The browser blocked the copy. Select the text instead.");
  }
}

/** Asks which text a resume runs, when the workflow changed since the run started. */
function ResumeChoice({ run, open, onOpenChange, send }: { run: RunPage; open: boolean; onOpenChange: (open: boolean) => void; send: Send }) {
  const go = async (text: "same" | "latest") => {
    onOpenChange(false);
    await send(resumeFor(run, text), () => `Resumed ${run.id}`);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Resume with which text?"
      description={`The ${run.workflow} workflow changed since this run started. The steps that ran stay done either way.`}
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => go("latest")}>Resume with the latest</Button>
          <Button variant="primary" onClick={() => go("same")}>
            Resume as it started
          </Button>
        </>
      }
    />
  );
}

/**
 * Stop, Resume and the "More" menu. Resume is the primary when the run is paused or failed, unless
 * `primaryHere` says the open failed step holds the primary with its "Resume from here".
 */
export function RunActions({ run, send, primaryHere }: { run: RunPage; send: Send; primaryHere: boolean }) {
  const navigate = useNavigate();
  const remove = useRemoveRun();
  const [choosing, setChoosing] = useState(false);
  const primary = primaryHere ? null : primaryAction(run);
  const resume = () => (run.can.resumeChoice ? setChoosing(true) : send(resumeFor(run), () => `Resumed ${run.id}`));
  const stop = () => send(words.stop(run.id), (reply) => (reply.data.outcome === "stopping" ? `Stopping ${run.id}` : `Stopped ${run.id}`));
  const pause = () => send(words.pause(run.id), (reply) => (reply.data.pausing === false ? `${run.id} is not running` : `Pausing ${run.id}`));
  const rerun = async () => {
    const reply = await send(words.rerun(run.id), () => "Rerun started");
    const id = reply?.data.runId;
    if (typeof id === "string") void navigate({ to: "/runs/$runId", params: { runId: id } });
  };
  const removeRun = async () => {
    const yes = await confirm({
      title: `Remove ${run.id}?`,
      body: "The run leaves the list, and sous deletes its record. Its worktree and branch stay.",
      confirmLabel: "Remove",
      danger: true,
      run: () => remove.mutateAsync(run.id),
    });
    if (!yes) return;
    toast(`Removed ${run.id}`);
    void navigate({ to: "/runs" });
  };
  const show = commandOf(["show", run.id]);
  // As tall as a button with or without Stop and Resume, so the header keeps its height when the run ends.
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2">
      {run.can.stop && (
        <Button variant="quiet" icon={Square} onClick={stop}>
          Stop
        </Button>
      )}
      {run.can.resume && (
        <Button variant={primary === "resume" ? "primary" : "secondary"} icon={Play} onClick={resume}>
          Resume
        </Button>
      )}
      <Menu label="More">
        {run.can.pause && (
          <MenuItem icon={Pause} onSelect={pause}>
            Pause
          </MenuItem>
        )}
        <MenuItem icon={RotateCcw} disabled={run.can.rerun ? false : "This run can't run again."} onSelect={rerun}>
          Rerun
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Copy} onSelect={() => copy(run.id, "the run id")}>
          Copy the run id
        </MenuItem>
        <MenuItem icon={SquareTerminal} onSelect={() => copy(show, "the command")}>
          Copy <code className="font-mono text-xs">{show}</code>
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} danger disabled={run.can.remove ? false : "Stop the run first, then remove it."} onSelect={removeRun}>
          Remove
        </MenuItem>
      </Menu>
      {run.can.resumeChoice && <ResumeChoice run={run} open={choosing} onOpenChange={setChoosing} send={send} />}
    </div>
  );
}

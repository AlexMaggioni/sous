// The notes under the run header: a failed step with its error, and why the run paused, each with
// the command that goes on, as the mock's notes.
import type { ReactNode } from "react";
import type { RunPage } from "../../api/contract.ts";
import { commandOf } from "../../api/send.ts";
import { formatTokens } from "../../format.ts";
import { CommandBox } from "../../ui/copy.tsx";
import { useArrived } from "../../ui/motion.ts";
import { RelativeTime } from "../../ui/relative-time.tsx";
import { StatusIcon } from "../../ui/status-icon.tsx";
import { resumeFor } from "./run-words.ts";

/**
 * A note that comes while the run shows `arrived`, and rises in, so the views under it move down for a
 * reason. It waits 80ms for them, so they never pass over it.
 */
function Note({ status, children, command, arrived }: { status: "failed" | "paused"; children: ReactNode; command?: string; arrived: boolean }) {
  return (
    <div className={`mt-4 flex items-start gap-2 ${arrived ? "animate-arrive-late" : ""}`}>
      <span className="flex h-5 flex-none items-center">
        <StatusIcon status={status} label={false} />
      </span>
      <div className="max-w-[36em] min-w-0 flex-1">
        {children}
        {command && (
          <div className="mt-1.5">
            <CommandBox command={command} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Why a run paused, in a sentence that says what goes on from here. Unset for a failed step, which has its own note. */
function pauseText(run: RunPage): ReactNode {
  switch (run.pauseReason) {
    case "budget":
      return run.budget ? `Paused at its budget of ${formatTokens(run.budget)} tokens. Resume with a larger budget.` : "Paused at its token budget. Resume with a larger budget.";
    case "time_limit":
      return "Paused when the workflow's time limit ran out. Resume starts the stopped step again.";
    case "usage_limit":
      return run.resumesAt ? (
        <>
          Paused at the account's usage limit. sous resumes it <RelativeTime at={run.resumesAt} />, when the limit resets. To go on sooner, switch the account, then resume.
        </>
      ) : (
        "Paused at the account's usage limit. Resume once the limit resets, or switch the account first."
      );
    case "login":
      return "Paused because the harness is not logged in. Log in, then resume.";
    case "step_stopped":
      return "Paused on a step that was stopped. Resume runs it again.";
    case "interrupted":
      return "The worker stopped before the run ended, as when the machine sleeps. Resume goes on from the last step that finished.";
    case "requested":
      return "Paused, as asked. Resume goes on from where it stopped.";
    case "step_failed":
      return run.failure ? null : "Paused on a failed step. Resume runs it again.";
    default:
      return run.status === "paused" ? `${run.statusText}.` : null;
  }
}

/** The failed step, with a link that opens it, and the pause, each with its command. */
export function Notices({ run, onOpenStep }: { run: RunPage; onOpenStep: (key: string) => void }) {
  const failed = run.failure;
  const step = failed?.step ? [...run.steps].reverse().find((s) => s.name === failed.step) : undefined;
  const resume = run.can.resume ? commandOf(resumeFor(run)) : undefined;
  const paused = run.status === "paused" ? pauseText(run) : null;
  const failedIn = useArrived(run.id, !!failed);
  const pausedIn = useArrived(run.id, !!paused);
  return (
    <>
      {failed && (
        <Note status="failed" command={resume} arrived={failedIn}>
          <p>
            {step ? (
              <button type="button" onClick={() => onOpenStep(step.key)} className="rounded-sm font-mono text-xs underline decoration-1 underline-offset-2">
                {step.name}
              </button>
            ) : (
              "A step"
            )}{" "}
            failed.
          </p>
          <p className="mt-0.5 font-mono text-xs [overflow-wrap:anywhere] text-fail">{failed.message}</p>
        </Note>
      )}
      {paused && (
        <Note status="paused" command={failed ? undefined : resume} arrived={pausedIn}>
          <p>{paused}</p>
        </Note>
      )}
    </>
  );
}

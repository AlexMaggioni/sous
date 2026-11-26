// A refusal or a failure, as sous gives it: what happened, what to change, and the call to make instead.
import type { ReactNode } from "react";
import { SousError } from "../api/client.ts";
import type { ApiError } from "../api/contract.ts";
import { CommandBox } from "./copy.tsx";
import { StatusIcon } from "./status-icon.tsx";

/** Turns anything thrown into sous's three parts. A plain Error keeps its message. */
function toApiError(error: unknown): ApiError {
  if (error instanceof SousError) return { code: error.code, message: error.message, change: error.change, call: error.call, ...(error.next ? { next: error.next } : {}) };
  if (error && typeof error === "object" && "message" in error && "change" in error) {
    const e = error as Partial<ApiError>;
    return { code: e.code ?? "error", message: String(e.message), change: String(e.change ?? ""), call: e.call ?? null, ...(e.next ? { next: e.next } : {}) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "error", message, change: "Reload the page to try again.", call: null };
}

/**
 * Shows a refusal in place, where the press happened. `error` is what the request threw, or an
 * ApiError. `action` is a button that tries again, such as a Button labeled "Try again". A refusal
 * that offers more than one call lists each with what it does, in the order to try them.
 */
export function Refusal({ error, action }: { error: unknown; action?: ReactNode }) {
  const { message, change, call, next } = toApiError(error);
  return (
    <div role="alert" className="flex items-start gap-2.5">
      <span className="flex h-5 flex-none items-center">
        <StatusIcon status="failed" label={false} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg [overflow-wrap:anywhere]">{message}</p>
        {change && <p className="mt-0.5 max-w-[34em] text-muted">{change}</p>}
        {next && next.length > 1 ? (
          <>
            <ul className="mt-2 flex flex-col gap-1.5">
              {next.map((n) => (
                <li key={n.call} className="flex flex-wrap items-center gap-2">
                  <CommandBox command={n.call} label="Copy the call" />
                  <span className="text-muted">{n.does}</span>
                </li>
              ))}
            </ul>
            {action && <div className="mt-2">{action}</div>}
          </>
        ) : (
          (call || action) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {call && <CommandBox command={call} label="Copy the call" />}
              {action}
            </div>
          )
        )}
      </div>
    </div>
  );
}

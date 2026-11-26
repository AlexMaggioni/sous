import { useQueryClient } from "@tanstack/react-query";
import { Plug, PowerOff, Unplug, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLive, type Connection } from "../api/live.ts";
import { refreshAll } from "../api/queries.ts";
import { Button } from "../ui/button.tsx";
import { CommandBox } from "../ui/copy.tsx";
import { Refusal } from "../ui/refusal.tsx";
import { BACK_MS, nextLink, RETRY_MS, type LinkView } from "./link-state.ts";

// The one-line bars at the top of the page, and the page that stands in for everything when
// sous serve can't be read at all.

/** A quiet line across the top: a gray icon, what is wrong and what it changes, and what to do. */
function Bar({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div role="status" className="flex min-h-9 flex-none flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line-strong bg-raised px-4 py-1 max-[699px]:px-3 max-[699px]:text-xs">
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="flex-none text-icon" />
      {children}
    </div>
  );
}

/** Calls useLive and reports what it says. Mounted once, by LiveBar, and again for each retry. */
function LiveLink({ onChange }: { onChange: (connection: Connection) => void }) {
  const connection = useLive();
  useEffect(() => {
    onChange(connection);
  }, [connection, onChange]);
  return null;
}

/**
 * The page's one link to /api/live, and the bar that says when it is lost and when it is back.
 * `show` is false while a whole-page state stands in, which says it already. The link keeps
 * trying either way, so the page comes back on its own once sous serve answers.
 */
export function LiveBar({ show }: { show: boolean }) {
  const client = useQueryClient();
  const [view, setView] = useState<LinkView>("ok");
  const [attempt, setAttempt] = useState(0);
  // A new link starts with nothing missed, so it doesn't read everything again. The bar does it.
  const retried = useRef(false);
  const onChange = useCallback((connection: Connection) => setView((was) => nextLink(was, connection)), []);
  const retry = useCallback(() => {
    retried.current = true;
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (view !== "lost") return;
    const timer = setInterval(retry, RETRY_MS);
    return () => clearInterval(timer);
  }, [view, retry]);

  useEffect(() => {
    if (view !== "back") return;
    if (retried.current) refreshAll(client);
    retried.current = false;
    const timer = setTimeout(() => setView("ok"), BACK_MS);
    return () => clearTimeout(timer);
  }, [view, client]);

  return (
    <>
      <LiveLink key={attempt} onChange={onChange} />
      {show && view === "lost" && (
        <Bar icon={Unplug}>
          <span className="min-w-0 flex-[1_1_200px]">The page lost its link to sous serve and is trying again. What it shows may be out of date.</span>
          <Button variant="quiet" size="sm" onClick={retry}>
            Try now
          </Button>
        </Bar>
      )}
      {show && view === "back" && (
        <Bar icon={Plug}>
          <span className="min-w-0 flex-[1_1_200px]">Connected to sous serve again. The page shows the latest state.</span>
        </Bar>
      )}
    </>
  );
}

/**
 * The service is off: schedules don't start and runs paused at a usage limit don't resume. One
 * line that stays until the service is back. Under 700px it says only that the service is off.
 */
export function ServiceBar() {
  return (
    <Bar icon={PowerOff}>
      <span className="min-w-0 flex-[1_1_200px] max-[699px]:flex-[1_1_auto]">
        The sous service is off<span className="max-[699px]:hidden">, so schedules don't start and runs paused at a usage limit don't resume</span>.
      </span>
      <CommandBox command="sous daemon start" />
    </Bar>
  );
}

/**
 * Stands in for the whole page when the overview can't be read: sous serve doesn't answer, or it
 * refused the page. `refused` shows sous's own words for it.
 */
export function WholePageState({ refused, error, onRetry, busy }: { refused: boolean; error: unknown; onRetry: () => unknown; busy: boolean }) {
  const retry = (
    <Button onClick={onRetry} busy={busy}>
      Try again
    </Button>
  );
  return (
    <main id="main" className="flex h-full items-start justify-center overflow-auto bg-base px-4 pt-[18vh] pb-12">
      <div className="w-full max-w-[480px]">
        {refused ? (
          <>
            <h1 className="page-title mb-4">sous serve turned the page away</h1>
            <Refusal error={error} action={retry} />
          </>
        ) : (
          <>
            <h1 className="page-title">The page can't reach sous serve</h1>
            <p className="mt-2 text-md text-muted">sous serve stopped, or it runs at another address. Start it in a terminal and open the link it prints. The page tries again on its own every few seconds.</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <CommandBox command="sous serve" />
              {retry}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

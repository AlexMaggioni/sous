import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useOverview } from "../api/queries.ts";
import { StartDialog } from "../start/start-dialog.tsx";
import { JumpMenu } from "./jump-menu.tsx";
import { LiveBar, ServiceBar, WholePageState } from "./link-bar.tsx";
import { isRefused, isUnreachable, tabTitle } from "./link-state.ts";
import { ListColumn } from "./list-column.tsx";
import { FILTER_ID, focusSoon, moveInList } from "./list-nav.ts";
import { Rail } from "./rail.tsx";
import { ShortcutsDialog } from "./shortcuts-dialog.tsx";
import { useArrive, useDrawer } from "../ui/motion.ts";
import { SidebarContext, useSidebar } from "./use-sidebar.ts";
import { useKeys } from "./use-keys.ts";

/**
 * The three columns of DESIGN.md: the 52px rail, the 280px list column, and the center, at most
 * 1080px of content. Under 700px the rail becomes a top bar. A one-line bar above them says when
 * the link to sous serve is lost or the service is off.
 */
export function Shell() {
  const sidebar = useSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const overview = useOverview();
  const [jump, setJump] = useState<"never" | "open" | "closed">("never");
  const [help, setHelp] = useState(false);
  const { close } = sidebar;
  const needs = overview.data?.needsYou ?? 0;
  // The list column slides out from behind the rail and pushes the page, and back. Under 1100px it
  // slides over the page. It stays while it slides away.
  const column = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  const present = useDrawer(sidebar.open, !sidebar.overlay, column, main);
  const leaving = present && !sidebar.open;
  // A new page arrives once the router shows it, not while it loads.
  const page = useRef<HTMLDivElement>(null);
  const shownPath = useRouterState({ select: (s) => s.matches.at(-1)?.pathname ?? "" });
  useArrive(page, shownPath);

  // An open overlay closes once the person picks something in it.
  useEffect(() => {
    close();
  }, [pathname, close]);

  useEffect(() => {
    document.title = tabTitle(needs);
  }, [needs]);

  useKeys((action) => {
    switch (action.type) {
      case "go":
        void navigate({ to: action.path });
        return true;
      case "move":
        return sidebar.open && moveInList(action.delta);
      case "filter":
        sidebar.show();
        focusSoon(FILTER_ID);
        return true;
      case "jump":
        setJump("open");
        return true;
      case "sidebar":
        sidebar.toggle();
        return true;
      case "help":
        setHelp(true);
        return true;
      case "close":
        if (!sidebar.overlay || !sidebar.open) return false;
        sidebar.close();
        document.getElementById("main")?.focus();
        return true;
    }
  });

  // The kit shows every state on its own, so it never gives way to the whole-page states.
  const wholePage = !overview.data && overview.isError && pathname !== "/kit" && (isUnreachable(overview.error) || isRefused(overview.error));

  return (
    <SidebarContext.Provider value={sidebar}>
      <div className="flex h-full flex-col">
        <LiveBar show={!wholePage} />
        {wholePage ? (
          <WholePageState refused={isRefused(overview.error)} error={overview.error} onRetry={() => overview.refetch()} busy={overview.isFetching} />
        ) : (
          <>
            {overview.data?.service.running === false && <ServiceBar />}
            {/* Clipped, so the page never shows a scrollbar while it moves with the list column. */}
            <div className="relative flex min-h-0 flex-1 flex-col overflow-clip min-[700px]:flex-row">
              <Rail pathname={pathname} needs={needs} />
              {present && (
                <>
                  {/* The scrim leaves the rail clear, so a tap on another section goes there in one go. */}
                  {sidebar.overlay && (
                    <div
                      className={`absolute inset-0 z-20 bg-scrim max-[699px]:top-12 min-[700px]:left-[var(--rail)] ${leaving ? "animate-fade-out" : "animate-fade-in"}`}
                      aria-hidden="true"
                      onClick={leaving ? undefined : sidebar.close}
                    />
                  )}
                  <ListColumn ref={column} pathname={pathname} overlay={sidebar.overlay} leaving={leaving} />
                </>
              )}
              <main ref={main} id="main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-auto focus:outline-none">
                <div ref={page}>
                  <Outlet />
                </div>
              </main>
            </div>
          </>
        )}
      </div>
      {jump !== "never" && <JumpMenu open={jump === "open"} onOpenChange={(open) => setJump(open ? "open" : "closed")} />}
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
      <StartDialog />
    </SidebarContext.Provider>
  );
}

import { SousError } from "../api/client.ts";
import type { Connection } from "../api/live.ts";

// The page's link to sous serve, as the bar at the top shows it, and the failures that replace the
// whole page. Pure, so the tests read them without a server.

/** ok shows nothing. lost shows the bar until the link comes back. back says so for 4 seconds. */
export type LinkView = "ok" | "lost" | "back";

/** How long "Connected to sous serve again" stays. */
export const BACK_MS = 4000;

/** While the link is lost, a new one every 5 seconds. A proxy's error answer closes an
 *  EventSource for good, so waiting on the browser alone may never reconnect. */
export const RETRY_MS = 5000;

export function nextLink(view: LinkView, connection: Connection): LinkView {
  if (connection === "lost") return "lost";
  if (connection === "open" && view === "lost") return "back";
  return view;
}

/** No answer at all, or an answer that is not sous's, such as a dev proxy's with no server behind it. */
export function isUnreachable(error: unknown): boolean {
  return error instanceof SousError && (error.status === 0 || (error.status >= 500 && error.code === "bad_answer"));
}

/** sous serve turned the page away, such as for a token from an earlier start. */
export function isRefused(error: unknown): boolean {
  return error instanceof SousError && (error.status === 401 || error.status === 403);
}

/** The browser tab's title: "(2) sous" while two runs need the person. */
export const tabTitle = (needs: number): string => (needs > 0 ? `(${needs}) sous` : "sous");

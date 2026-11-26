import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { LiveEvent } from "./contract.ts";
import { applyLive, refreshAll } from "./queries.ts";

// The page's link to the home: /api/live says what changed, and the page reads only that again.
// The browser reconnects on its own. When the link comes back, the page reads everything again,
// since it may have missed changes.

export type Connection = "connecting" | "open" | "lost";

/**
 * Grace before the page says the connection is lost, so a reconnect that works shows nothing. The
 * server asks the browser to wait 2000ms before it tries again (`retry: 2000` in the cli's
 * serve/server.ts), so the grace must be longer than that.
 */
export const LOST_AFTER_MS = 3500;

export function useLive(): Connection {
  const client = useQueryClient();
  const [state, setState] = useState<Connection>("connecting");

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/live");
    let lostTimer: ReturnType<typeof setTimeout> | undefined;
    // An error means the page may have missed changes, whether or not it showed "lost" yet.
    let hadError = false;
    source.onopen = () => {
      clearTimeout(lostTimer);
      lostTimer = undefined;
      setState("open");
      if (hadError) refreshAll(client);
      hadError = false;
    };
    source.onmessage = (message: MessageEvent<string>) => {
      try {
        applyLive(client, JSON.parse(message.data) as LiveEvent);
      } catch {
        // A line the page can't read changes nothing.
      }
    };
    source.onerror = () => {
      hadError = true;
      // The browser tries again on its own. The grace runs from the first error, not from each try.
      lostTimer ??= setTimeout(() => setState("lost"), LOST_AFTER_MS);
    };
    return () => {
      clearTimeout(lostTimer);
      source.close();
    };
  }, [client]);

  return state;
}

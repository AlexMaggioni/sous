import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource-variable/newsreader/opsz.css";
import "./styles/app.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { retryOnce } from "./api/client.ts";
import { router } from "./router.tsx";
import { applyTheme, readThemePref } from "./theme.ts";
import { Overlays } from "./ui/overlays.tsx";

applyTheme(readThemePref());

// The server pushes changes over one event stream, so queries don't refetch on focus or on a timer.
const queries = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: retryOnce } } });

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <RouterProvider router={router} />
      <Overlays />
    </QueryClientProvider>
  </StrictMode>,
);

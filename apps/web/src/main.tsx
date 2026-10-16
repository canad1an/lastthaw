import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router.js";

// Matomo: a page view per route change (the first view is sent from index.html).
router.subscribe("onResolved", ({ toLocation, fromLocation }) => {
  const paq = (window as unknown as { _paq?: unknown[][] })._paq;
  if (!paq || !fromLocation || toLocation.href === fromLocation.href) return;
  paq.push(["setReferrerUrl", location.origin + fromLocation.href]);
  paq.push(["setCustomUrl", location.origin + toLocation.href]);
  paq.push(["setDocumentTitle", document.title]);
  paq.push(["trackPageView"]);
});
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

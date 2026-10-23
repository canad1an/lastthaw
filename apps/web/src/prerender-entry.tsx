import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "./router.js";

/**
 * Build-time rendering of the public pages (scripts/prerender.ts). Each page is rendered once to plain HTML so a crawler
 * or a link preview gets the page's own words without running the app; in the browser the app then takes over the
 * same markup. Data the pages fetch is not available here, so lists render in their loading state: the text that
 * matters for search (the manual, the about page, the home page's copy) is static.
 */
export const PUBLIC_PAGES: ReadonlyArray<{ path: string; file: string; title: string; description: string }> = [
  { path: "/", file: "home.html", title: "Last Thaw: build before the ice does", description: "A free 30-day browser strategy game on a freezing Earth. Grow five settlers into an empire on a real map before the ice reaches you." },
  { path: "/matches", file: "matches.html", title: "Tournaments and games | Last Thaw", description: "Join the weekly Last Thaw tournament or a player-made game: thirty days on a freezing Earth, twenty tribes, one winner. Register, pick a capital, and build before the ice does." },
  { path: "/how-to-play", file: "how-to-play.html", title: "How to play | Last Thaw", description: "The Last Thaw field manual: pick a capital, set your workers, build and research, expand and fight, hold your land, trade and ally, and watch the ice. Ten minutes to learn, thirty days to win." },
  { path: "/about", file: "about.html", title: "About | Last Thaw", description: "What Last Thaw is, who makes it, and why a strategy game needs a real map and a month of real time." },
  { path: "/hall-of-fame", file: "hall-of-fame.html", title: "Hall of fame | Last Thaw", description: "Every finished Last Thaw match with its winner, and the champions ranked by tournament wins and titles: Survivor, Conqueror, Builder, Explorer." },
  { path: "/register", file: "register.html", title: "Play free | Last Thaw", description: "Create a free Last Thaw account: a 30-day strategy game on a real map of Earth, with weekly tournaments and games you can finish in an afternoon." },
  { path: "/login", file: "login.html", title: "Log in | Last Thaw", description: "Log in to Last Thaw to join a tournament, pick your capital and get back to your empire." },
];

/** The page at `path` as HTML for the root element. */
export async function render(path: string): Promise<string> {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return renderToString(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

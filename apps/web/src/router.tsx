import { createRootRoute, createRoute, createRouter, Outlet, type ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";
import { reportClientError } from "./errorReport.js";
import { TopBar } from "./components/TopBar.js";
import { ForgotPage, LoginPage, RegisterPage, ResetPage, VerifyPage } from "./routes/auth.js";
import { LobbyPage } from "./routes/lobby.js";
import { MatchLobbyPage, MatchPage } from "./routes/match.js";
import { LeaderboardPage } from "./routes/leaderboard.js";
import { ReportPage } from "./components/MatchSummary.js";
import { ReplayPage } from "./routes/replay.js";
import { ProfilePage } from "./routes/profile.js";
import { AdminPage } from "./routes/admin.js";
import { HomePage } from "./routes/home.js";
import { AboutPage } from "./routes/about.js";
import { HowToPlayPage } from "./routes/howToPlay.js";
import { HallOfFamePage } from "./routes/hallOfFame.js";

const rootRoute = createRootRoute({
  component: () => (
    <div className="min-h-dvh">
      <div className="backdrop" aria-hidden>
        <div className="backdrop-aurora" />
        <div className="backdrop-snow far" />
        <div className="backdrop-snow" />
      </div>
      <TopBar />
      <Outlet />
    </div>
  ),
});

const tokenSearch = (s: Record<string, unknown>) => ({ token: typeof s.token === "string" ? s.token : undefined });

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/matches", component: LobbyPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/about", component: AboutPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/how-to-play", component: HowToPlayPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/hall-of-fame", component: HallOfFamePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/register", component: RegisterPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/verify", component: VerifyPage, validateSearch: tokenSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/forgot", component: ForgotPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/reset", component: ResetPage, validateSearch: tokenSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/match/$matchId", component: MatchPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/match/$matchId/lobby", component: MatchLobbyPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/match/$matchId/leaderboard", component: LeaderboardPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/match/$matchId/report", component: ReportPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/match/$matchId/replay", component: ReplayPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/profile", component: ProfilePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: AdminPage }),
];

/** A page that crashed while rendering: say so, report it, and offer the way out. */
function CrashedPage({ error, reset }: ErrorComponentProps) {
  useEffect(() => reportClientError("render", error), [error]);
  return (
    <main className="mx-auto max-w-lg px-4 py-16 text-center">
      <h1 className="display text-2xl font-semibold text-white">Something went wrong on this page</h1>
      <p className="mt-3 text-slate-300">The fault has been reported and will be looked at. Your game is safe on the server.</p>
      <div className="mt-6 flex justify-center gap-3">
        <button className="btn-ember rounded-md px-4 py-2 text-sm font-semibold" onClick={() => reset()}>
          Try again
        </button>
        <a href="/" className="btn-ice rounded-md px-4 py-2 text-sm font-semibold">
          Home
        </a>
      </div>
    </main>
  );
}

export const routeTree = rootRoute.addChildren(routes);
export const router = createRouter({ routeTree, defaultErrorComponent: CrashedPage });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

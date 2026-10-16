import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { TopBar } from "./components/TopBar.js";
import { ForgotPage, LoginPage, RegisterPage, ResetPage, VerifyPage } from "./routes/auth.js";
import { LobbyPage } from "./routes/lobby.js";
import { MatchPage } from "./routes/match.js";
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
  createRoute({ getParentRoute: () => rootRoute, path: "/match/$matchId/leaderboard", component: LeaderboardPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/match/$matchId/report", component: ReportPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/match/$matchId/replay", component: ReplayPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/profile", component: ProfilePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: AdminPage }),
];

export const router = createRouter({ routeTree: rootRoute.addChildren(routes) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

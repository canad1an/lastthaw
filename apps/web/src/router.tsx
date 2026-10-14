import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { TopBar } from "./components/TopBar.js";
import { ForgotPage, LoginPage, RegisterPage, ResetPage, VerifyPage } from "./routes/auth.js";
import { LobbyPage } from "./routes/lobby.js";
import { MatchPage } from "./routes/match.js";

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
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: LobbyPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/register", component: RegisterPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/verify", component: VerifyPage, validateSearch: tokenSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/forgot", component: ForgotPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/reset", component: ResetPage, validateSearch: tokenSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/match/$matchId", component: MatchPage }),
];

export const router = createRouter({ routeTree: rootRoute.addChildren(routes) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

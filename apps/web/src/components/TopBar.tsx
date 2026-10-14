import { Link } from "@tanstack/react-router";
import { useLogout, useMe } from "../api/auth.js";
import { Button } from "./ui.js";

export function TopBar() {
  const me = useMe();
  const logout = useLogout();
  return (
    <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950/80 px-4 py-2 backdrop-blur">
      <Link to="/" className="text-lg font-semibold tracking-tight">
        Last Thaw
      </Link>
      <nav className="flex items-center gap-3 text-sm">
        {me.data ? (
          <>
            <span className="text-slate-400">
              {me.data.displayName}
              {!me.data.emailVerified && <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-300">unverified</span>}
            </span>
            <Button variant="ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Log out
            </Button>
          </>
        ) : (
          <>
            <Link to="/login" className="text-slate-300 hover:text-white">
              Log in
            </Link>
            <Link to="/register" className="rounded-md bg-sky-500 px-3 py-1.5 font-medium text-slate-950 hover:bg-sky-400">
              Sign up
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}

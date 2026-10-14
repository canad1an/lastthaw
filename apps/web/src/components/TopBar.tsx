import { Link } from "@tanstack/react-router";
import { useLogout, useMe } from "../api/auth.js";
import { Button } from "./ui.js";

export const TAGLINE = "Build before the ice does.";

/** Thin banner: icon, name and tagline over a slowly shifting aurora, with account links on the right. */
export function TopBar() {
  const me = useMe();
  const logout = useLogout();
  return (
    <header className="banner relative flex h-12 items-center justify-between overflow-hidden border-b border-sky-900/50 px-3">
      <div className="banner-aurora pointer-events-none absolute inset-0" />
      <div className="banner-frost pointer-events-none absolute inset-x-0 top-0 h-px" />
      <Link to="/" className="relative flex items-center gap-2.5">
        <img src="/favicon.svg" alt="" className="h-7 w-7 drop-shadow-[0_0_6px_rgba(125,211,252,0.45)]" />
        <span className="text-lg font-semibold tracking-tight text-white">Last Thaw</span>
        <span className="hidden text-sm italic text-sky-200/80 sm:inline">{TAGLINE}</span>
      </Link>
      <nav className="relative flex items-center gap-3 text-sm">
        <Link to="/matches" className="hidden text-slate-300 hover:text-white md:inline">
          Matches
        </Link>
        <Link to="/how-to-play" className="hidden text-slate-300 hover:text-white md:inline">
          How to play
        </Link>
        <Link to="/hall-of-fame" className="hidden text-slate-300 hover:text-white md:inline">
          Hall of fame
        </Link>
        <Link to="/about" className="hidden text-slate-300 hover:text-white md:inline">
          About
        </Link>
        <span className="hidden h-5 w-px bg-slate-700 md:inline-block" />
        {me.data ? (
          <>
            <Link to="/profile" className="text-slate-300 hover:text-white">
              {me.data.displayName}
              {!me.data.emailVerified && <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-300">unverified</span>}
            </Link>
            {me.data.isAdmin && (
              <Link to="/admin" className="text-xs text-slate-400 hover:text-white">
                admin
              </Link>
            )}
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

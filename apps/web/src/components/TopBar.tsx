import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useLogout, useMe } from "../api/auth.js";
import { Button } from "./ui.js";

export const TAGLINE = "Build before the ice does.";

const NAV = [
  { to: "/matches", label: "Matches" },
  { to: "/how-to-play", label: "How to play" },
  { to: "/hall-of-fame", label: "Hall of fame" },
  { to: "/about", label: "About" },
] as const;

/** Thin banner: icon, name and tagline over a slowly shifting aurora; nav links, with a hamburger menu on phones. */
export function TopBar() {
  const me = useMe();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="banner relative z-40 flex h-12 items-center justify-between overflow-visible border-b border-sky-900/50 px-3">
      <div className="banner-aurora pointer-events-none absolute inset-0 overflow-hidden" />
      <div className="banner-frost pointer-events-none absolute inset-x-0 top-0 h-px" />
      <Link to="/" className="relative flex items-center gap-2.5" onClick={() => setOpen(false)}>
        <img src="/favicon.svg" alt="" className="h-7 w-7 drop-shadow-[0_0_6px_rgba(125,211,252,0.45)]" />
        <span className="text-lg font-semibold tracking-tight text-white">Last Thaw</span>
        <span className="hidden text-sm italic text-sky-200/80 lg:inline">{TAGLINE}</span>
      </Link>

      {/* Desktop nav */}
      <nav className="relative hidden items-center gap-3 text-sm md:flex">
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className="text-slate-300 hover:text-white">
            {n.label}
          </Link>
        ))}
        <span className="h-5 w-px bg-slate-700" />
        <AccountLinks me={me.data ?? null} onLogout={() => logout.mutate()} loggingOut={logout.isPending} />
      </nav>

      {/* Phone: hamburger */}
      <button
        className="relative rounded p-2 text-slate-200 hover:bg-slate-800 md:hidden"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          {open ? (
            <>
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </>
          ) : (
            <>
              <path d="M4 7h16" />
              <path d="M4 12h16" />
              <path d="M4 17h16" />
            </>
          )}
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 top-12 z-30 bg-slate-950/60 md:hidden" onClick={() => setOpen(false)} />
          <nav className="absolute left-0 right-0 top-full z-40 border-b border-slate-800 bg-slate-950 p-3 shadow-2xl md:hidden" onClick={() => setOpen(false)}>
            <p className="mb-2 px-2 text-xs italic text-sky-200/80">{TAGLINE}</p>
            <ul className="space-y-1">
              {NAV.map((n) => (
                <li key={n.to}>
                  <Link to={n.to} className="block rounded px-2 py-2 text-slate-200 hover:bg-slate-800">
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-center gap-3 border-t border-slate-800 px-2 pt-3 text-sm">
              <AccountLinks me={me.data ?? null} onLogout={() => logout.mutate()} loggingOut={logout.isPending} />
            </div>
          </nav>
        </>
      )}
    </header>
  );
}

function AccountLinks({ me, onLogout, loggingOut }: { me: { displayName: string; emailVerified: boolean; isAdmin: boolean } | null; onLogout: () => void; loggingOut: boolean }) {
  if (!me) {
    return (
      <>
        <Link to="/login" className="text-slate-300 hover:text-white">
          Log in
        </Link>
        <Link to="/register" className="rounded-md bg-sky-500 px-3 py-1.5 font-medium text-slate-950 hover:bg-sky-400">
          Sign up
        </Link>
      </>
    );
  }
  return (
    <>
      <Link to="/profile" className="text-slate-300 hover:text-white">
        {me.displayName}
        {!me.emailVerified && <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-300">unverified</span>}
      </Link>
      {me.isAdmin && (
        <Link to="/admin" className="text-xs text-slate-400 hover:text-white">
          admin
        </Link>
      )}
      <Button variant="ghost" onClick={onLogout} disabled={loggingOut}>
        Log out
      </Button>
    </>
  );
}

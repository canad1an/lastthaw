import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLogout, useMe } from "../api/auth.js";
import { api, keys } from "../api/client.js";
import { Button } from "./ui.js";
import { SOCIAL_LINKS, SocialIcons } from "./social.js";

export const TAGLINE = "Build before the ice does.";

const NAV = [
  { to: "/matches", label: "Matches" },
  { to: "/how-to-play", label: "How to play" },
  { to: "/hall-of-fame", label: "Hall of fame" },
  { to: "/about", label: "About" },
] as const;


/**
 * The matches you are in, always one click away: a waiting room you have joined
 * (amber) or a match in progress (green), at the top of every page.
 */
function CurrentMatches({ onPick, compact }: { onPick: () => void; compact?: boolean }) {
  const me = useMe();
  const q = useQuery({ queryKey: keys.matches, queryFn: () => api.matches(), enabled: !!me.data, refetchInterval: 30_000 });
  const mine = (q.data ?? []).filter((m) => m.joined && m.status !== "finished").slice(0, compact ? 1 : 2);
  if (mine.length === 0) return null;
  return (
    <>
      {mine.map((m) => (
        <Link
          key={m.id}
          to={m.status === "lobby" ? "/match/$matchId/lobby" : "/match/$matchId"}
          params={{ matchId: m.slug || m.id }}
          onClick={onPick}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold ${compact ? "max-w-[9rem] truncate" : ""} ${m.status === "lobby" ? "bg-amber-400/90 text-slate-950 hover:bg-amber-300" : "bg-emerald-400/90 text-slate-950 hover:bg-emerald-300"}`}
          title={m.status === "lobby" ? "Back to the waiting room" : "Back to the match"}
        >
          {m.status === "lobby" ? "Lobby" : "Play"} · {m.name}
        </Link>
      ))}
    </>
  );
}

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
    <header className="banner sticky top-0 z-40 flex h-12 items-center justify-between overflow-visible border-b border-sky-900/40 px-3">
      <div className="banner-frost pointer-events-none absolute inset-x-0 top-0 h-px" />
      <Link to="/" className="relative flex items-center gap-2.5" onClick={() => setOpen(false)}>
        <img src="/favicon.svg" alt="" className="h-7 w-7 drop-shadow-[0_0_6px_rgba(125,211,252,0.45)]" />
        <span className="display text-lg font-semibold text-white">Last Thaw</span>
        <span className="hidden text-sm italic text-sky-200/80 lg:inline">{TAGLINE}</span>
      </Link>

      {/* Desktop nav */}
      <nav className="relative hidden items-center gap-3 text-sm md:flex">
        <CurrentMatches onPick={() => setOpen(false)} />
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className="text-slate-300 hover:text-white">
            {n.label}
          </Link>
        ))}
        <SocialIcons />
        <span className="h-5 w-px bg-slate-700" />
        <AccountLinks me={me.data ?? null} onLogout={() => logout.mutate()} loggingOut={logout.isPending} />
      </nav>

      {/* Phone: the match you are in stays in the bar itself, then the hamburger. */}
      <span className="relative ml-auto mr-1 flex min-w-0 items-center md:hidden">
        <CurrentMatches onPick={() => setOpen(false)} compact />
      </span>
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
          <div className="fixed inset-0 top-12 z-30 bg-slate-950/70 md:hidden" onClick={() => setOpen(false)} />
          <nav className="absolute left-0 right-0 top-full z-40 border-b border-slate-800 bg-slate-950/95 p-3 shadow-2xl backdrop-blur md:hidden" onClick={() => setOpen(false)}>
            <p className="mb-2 px-2 text-xs italic text-sky-200/80">{TAGLINE}</p>
            <ul className="space-y-1">
              <CurrentMatches onPick={() => setOpen(false)} />
        {NAV.map((n) => (
                <li key={n.to}>
                  <Link to={n.to} className="block rounded px-2 py-2 text-slate-200 hover:bg-slate-800">
                    {n.label}
                  </Link>
                </li>
              ))}
              {SOCIAL_LINKS.map((s) => (
                <li key={s.name}>
                  <a href={s.href} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded px-2 py-2 text-slate-200 hover:bg-slate-800">
                    {s.icon} {s.name}
                  </a>
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
        <Link to="/register" className="btn-ember rounded-md px-3 py-1.5 font-semibold">
          Play free
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

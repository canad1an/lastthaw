import { APP_VERSION } from "../version.js";
import { useQuery } from "@tanstack/react-query";
import { usePageMeta } from "../seo.js";
import { Link } from "@tanstack/react-router";
import { AGES, balance, formatCountdown } from "@lastthaw/shared";
import { useMe } from "../api/auth.js";
import { api, keys } from "../api/client.js";
import { HeroMap } from "../components/HeroMap.js";
import { SignupForm } from "../components/SignupForm.js";
import { fmt } from "../components/ui.js";
import { useNow } from "../hooks/useNow.js";
import { SocialIcons } from "../components/social.js";

export interface PublicMatch {
  id: string;
  slug?: string;
  name: string;
  status: "lobby" | "running" | "finished";
  speed: number;
  startsAt: string;
  endsAt: string;
  day: number;
  iceLatitude: number;
  humans: number;
  ai: number;
  claimedRegions: number;
  totalRegions: number;
  top: Array<{ name: string; score: number; isAi: boolean }>;
}

export function usePublicMatches() {
  return useQuery({ queryKey: ["public", "matches"], queryFn: () => fetch("/api/public/matches").then((r) => r.json() as Promise<PublicMatch[]>), refetchInterval: 30_000 });
}

const ICE_WEEKS = [
  { day: 1, title: "The thaw", body: "Five families, a fire, and all the world still green. Pick a capital, set your workers, build Huts before night.", lat: 72 },
  { day: 7, title: "First frost", body: "Scandinavia, Canada and Siberia go white. Bronze working opens; the first raids land on anyone who left stock in the open.", lat: 62 },
  { day: 14, title: "The squeeze", body: "The line crosses Britain and the northern US. Empires start marching south through land someone else already owns.", lat: 52 },
  { day: 21, title: "The crush", body: "Half the map is ice. Capitals move. Alliances break. Caravans and trains race the frost with everything an empire owns.", lat: 42 },
  { day: 30, title: "The Last Thaw", body: "The ice stops at the tropics. Whoever is left with the most people in warm land, or holds 60% of what remains, has won.", lat: 28 },
] as const;

export function HomePage() {
  usePageMeta({ title: "Last Thaw", path: "/" });
  const me = useMe();
  const matches = usePublicMatches();
  const now = useNow(1000);
  const lobby = matches.data?.filter((m) => m.status === "lobby") ?? [];
  const running = matches.data?.filter((m) => m.status === "running") ?? [];
  const next = lobby[0];
  const playing = running.reduce((n, m) => n + m.humans, 0) + lobby.reduce((n, m) => n + m.humans, 0);

  return (
    <main>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 pb-16 pt-12 sm:pt-20 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:pb-24">
          <div>
            <p className="rise mb-4 inline-flex items-center gap-2 rounded-full border border-sky-400/30 bg-slate-950/60 px-3 py-1 text-xs font-medium uppercase tracking-[0.25em] text-sky-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              Free browser strategy · 30 real days
            </p>
            <h1 className="display rise rise-2 text-5xl font-bold leading-[1.02] sm:text-6xl lg:text-7xl">
              <span className="frost-text">The ice is coming.</span>
              <br />
              <span className="ember-text">Build an empire first.</span>
            </h1>
            <p className="shadow-copy rise rise-3 mt-6 max-w-xl text-lg leading-relaxed text-slate-200">
              Start with five families somewhere on the real Earth. Gather, build, research and raid your way through the ages while a
              glacier swallows the map from both poles. A hundred rivals. One winner. Hard end date.
            </p>
            <div className="rise rise-4 mt-8 flex flex-wrap items-center gap-3">
              {me.data ? (
                <Link to="/matches" className="btn-ember display rounded-md px-6 py-3 text-base font-semibold">
                  Find a match
                </Link>
              ) : (
                <a href="#signup" className="btn-ember display rounded-md px-6 py-3 text-base font-semibold">
                  Play free
                </a>
              )}
              <Link to="/how-to-play" className="btn-ice rounded-md px-5 py-3 text-sm font-medium">
                How it works
              </Link>
              {next && (
                <span className="shadow-copy text-sm text-slate-300">
                  Next match <span className="text-slate-100">{next.name}</span> opens in{" "}
                  <span className="tabular-nums text-amber-200">{formatCountdown((Date.parse(next.startsAt) - now) / 1000)}</span>
                </span>
              )}
            </div>
            <dl className="rise rise-4 mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat n="408" label="real regions" />
              <Stat n="30" label="days per match" />
              <Stat n={String(AGES.length)} label="ages to climb" />
              <Stat n={playing > 0 ? fmt(playing) : "20"} label={playing > 0 ? "players in the field" : "players per match"} />
            </dl>
          </div>

          <div id="signup" className="rise rise-3 glass glass-strong scroll-mt-20 rounded-2xl p-6 sm:p-7">
            {me.data ? (
              <>
                <h2 className="display text-2xl font-semibold text-white">Welcome back, {me.data.displayName}.</h2>
                <p className="mt-2 text-sm text-slate-300">The ice does not wait. Pick up your empire or join the next match before it starts.</p>
                <Link to="/matches" className="btn-ember display mt-5 block rounded-md px-5 py-3 text-center text-base font-semibold">
                  Go to your matches
                </Link>
              </>
            ) : (
              <>
                <h2 className="display text-2xl font-semibold text-white">Raise your tribe</h2>
                <p className="mb-5 mt-1 text-sm text-slate-400">Thirty seconds to sign up. A match opens every week.</p>
                <SignupForm compact />
              </>
            )}
          </div>
        </div>
      </section>

      {/* Live map */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="glass overflow-hidden rounded-2xl">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-700/50 px-5 py-4">
            <div>
              <h2 className="display text-xl font-semibold text-white">Watch the ice take the world</h2>
              <p className="text-sm text-slate-400">The real map, the real ice schedule. Everything above the line stops producing and loses people.</p>
            </div>
            <Link to="/how-to-play" className="text-sm text-sky-300 hover:text-white">
              How the ice works
            </Link>
          </div>
          <HeroMap className="aspect-[2000/760] w-full bg-[#0a1f33]" />
        </div>
      </section>

      {/* Timeline */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <h2 className="display mb-6 text-center text-3xl font-semibold text-white sm:text-4xl">Thirty days. Five weeks of weather.</h2>
        <ol className="grid gap-3 md:grid-cols-5">
          {ICE_WEEKS.map((w, i) => (
            <li key={w.day} className="glass relative rounded-xl p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="display text-xs font-semibold uppercase tracking-widest text-sky-300">Day {w.day}</span>
                <span className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[11px] text-slate-300">ice at {w.lat}°</span>
              </div>
              <div className="mb-3 h-1.5 overflow-hidden rounded bg-slate-800">
                <div className="h-full bg-gradient-to-r from-sky-200 to-sky-400" style={{ width: `${((i + 1) / ICE_WEEKS.length) * 100}%` }} />
              </div>
              <h3 className={`font-semibold ${i === ICE_WEEKS.length - 1 ? "ember-text" : "text-white"}`}>{w.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-400">{w.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Pillars */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="grid gap-4 md:grid-cols-3">
          <Pillar
            icon={<IconGlobe />}
            title="A real Earth, carved into 408 regions"
            body="Every region has terrain and one or two special resources: copper, tin, iron, horses, fertile soil. No region has everything, so you trade, ally, or take it."
          />
          <Pillar
            icon={<IconSword />}
            title="Raid, conquer, hold"
            body="Armies march in real time across real distances. Defenders see you coming with a countdown. Walls, forts and hills favour the defence. Lose your capital and your realm breaks apart."
          />
          <Pillar
            icon={<IconClock />}
            title="Always running, never grinding"
            body="Build timers, research and the ice keep moving while you sleep. Queue an hour of work, set your workers, come back to the reports. Ten minutes a day keeps an empire alive."
          />
          <Pillar
            icon={<IconFlame />}
            title="Seven ages, one tech tree"
            body="Fire making to Railways. Each age unlocks buildings, units and a deeper reach across the map. Being first to an age earns a bonus everyone else can see."
          />
          <Pillar
            icon={<IconShield />}
            title="Alliances that can win together"
            body="Share vision, reinforce each other, ship grain ahead of the frost, and plot in private chat. An alliance holding 60% of the world for 48 hours ends the match on the spot."
          />
          <Pillar
            icon={<IconTrophy />}
            title="Three ways to win"
            body="Hold most of the map. Raise the Great Hearth, a wonder every rival is warned about. Or simply have the most people alive in warm land when the ice stops on day 30."
          />
        </div>
      </section>

      {/* Matches in play */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="mb-4 flex items-end justify-between">
          <h2 className="display text-2xl font-semibold text-white">Matches in play</h2>
          <Link to="/matches" className="text-sm text-sky-300 hover:text-white">
            All matches
          </Link>
        </div>
        {matches.isLoading && <p className="text-slate-400">Loading...</p>}
        {matches.data && running.length === 0 && (
          <div className="glass rounded-xl p-5 text-slate-300">
            Nothing is being played this minute.{next ? ` The next tournament, ${next.name}, starts in ${formatCountdown((Date.parse(next.startsAt) - now) / 1000)}.` : " A new tournament opens every week."}
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {running.map((m) => (
            <MatchCard key={m.id} m={m} now={now} />
          ))}
        </div>
      </section>

      {/* Closing call */}
      {!me.data && (
        <section className="mx-auto max-w-6xl px-4 pb-20">
          <div className="glass glass-strong relative overflow-hidden rounded-2xl px-6 py-12 text-center sm:px-12">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_120%,rgba(245,158,11,0.18),transparent_70%)]" />
            <h2 className="display relative text-3xl font-bold sm:text-5xl">
              <span className="frost-text">Somewhere on Earth, five families are waiting for you.</span>
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-slate-300">Sign up, pick a capital, and start building before the line reaches your latitude.</p>
            <a href="#signup" className="btn-ember display relative mt-8 inline-block rounded-md px-8 py-3.5 text-lg font-semibold">
              Claim your land
            </a>
          </div>
        </section>
      )}

      {/* Footer links */}
      <footer className="border-t border-slate-800/70 bg-slate-950/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-sm text-slate-400">
          <Link to="/about" className="hover:text-white">
            About
          </Link>
          <Link to="/how-to-play" className="hover:text-white">
            How to play
          </Link>
          <Link to="/hall-of-fame" className="hover:text-white">
            Hall of fame
          </Link>
          <Link to="/matches" className="hover:text-white">
            Matches
          </Link>
          <span className="ml-auto flex items-center gap-4">
            <SocialIcons />
            <span className="text-xs text-slate-500" title="Early access: the number after the dot counts every change shipped since launch">
              v{APP_VERSION}
            </span>
          </span>
        </div>
      </footer>
    </main>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div className="rounded-lg border border-slate-700/40 bg-slate-950/40 px-3 py-2.5">
      <dt className="order-2 text-xs uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="display text-2xl font-semibold text-white">{n}</dd>
    </div>
  );
}

function Pillar({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="glass rounded-xl p-5 transition hover:border-sky-400/40">
      <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-sky-400/10 text-sky-200 ring-1 ring-sky-400/30">{icon}</div>
      <h3 className="font-semibold text-white">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{body}</p>
    </div>
  );
}

export function MatchCard({ m, now }: { m: PublicMatch; now: number }) {
  const me = useMe();
  const mine = useQuery({ queryKey: keys.matches, queryFn: () => api.matches(), enabled: !!me.data, staleTime: 30_000 });
  const joined = !!mine.data?.some((x) => x.id === m.id && x.joined);
  const startsIn = (Date.parse(m.startsAt) - now) / 1000;
  const endsIn = (Date.parse(m.endsAt) - now) / 1000;
  const frozenShare = Math.min(1, Math.max(0, (72 - m.iceLatitude) / (72 - 28)));
  return (
    <div className="glass space-y-3 rounded-xl p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="display font-semibold text-white">{m.name}</h3>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">{m.speed}x</span>
        <span className={`rounded px-1.5 py-0.5 text-xs ${m.status === "running" ? "bg-emerald-500/20 text-emerald-300" : "bg-sky-500/20 text-sky-300"}`}>
          {m.status === "running" ? "in progress" : "open lobby"}
        </span>
      </div>
      {m.status === "lobby" ? (
        <p className="text-sm text-slate-300">
          <span className="text-white">{m.humans}</span> joined · starts in <span className="tabular-nums text-amber-200">{formatCountdown(startsIn)}</span>
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-300">
            Day {Math.floor(m.day) + 1} of {balance.match.lengthDays} · {m.humans + m.ai}/{balance.match.maxHumanPlayers} players · {m.claimedRegions}/{m.totalRegions} regions claimed · ends in{" "}
            <span className="tabular-nums">{formatCountdown(endsIn)}</span>
          </p>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>Ice beyond {m.iceLatitude.toFixed(0)}°</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
              <div className="h-full bg-gradient-to-r from-sky-200 to-sky-400" style={{ width: `${frozenShare * 100}%` }} />
            </div>
          </div>
        </>
      )}
      {m.top.length > 0 && m.status === "running" && (
        <ol className="text-sm text-slate-300">
          {m.top.map((t, i) => (
            <li key={t.name} className="flex justify-between">
              <span>
                <span className={i === 0 ? "text-amber-200" : "text-slate-500"}>{i + 1}.</span> {t.name}
                {t.isAi && <span className="ml-1 text-xs text-slate-500">AI</span>}
              </span>
              <span className="tabular-nums text-slate-500">{fmt(t.score)} pts</span>
            </li>
          ))}
        </ol>
      )}
      {/* Standings while a match runs are for its players; for them the button opens the match's own table. Anyone else already sees the top three above. */}
      {m.status === "lobby" ? (
        <Link to="/matches" className="btn-ice inline-block rounded-md px-3 py-1.5 text-sm">
          Join in the lobby
        </Link>
      ) : joined ? (
        <Link to="/match/$matchId/leaderboard" params={{ matchId: m.slug || m.id }} className="btn-ice inline-block rounded-md px-3 py-1.5 text-sm">
          View standings
        </Link>
      ) : null}
    </div>
  );
}

function IconGlobe() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </svg>
  );
}
function IconSword() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 17.5L3 6V3h3l11.5 11.5" />
      <path d="M13 19l6-6M16 16l4 4M19 13l2 2" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function IconFlame() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3c1 3 4 4.5 4 9a4 4 0 0 1-8 0c0-1.5.5-2.5 1-3.5.5 1 1.5 1.5 2 1.5 0-3 0-5 1-7z" />
    </svg>
  );
}
function IconShield() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function IconTrophy() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 4h8v5a4 4 0 0 1-8 0z" />
      <path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M9 17h6" />
    </svg>
  );
}

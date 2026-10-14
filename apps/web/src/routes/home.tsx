import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatCountdown } from "@lastthaw/shared";
import { useMe } from "../api/auth.js";
import { Card, fmt } from "../components/ui.js";
import { useNow } from "../hooks/useNow.js";
import { TAGLINE } from "../components/TopBar.js";

export interface PublicMatch {
  id: string;
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

export function HomePage() {
  const me = useMe();
  const matches = usePublicMatches();
  const now = useNow(1000);
  const lobby = matches.data?.filter((m) => m.status === "lobby") ?? [];
  const running = matches.data?.filter((m) => m.status === "running") ?? [];
  const next = lobby[0];

  return (
    <main>
      {/* Hero */}
      <section className="hero relative overflow-hidden border-b border-slate-800">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:py-24">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.3em] text-sky-300/80">A 30-day strategy game on a freezing Earth</p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-6xl">{TAGLINE}</h1>
          <p className="mt-5 max-w-2xl text-lg text-slate-300">
            Start with five families somewhere on the real Earth. Gather, build, research and raid your way through five ages while the ice creeps in from both
            poles and squeezes everyone toward the equator. One winner. Hard end date.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/matches" className="rounded-md bg-sky-500 px-5 py-2.5 font-medium text-slate-950 hover:bg-sky-400">
              {me.data ? "Find a match" : "Play free"}
            </Link>
            <Link to="/how-to-play" className="rounded-md border border-slate-700 px-5 py-2.5 text-slate-200 hover:bg-slate-800">
              How to play
            </Link>
            {next && (
              <span className="text-sm text-slate-400">
                Next match <span className="text-slate-200">{next.name}</span> starts in {formatCountdown((Date.parse(next.startsAt) - now) / 1000)}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Pillars */}
      <section className="mx-auto grid max-w-5xl gap-4 px-4 py-12 sm:grid-cols-3">
        <Pillar title="Real Earth, 408 regions" body="Every region has terrain and one or two special resources. No region has everything, so trade and conquest matter." />
        <Pillar title="Always running" body="Build timers, travel times and the ice keep moving while you sleep. Queue work, set your workers, come back to the results." />
        <Pillar title="The ice decides the endgame" body="By week four most of the map is frozen. Hold 60% of the regions for 48 hours, or have the highest score on day 30." />
      </section>

      {/* Matches in play */}
      <section className="mx-auto max-w-5xl px-4 pb-12">
        <div className="mb-3 flex items-end justify-between">
          <h2 className="text-xl font-semibold">Matches in play</h2>
          <Link to="/matches" className="text-sm text-sky-400 hover:underline">
            All matches
          </Link>
        </div>
        {matches.isLoading && <p className="text-slate-400">Loading...</p>}
        {matches.data?.length === 0 && <Card>No matches right now. A new one opens every week.</Card>}
        <div className="grid gap-3 md:grid-cols-2">
          {[...running, ...lobby].map((m) => (
            <MatchCard key={m.id} m={m} now={now} />
          ))}
        </div>
      </section>

      {/* Footer links */}
      <footer className="border-t border-slate-800">
        <div className="mx-auto flex max-w-5xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-sm text-slate-400">
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
          <span className="ml-auto">Free to play. No purchases affect the game.</span>
        </div>
      </footer>
    </main>
  );
}

function Pillar({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <h3 className="font-medium text-white">{title}</h3>
      <p className="mt-1 text-sm text-slate-400">{body}</p>
    </Card>
  );
}

export function MatchCard({ m, now }: { m: PublicMatch; now: number }) {
  const startsIn = (Date.parse(m.startsAt) - now) / 1000;
  const endsIn = (Date.parse(m.endsAt) - now) / 1000;
  return (
    <Card className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">{m.name}</h3>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">{m.speed}x</span>
        <span className={`rounded px-1.5 py-0.5 text-xs ${m.status === "running" ? "bg-emerald-500/20 text-emerald-300" : "bg-sky-500/20 text-sky-300"}`}>{m.status}</span>
      </div>
      <p className="text-sm text-slate-400">
        {m.status === "lobby"
          ? `${m.humans} joined · starts in ${formatCountdown(startsIn)}`
          : `Day ${Math.floor(m.day) + 1} of 30 · ${m.humans} players + ${m.ai} AI · ${m.claimedRegions}/${m.totalRegions} regions claimed · ice beyond ${m.iceLatitude.toFixed(0)}° · ends in ${formatCountdown(endsIn)}`}
      </p>
      {m.top.length > 0 && m.status === "running" && (
        <ol className="text-sm text-slate-300">
          {m.top.map((t, i) => (
            <li key={t.name} className="flex justify-between">
              <span>
                {i + 1}. {t.name}
                {t.isAi && <span className="ml-1 text-xs text-slate-500">AI</span>}
              </span>
              <span className="tabular-nums text-slate-500">{fmt(t.score)} pts</span>
            </li>
          ))}
        </ol>
      )}
      <Link to="/matches" className="text-sm text-sky-400 hover:underline">
        {m.status === "lobby" ? "Join in the lobby" : "View"}
      </Link>
    </Card>
  );
}

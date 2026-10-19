import { useQuery } from "@tanstack/react-query";
import { usePageMeta, useSlugAddress } from "../seo.js";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { AGES, balance, type AgeIndex } from "@lastthaw/shared";
import { Button, fmt } from "./ui.js";

interface Standing {
  rank: number;
  id: string;
  name: string;
  isAi: boolean;
  allianceTag: string | null;
  age: number;
  score: number;
  regions: number;
  population: number;
  eliminated: boolean;
  won: boolean;
  peakRank?: number | null;
  battles?: number;
  battlesWon?: number;
  conquests?: number;
  techs?: number;
}
interface Point {
  day: number;
  score: number;
  regions: number;
  population: number;
}
export interface Summary {
  match: { id: string; slug?: string; name: string; speed: number; startsAt: string; finishedAt: string | null; winnerPlayerId: string | null; winKind: string | null; wonderName: string; tournament?: boolean };
  story?: {
    paragraphs: string[];
    howWon: string;
    leadChanges: Array<{ day: number; playerId: string; playerName: string }>;
    biggestBattle: { day: number; regionName: string; attackerName: string; defenderName: string; losses: number; attackerWon: boolean; conquered: boolean } | null;
    iceLatitude: number;
    eliminated: number;
    counts: Record<string, number>;
    prev: { slug: string; name: string } | null;
    next: { slug: string; name: string } | null;
  };
  me: { playerId: string; rank: number | null };
  standings: Standing[];
  milestones: { key: string; label: string; playerId: string; playerName: string; points: number; at: string }[];
  history: Record<string, Point[]>;
  totals: { battles: number; regionsHeld: number; agesReached: number; players: number; humans: number };
}

const SEEN = (id: string) => `lt-summary-seen:${id}`;

/** How the match ended, in a sentence. */
function endedBy(kind: string | null, winner: string, wonder: string): string {
  switch (kind) {
    case "hold":
      return `${winner} held ${Math.round(balance.win.regionShareForEarlyWin * 100)}% of the world for ${balance.win.holdHours} hours.`;
    case "wonder":
      return `${winner} finished the ${wonder}.`;
    case "survival":
      return `The ice stopped on day ${balance.match.lengthDays}. ${winner} had the most people alive in unfrozen land.`;
    case "score":
      return `Day ${balance.match.lengthDays} came and ${winner} had the highest score.`;
    default:
      return `${winner} won.`;
  }
}

/**
 * The end-of-match celebration: who won and how, the final standings, the
 * firsts, and how the leaders' scores grew day by day. Shown once when the
 * match finishes; the finished card can reopen it.
 */
/** Loads the report for a match; the page and the overlay both use it. */
function useSummary(matchId: string, enabled = true) {
  return useQuery({
    queryKey: ["summary", matchId],
    queryFn: () => fetch(`/api/matches/${matchId}/summary`, { credentials: "include" }).then((r) => r.json() as Promise<Summary>),
    enabled,
  });
}

/** Share link: the report page lives at this address for good. */
function reportUrl(matchId: string): string {
  return `${window.location.origin}/match/${matchId}/report`;
}

/**
 * The end-of-match celebration: who won and how, the final standings, the
 * firsts, and how the leaders' scores grew day by day. Shown once when the
 * match finishes; the finished card can reopen it.
 */
export function MatchSummary({ matchId, open, onClose, colorOf }: { matchId: string; open: boolean; onClose: () => void; colorOf: (id: string) => string }) {
  const q = useSummary(matchId, open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/90 backdrop-blur-sm" onClick={onClose}>
      <Confetti />
      <div className="relative mx-auto my-6 w-full max-w-3xl px-3 sm:my-10" onClick={(e) => e.stopPropagation()}>
        <ReportBody matchId={matchId} s={q.data} colorOf={colorOf} onClose={onClose} />
      </div>
    </div>
  );
}

/** The permanent report page: /match/:id/report, readable by anyone, logged in or not. */
export function ReportPage() {
  const { matchId } = useParams({ from: "/match/$matchId/report" });
  const q = useSummary(matchId);
  useSlugAddress(matchId, q.data?.match?.slug, "/report");
  const winnerName = q.data?.standings?.find((p) => p.won)?.name;
  usePageMeta({
    title: q.data?.match ? (q.data.match.winKind === "ended" ? `${q.data.match.name}: ended early` : winnerName ? `${q.data.match.name}: final report, won by ${winnerName}` : `${q.data.match.name}: final report`) : "Match report",
    description: q.data?.story?.paragraphs[0] ?? (q.data?.match ? `How ${q.data.match.name} was won: final standings, ages reached, battles fought and the winner's path through thirty days of ice. A Last Thaw match report.` : undefined),
    path: `/match/${q.data?.match?.slug || matchId}/report`,
  });
  const colorOf = useMemo(() => {
    const ids = q.data?.standings?.map((p) => p.id) ?? [];
    return (id: string) => REPORT_COLORS[Math.max(0, ids.indexOf(id)) % REPORT_COLORS.length]!;
  }, [q.data]);
  if (q.isError || (q.data && !("standings" in q.data))) return <main className="mx-auto max-w-3xl px-4 py-10 text-slate-300">No match with that id.</main>;
  return (
    <main className="mx-auto w-full max-w-3xl px-3 py-6 sm:py-10">
      {q.data?.match.finishedAt && <Confetti />}
      <ReportBody matchId={matchId} s={q.data} colorOf={colorOf} />
    </main>
  );
}

const REPORT_COLORS = ["#f59e0b", "#38bdf8", "#a78bfa", "#34d399", "#f472b6", "#fb923c", "#60a5fa", "#4ade80", "#e879f9", "#facc15"];

function ReportBody({ matchId, s, colorOf, onClose }: { matchId: string; s: Summary | undefined; colorOf: (id: string) => string; onClose?: () => void }) {
  const [copied, setCopied] = useState(false);
  const winner = s?.match.winKind === "ended" ? undefined : (s?.standings.find((p) => p.won) ?? s?.standings[0]);
  const iWon = !!s && !!winner && !!s.me.playerId && winner.id === s.me.playerId;
  const mine = s?.standings.find((p) => s.me.playerId && p.id === s.me.playerId);
  const running = !!s && !s.match.finishedAt;
  const share = async () => {
    try {
      await navigator.clipboard.writeText(reportUrl(matchId));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", reportUrl(matchId));
    }
  };
  return (
        <div className="overflow-hidden rounded-2xl border border-amber-500/40 bg-slate-950 shadow-2xl">
          <div className="bg-gradient-to-b from-amber-500/20 to-transparent px-5 pb-4 pt-8 text-center">
            <p className="text-xs uppercase tracking-[0.3em] text-amber-300">{s?.match.name ?? "The match"} · the last thaw</p>
            <h1 className="mt-2 text-3xl font-bold text-white sm:text-5xl">{!s ? "…" : running ? `${s.match.name}: still being fought` : s.match.winKind === "ended" ? `${s.match.name}: ended early` : iWon ? `${s.match.name}: victory!` : winner ? `${s.match.name}: won by ${winner.name}` : `${s.match.name}: the match is over`}</h1>
            {s && !running && s.match.winKind === "ended" && <p className="mt-3 text-base text-amber-100">The game was ended early by its creator. No winner was named; the standings are by score as they stood.</p>}
            {s && winner && !running && s.match.winKind !== "ended" && <p className="mt-3 text-base text-amber-100">{s.story?.howWon || endedBy(s.match.winKind, winner.name, s.match.wonderName)}</p>}
            {s && running && <p className="mt-3 text-sm text-slate-300">This page fills in when the match ends and stays here for good.</p>}
            {s && mine && !iWon && !running && (
              <p className="mt-2 text-sm text-slate-300">
                You finished <b className="text-white">#{mine.rank}</b> of {s.totals.players} with {fmt(mine.score)} points, {mine.regions} regions and {fmt(mine.population)} people in the {AGES[mine.age as AgeIndex]} Age.
              </p>
            )}
            {s && iWon && mine && (
              <p className="mt-2 text-sm text-slate-300">
                Thirty days of work: {fmt(mine.score)} points, {mine.regions} regions and {fmt(mine.population)} people, reaching the {AGES[mine.age as AgeIndex]} Age.
              </p>
            )}
          </div>

          {s && (
            <div className="space-y-6 px-5 pb-6">
              {s.story && s.story.paragraphs.length > 0 && (
                <section aria-label="How the match went" className="space-y-2 text-sm leading-relaxed text-slate-300">
                  {s.story.paragraphs.map((p) => (
                    <p key={p.slice(0, 40)}>{p}</p>
                  ))}
                </section>
              )}
              <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-5">
                <Stat label="players" value={`${s.totals.players}`} />
                <Stat label="battles" value={fmt(s.totals.battles)} />
                <Stat label="regions held" value={fmt(s.totals.regionsHeld)} />
                <Stat label="ages reached" value={`${s.totals.agesReached}`} sub={AGES[Math.max(0, s.totals.agesReached - 1) as AgeIndex]} />
                <Stat label="speed" value={`${s.match.speed}x`} />
              </div>

              <section>
                <h2 className="mb-2 text-sm font-semibold text-slate-200">Score over the thirty days</h2>
                <GrowthChart history={s.history} standings={s.standings} meId={s.me.playerId} colorOf={colorOf} />
              </section>

              <section>
                <h2 className="mb-2 text-sm font-semibold text-slate-200">Final standings</h2>
                <div className="overflow-x-auto rounded-md border border-slate-800">
                  <table className="w-full min-w-max text-xs">
                    <thead className="bg-slate-900 text-left uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-2 py-1.5">#</th>
                        <th className="px-2 py-1.5">Player</th>
                        <th className="px-2 py-1.5">Age</th>
                        <th className="px-2 py-1.5 text-right">Regions</th>
                        <th className="px-2 py-1.5 text-right">People</th>
                        <th className="px-2 py-1.5 text-right">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.standings.slice(0, 12).map((p) => (
                        <tr key={p.id} className={`border-t border-slate-800 ${p.id === s.me.playerId ? "bg-sky-500/10" : ""} ${p.eliminated ? "text-slate-500" : ""}`}>
                          <td className="px-2 py-1.5 tabular-nums">{p.won ? "🏆" : p.rank}</td>
                          <td className="px-2 py-1.5">
                            <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: colorOf(p.id) }} />
                            {p.allianceTag && <span className="mr-1 rounded bg-slate-800 px-1 text-[10px] text-slate-300">[{p.allianceTag}]</span>}
                            {p.name}
                            {p.id === s.me.playerId && <span className="ml-1 text-[10px] text-sky-300">you</span>}
                          </td>
                          <td className="px-2 py-1.5 text-slate-400">{AGES[p.age as AgeIndex]}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{p.regions}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(p.population)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(p.score)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {s.milestones.some((ms) => ms.key.startsWith("capital_")) && (
                <section>
                  <h2 className="mb-2 text-sm font-semibold text-slate-200">Capital takeovers</h2>
                  <ul className="grid gap-1 text-xs sm:grid-cols-2">
                    {s.milestones
                      .filter((ms) => ms.key.startsWith("capital_"))
                      .map((ms) => (
                        <li key={ms.key} className="flex justify-between gap-2 rounded border border-slate-800 px-2 py-1">
                          <span className="text-slate-300">{ms.label}</span>
                          <span className={ms.playerId === s.me.playerId ? "text-sky-300" : "text-slate-400"}>{ms.playerName}</span>
                        </li>
                      ))}
                  </ul>
                </section>
              )}
              {s.milestones.some((ms) => !ms.key.startsWith("capital_")) && (
                <section>
                  <h2 className="mb-2 text-sm font-semibold text-slate-200">Firsts</h2>
                  <ul className="grid gap-1 text-xs sm:grid-cols-2">
                    {s.milestones.filter((ms) => !ms.key.startsWith("capital_")).map((ms) => (
                      <li key={ms.key} className="flex justify-between gap-2 rounded border border-slate-800 px-2 py-1">
                        <span className="text-slate-300">{ms.label}</span>
                        <span className={ms.playerId === s.me.playerId ? "text-sky-300" : "text-slate-400"}>{ms.playerName}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <Arcs standings={s.standings} />
              <Timeline matchId={matchId} finished={!running} />
              {(s.story?.prev || s.story?.next) && (
                <nav className="flex flex-wrap justify-between gap-2 text-sm" aria-label="Other tournaments">
                  {s.story?.prev ? (
                    <Link to="/match/$matchId/report" params={{ matchId: s.story.prev.slug }} className="text-sky-300 hover:underline">
                      ← Previous tournament: {s.story.prev.name}
                    </Link>
                  ) : (
                    <span />
                  )}
                  {s.story?.next && (
                    <Link to="/match/$matchId/report" params={{ matchId: s.story.next.slug }} className="text-sky-300 hover:underline">
                      Next tournament: {s.story.next.name} →
                    </Link>
                  )}
                </nav>
              )}
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="ghost" onClick={share}>
                  {copied ? "Link copied" : "Share this report"}
                </Button>
                <Link to="/match/$matchId/replay" params={{ matchId }}>
                  <Button variant="ghost">▶ Watch the replay</Button>
                </Link>
                <Link to="/match/$matchId/leaderboard" params={{ matchId }}>
                  <Button variant="ghost">Full leaderboard</Button>
                </Link>
                <Link to="/hall-of-fame">
                  <Button variant="ghost">Hall of fame</Button>
                </Link>
                <Link to="/how-to-play" hash="winning">
                  <Button variant="ghost">How matches are won</Button>
                </Link>
                <Link to="/">
                  <Button variant="ghost">Back to the lobby</Button>
                </Link>
                {onClose && <Button onClick={onClose}>Close</Button>}
              </div>
            </div>
          )}
          {!s && <p className="p-6 text-center text-sm text-slate-400">Gathering the final report…</p>}
        </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/60 px-2 py-2">
      <div className="text-lg font-semibold text-white">{value}</div>
      <div className="uppercase tracking-wide text-slate-500">{label}</div>
      {sub && <div className="text-slate-400">{sub}</div>}
    </div>
  );
}

/** Score by day for the top five and you, as a plain SVG line chart. */
function GrowthChart({ history, standings, meId, colorOf }: { history: Record<string, Point[]>; standings: Standing[]; meId: string; colorOf: (id: string) => string }) {
  const ids = useMemo(() => {
    const top = standings.slice(0, 5).map((p) => p.id);
    if (!top.includes(meId) && history[meId]?.length) top.push(meId);
    return top.filter((id) => (history[id]?.length ?? 0) > 1);
  }, [history, standings, meId]);
  if (ids.length === 0) return <p className="rounded-md border border-slate-800 p-3 text-xs text-slate-500">No score history was recorded for this match.</p>;
  const W = 640;
  const H = 220;
  const padL = 44;
  const padB = 22;
  const padT = 8;
  const maxDay = Math.max(balance.match.lengthDays, ...ids.flatMap((id) => history[id]!.map((p) => p.day)));
  const maxScore = Math.max(1, ...ids.flatMap((id) => history[id]!.map((p) => p.score)));
  const x = (d: number) => padL + (d / maxDay) * (W - padL - 8);
  const y = (sc: number) => padT + (1 - sc / maxScore) * (H - padT - padB);
  const nameOf = (id: string) => standings.find((p) => p.id === id)?.name ?? "?";
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/40 p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Score over time">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W - 8} y1={y(maxScore * f)} y2={y(maxScore * f)} stroke="#1e293b" strokeWidth={1} />
            <text x={padL - 4} y={y(maxScore * f)} textAnchor="end" dominantBaseline="central" fontSize={9} fill="#64748b">
              {fmt(Math.round(maxScore * f))}
            </text>
          </g>
        ))}
        {[0, 5, 10, 15, 20, 25, 30].filter((d) => d <= maxDay).map((d) => (
          <text key={d} x={x(d)} y={H - 6} textAnchor="middle" fontSize={9} fill="#64748b">
            day {d}
          </text>
        ))}
        {ids.map((id) => {
          const pts = [...history[id]!].sort((a, b) => a.day - b.day);
          const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.day).toFixed(1)} ${y(p.score).toFixed(1)}`).join(" ");
          const me = id === meId;
          return <path key={id} d={d} fill="none" stroke={colorOf(id)} strokeWidth={me ? 3 : 1.8} strokeLinejoin="round" strokeLinecap="round" opacity={me ? 1 : 0.85} />;
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {ids.map((id) => (
          <span key={id} className="flex items-center gap-1 text-slate-300">
            <span className="inline-block h-2 w-4 rounded-sm" style={{ background: colorOf(id) }} />
            {nameOf(id)}
            {id === meId && <span className="text-sky-300">(you)</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A little falling confetti, pure CSS; respects reduced motion. */
function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 60 }, (_, i) => ({ i, left: Math.random() * 100, delay: Math.random() * 4, dur: 5 + Math.random() * 4, hue: Math.floor(Math.random() * 360), size: 6 + Math.random() * 6 })), []);
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden motion-reduce:hidden" aria-hidden>
      <style>{`@keyframes lt-fall { 0% { transform: translateY(-10vh) rotate(0deg); opacity: 1 } 100% { transform: translateY(110vh) rotate(720deg); opacity: 0.6 } }`}</style>
      {pieces.map((p) => (
        <span
          key={p.i}
          style={{ left: `${p.left}%`, width: p.size, height: p.size * 0.6, background: `hsl(${p.hue} 90% 60%)`, animation: `lt-fall ${p.dur}s linear ${p.delay}s infinite` }}
          className="absolute top-0 block rounded-sm"
        />
      ))}
    </div>
  );
}

/** Opens the report the first time a finished match is seen on this device; the finished card can bring it back. */
export function useSummaryOpen(matchId: string, finished: boolean): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!finished) return;
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN(matchId)) === "1";
    } catch {
      seen = false;
    }
    if (!seen) setOpen(true);
  }, [finished, matchId]);
  const set = (v: boolean) => {
    setOpen(v);
    if (!v) {
      try {
        localStorage.setItem(SEEN(matchId), "1");
      } catch {
        /* private mode */
      }
    }
  };
  return [open, set];
}

/** Each tribe's arc in a line: best rank held, conquests, battles won, techs. */
function Arcs({ standings }: { standings: Standing[] }) {
  const rows = standings.filter((p) => p.peakRank !== undefined).slice(0, 12);
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-200">Every tribe's thirty days</h2>
      <ul className="space-y-1 text-xs text-slate-400">
        {rows.map((p) => (
          <li key={p.id}>
            <span className="text-slate-200">{p.name}</span>
            {p.allianceTag ? ` [${p.allianceTag}]` : ""}: finished #{p.rank}
            {p.peakRank ? `, best rank #${p.peakRank}` : ""}, {p.regions} region{p.regions === 1 ? "" : "s"} and {fmt(p.population)} people in the {AGES[p.age as AgeIndex]} Age
            {p.conquests ? `, ${p.conquests} conquest${p.conquests === 1 ? "" : "s"}` : ""}
            {p.battles ? `, ${p.battlesWon ?? 0} of ${p.battles} battle${p.battles === 1 ? "" : "s"} won` : ", no battles"}
            {p.techs ? `, ${p.techs} tech${p.techs === 1 ? "" : "s"} researched` : ""}
            {p.eliminated ? ". Eliminated." : "."}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The match day by day: every public event from the feed, once the match is over. */
function Timeline({ matchId, finished }: { matchId: string; finished: boolean }) {
  const q = useQuery({
    queryKey: ["match", matchId, "timeline"],
    queryFn: () => fetch(`/api/matches/${matchId}/feed?all=1`, { credentials: "include" }).then((r) => (r.ok ? (r.json() as Promise<{ items: Array<{ at: string; kind: string; text: string }> }>) : Promise.reject(new Error("no feed")))),
    enabled: finished,
    staleTime: 10 * 60_000,
  });
  const [open, setOpen] = useState(false);
  const items = q.data?.items ?? [];
  if (!finished || items.length === 0) return null;
  const shown = open ? items : items.slice(0, 12);
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-200">Day by day</h2>
      <ol className="space-y-1 text-xs text-slate-400">
        {shown.map((e, i) => (
          <li key={`${e.at}-${i}`}>
            <span className="tabular-nums text-slate-500">{new Date(e.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span> {e.text}
          </li>
        ))}
      </ol>
      {items.length > 12 && (
        <button className="mt-2 text-xs text-sky-300 hover:underline" onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : `Show all ${items.length} events`}
        </button>
      )}
    </section>
  );
}

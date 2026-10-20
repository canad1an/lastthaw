import { useEffect, useState } from "react";
import { balance, iceLatitudeOnDay, newOnDay, type MatchStateView } from "@lastthaw/shared";
import { Button } from "./ui.js";

const SEEN = (matchId: string, day: number) => `lt-day-seen:${matchId}:${day}`;

/** Opens the morning brief once per match day on this device, from day 2 (day 1 has the introduction). */
export function useDayBriefOpen(matchId: string, day: number, enabled: boolean): [boolean, () => void] {
  const [openDay, setOpenDay] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || day < 2) return;
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN(matchId, day)) === "1";
    } catch {
      seen = false;
    }
    if (!seen) setOpenDay(day);
  }, [enabled, matchId, day]);
  const close = () => {
    if (openDay !== null)
      try {
        localStorage.setItem(SEEN(matchId, openDay), "1");
      } catch {
        /* private mode */
      }
    setOpenDay(null);
  };
  return [openDay !== null, close];
}

/**
 * The morning brief, at the start of each match day: the day's objective and what it pays, who took yesterday's,
 * the top three in the standings (and where you stand), and anything that opens today, such as a new age.
 */
export function DayBrief({ day, state, onClose }: { day: number; state: MatchStateView; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const days = balance.match.lengthDays;
  const o = state.objective && state.objective.day === day ? state.objective : null;
  const prize = balance.win.milestones.daily ?? 100;
  const nameOf = (id: string | null) => (id ? (state.players.find((p) => p.id === id)?.name ?? "someone") : null);
  const ranked = [...state.players].sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, 3);
  const myRank = ranked.findIndex((p) => p.id === state.me.playerId);
  const news = newOnDay(day);
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/85 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Day ${day}`}>
      <div className="relative mx-auto my-8 w-full max-w-lg px-3 sm:my-14" onClick={(e) => e.stopPropagation()}>
        <div className="overflow-hidden rounded-2xl border border-amber-400/40 bg-slate-950 shadow-2xl">
          <div className="bg-gradient-to-b from-amber-400/15 to-transparent px-5 pb-3 pt-6 text-center">
            <p className="text-xs uppercase tracking-[0.3em] text-amber-200">{state.match.name}</p>
            <h1 className="mt-1 text-3xl font-bold text-white">Day {day}</h1>
            <p className="mt-1 text-xs text-slate-400">
              {days - day === 0 ? "The last day" : `${days - day} day${days - day === 1 ? "" : "s"} until the ice stops`} · the ice is past {Math.round(iceLatitudeOnDay(day))}° today
            </p>
          </div>
          <div className="space-y-4 px-5 pb-5 text-sm text-slate-300">
            <section>
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Today's target</h2>
              {o ? (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2">
                  <p className="text-base text-white">🎯 {o.label}</p>
                  <p className="mt-0.5 text-xs text-emerald-200">The best tribe at it when the day ends scores +{prize}.</p>
                </div>
              ) : (
                <p className="text-slate-500">Today's objective is on its way.</p>
              )}
              {state.objective?.yesterday && (
                <p className="mt-1 text-xs text-slate-400">
                  Yesterday ({state.objective.yesterday.label.toLowerCase()}): {nameOf(state.objective.yesterday.playerId) ?? "nobody"}
                  {state.objective.yesterday.playerId === state.me.playerId ? " (you)" : ""} took it{state.objective.yesterday.playerId ? ` with ${Math.round(state.objective.yesterday.value).toLocaleString("en-US")}` : ""}.
                </p>
              )}
            </section>
            <section>
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">The leaders</h2>
              <ol className="divide-y divide-slate-800 rounded-lg border border-slate-800">
                {top.map((p, i) => (
                  <li key={p.id} className={`flex items-center gap-3 px-3 py-1.5 ${p.id === state.me.playerId ? "bg-sky-950/40" : ""}`}>
                    <span className="w-5 text-center text-base">{["🥇", "🥈", "🥉"][i]}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-100">
                      {p.name}
                      {p.id === state.me.playerId ? <span className="text-sky-300"> (you)</span> : null}
                    </span>
                    <span className="text-xs tabular-nums text-slate-400">{p.regions} regions</span>
                    <span className="w-16 text-right tabular-nums text-slate-100">{Math.round(p.score).toLocaleString("en-US")}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-1 text-xs text-slate-400">
                {myRank >= 3 ? `You are ${myRank + 1}${ordinal(myRank + 1)} of ${ranked.length} with ${Math.round(ranked[myRank]!.score).toLocaleString("en-US")}. ` : ""}The full standings are in the Leaderboard menu.
              </p>
            </section>
            {news.length > 0 && (
              <section>
                <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">New today</h2>
                <ul className="space-y-1.5">
                  {news.map((n) => (
                    <li key={n} className="rounded-lg border border-amber-400/30 bg-amber-950/20 px-3 py-2 text-amber-50">
                      {n}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              <Button onClick={onClose}>To the map</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

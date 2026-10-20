import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { balance } from "@lastthaw/shared";
import { Button } from "./ui.js";

const SEEN = (id: string) => `lt-intro-seen:${id}`;

/** Opens the introduction the first time a match is seen on this device. */
export function useIntroOpen(matchId: string, enabled: boolean): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN(matchId)) === "1";
    } catch {
      seen = false;
    }
    if (!seen) setOpen(true);
  }, [enabled, matchId]);
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

/**
 * The welcome at the start of a match: what the next thirty days are about,
 * what to do first, and the ways to win. Shown once per match per device;
 * the "?" button on the map brings it back.
 */
export function MatchIntro({ open, onClose, matchName, speed, resourceMult = 1 }: { open: boolean; onClose: () => void; matchName: string; speed: number; resourceMult?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const days = balance.match.lengthDays;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/90 backdrop-blur-sm" onClick={onClose}>
      <div className="relative mx-auto my-6 w-full max-w-2xl px-3 sm:my-10" onClick={(e) => e.stopPropagation()}>
        <div className="overflow-hidden rounded-2xl border border-sky-500/40 bg-slate-950 shadow-2xl">
          <div className="bg-gradient-to-b from-sky-500/20 to-transparent px-5 pb-4 pt-8 text-center">
            <p className="text-xs uppercase tracking-[0.3em] text-sky-300">{matchName}</p>
            <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">The ice is coming.</h1>
            <p className="mt-3 text-sm text-slate-300">
              {days} days from now the world north and south of 28° is frozen solid. Five families, one region, and a map that shrinks every day. Build before the ice does.
            </p>
            {speed !== 1 && <p className="mt-1 text-xs text-slate-500">This match runs at {speed}x: a game day passes every {Math.round(1440 / speed)} real minutes.</p>}
            {resourceMult !== 1 && <p className="mt-1 text-xs text-slate-500">Resources come in at {resourceMult}x: everything gathered or mined, food included, is {resourceMult} times the usual.</p>}
            <p className="mt-1 text-xs text-slate-500">When the empire outgrows your hands, the Advisors menu hires an Economic advisor to keep buildings and people up, for a steep hourly wage.</p>
          </div>

          <div className="space-y-5 px-5 pb-6 text-sm text-slate-300">
            <section>
              <h2 className="mb-2 font-semibold text-slate-100">How it plays</h2>
              <ol className="list-decimal space-y-1.5 pl-5">
                <li>
                  <b className="text-slate-100">Grow.</b> Your people gather food, wood and stone. Split them between the three in the region panel and build Huts, Farms, Lumber camps and Quarries. People eat; keep food above zero.
                </li>
                <li>
                  <b className="text-slate-100">Research.</b> Techs unlock buildings, units and new ages. Each age needs its prerequisites and has an earliest day, so queue the chain early.
                </li>
                <li>
                  <b className="text-slate-100">Spread out.</b> Train five Settlers and send them to empty land next door. Caravans, later Wagons and Trains, haul goods between your regions and feed your builds.
                </li>
                <li>
                  <b className="text-slate-100">Move south before the ice.</b> Watch the forecast line on the map. Frozen regions lose everything. Evacuate early; crowded regions spill people into neighbours on their own.
                </li>
                <li>
                  <b className="text-slate-100">Fight, or wall up.</b> Raid for loot or Conquer with soldiers and five Settlers. Walls are near-impregnable to men alone, so bring siege engines. Lose your capital and you are out, and whoever took it takes every region you held.
                </li>
                <li>
                  <b className="text-slate-100">Raid the neutrals first.</b> While other players are protected, the neutral tribes are not: each holds a hoard of copper, tin or iron behind a few warriors. A dozen early soldiers bring home the metal that opens the next age.
                </li>
              </ol>
            </section>

            <section>
              <h2 className="mb-2 font-semibold text-slate-100">Ways to win</h2>
              <ul className="space-y-1.5">
                <li className="rounded-md border border-slate-800 px-3 py-2">
                  <b className="text-amber-200">The Last Thaw.</b> When the ice stops on day {days}, the player with the most people alive in unfrozen land wins.
                </li>
                <li className="rounded-md border border-slate-800 px-3 py-2">
                  <b className="text-amber-200">The Great Hearth.</b> A wonder only your capital can raise, from the Medieval Age. Three days and the wealth of an empire; everyone hears when you begin. Finish it and you win on the spot.
                </li>
                <li className="rounded-md border border-slate-800 px-3 py-2">
                  <b className="text-amber-200">Dominion.</b> Hold {Math.round(balance.win.regionShareForEarlyWin * 100)}% of all regions, alone or as an alliance, for {balance.win.holdHours} hours.
                </li>
              </ul>
              <p className="mt-2 text-xs text-slate-500">Score ranks everyone below the winner: regions, people, age, plus bonuses for being first to each age, the first Harbor, Temple and Train, and the first to begin the Hearth.</p>
            </section>

            <div className="flex flex-wrap justify-center gap-2">
              <Link to="/how-to-play">
                <Button variant="ghost">Full guide</Button>
              </Link>
              <Button onClick={onClose}>Let's go</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

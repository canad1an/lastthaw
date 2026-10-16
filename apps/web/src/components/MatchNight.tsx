import { useEffect, useMemo, useState } from "react";
import { formatCountdown } from "@lastthaw/shared";
import { Button } from "./ui.js";

const SEEN = (id: string) => `lt-night-seen:${id}`;
export const NIGHT_HOURS = 2;

/** True while the winter night is on: the two hours after the match ends, unless this device has already left it. */
export function useWinterNight(matchId: string, finishedAt: string | null): [boolean, () => void] {
  const [left, setLeft] = useState(false);
  useEffect(() => {
    try {
      setLeft(localStorage.getItem(SEEN(matchId)) === "1");
    } catch {
      setLeft(false);
    }
  }, [matchId]);
  const active = !!finishedAt && !left && Date.now() < Date.parse(finishedAt) + NIGHT_HOURS * 3600_000;
  const leave = () => {
    setLeft(true);
    try {
      localStorage.setItem(SEEN(matchId), "1");
    } catch {
      /* private mode */
    }
  };
  return [active, leave];
}

/**
 * The winter night: for two hours after day 30 the map lies under a dark veil
 * and falling snow. "The ice has stopped." The winner's name fades in after
 * half a minute; the report is one click away at any time.
 */
export function MatchNight({ finishedAt, winnerName, matchName, onReport }: { finishedAt: string; winnerName: string | null; matchName: string; onReport: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const since = (now - Date.parse(finishedAt)) / 1000;
  const until = Math.max(0, NIGHT_HOURS * 3600 - since);
  const flakes = useMemo(() => Array.from({ length: 80 }, (_, i) => ({ i, left: Math.random() * 100, delay: Math.random() * 12, dur: 9 + Math.random() * 10, size: 2 + Math.random() * 4, drift: (Math.random() - 0.5) * 60 })), []);
  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center overflow-hidden bg-[#061021]/85 backdrop-blur-[1px]">
      <style>{`@keyframes lt-snow { 0% { transform: translate(0, -5vh); opacity: 0 } 10% { opacity: .9 } 100% { transform: translate(var(--drift), 105vh); opacity: .2 } } @keyframes lt-fade { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }`}</style>
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        {flakes.map((f) => (
          <span key={f.i} style={{ left: `${f.left}%`, width: f.size, height: f.size, animation: `lt-snow ${f.dur}s linear ${f.delay}s infinite`, ["--drift" as string]: `${f.drift}px` }} className="absolute top-0 block rounded-full bg-sky-100/90 motion-reduce:hidden" />
        ))}
      </div>
      <div className="relative mx-4 max-w-xl text-center" style={{ animation: "lt-fade 1.5s ease-out both" }}>
        <p className="text-xs uppercase tracking-[0.4em] text-sky-300">{matchName}</p>
        <h1 className="mt-3 text-4xl font-bold text-white sm:text-6xl">The ice has stopped.</h1>
        <p className="mt-4 text-base text-slate-300">Thirty days are over. The world lies still under the snow.</p>
        {winnerName && since >= 30 && (
          <p className="mt-6 text-2xl text-amber-200" style={{ animation: "lt-fade 3s ease-out both" }}>
            {winnerName} has won.
          </p>
        )}
        <p className="mt-6 text-xs text-slate-500">The night lasts {formatCountdown(until)}. The report is ready whenever you are.</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button onClick={onReport}>Open the final report</Button>
        </div>
      </div>
    </div>
  );
}

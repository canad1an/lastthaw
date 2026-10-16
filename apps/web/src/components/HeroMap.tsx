import { useEffect, useMemo, useState } from "react";
import { allRegions, balance, iceExposure } from "@lastthaw/shared";

const DAYS = balance.match.lengthDays;

/**
 * The real game map, frozen over in a loop: thirty days pass in about twenty
 * seconds, the ice marching in from both poles, then the month starts again.
 * Captions the day and the ice line so the mechanic reads at a glance.
 */
export function HeroMap({ className = "" }: { className?: string }) {
  const regions = useMemo(() => allRegions(), []);
  const [day, setDay] = useState(0);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setDay(21);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const cycleMs = 24_000;
    const holdMs = 3_000;
    const tick = (t: number) => {
      const elapsed = (t - start) % (cycleMs + holdMs);
      const d = elapsed < cycleMs ? Math.round(((elapsed / cycleMs) * DAYS) * 4) / 4 : DAYS;
      setDay((prev) => (prev === d ? prev : d));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const lineLat = useMemo(() => {
    const s = balance.ice.schedule;
    let lat = s[0]!.latitude;
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1]!;
      const b = s[i]!;
      if (day <= b.day) {
        lat = a.latitude + ((b.latitude - a.latitude) * (day - a.day)) / (b.day - a.day);
        return lat;
      }
    }
    return s[s.length - 1]!.latitude;
  }, [day]);
  // Equirectangular: y = (90 - lat) / 180 * 1000.
  const yNorth = ((90 - lineLat) / 180) * 1000;
  const ySouth = ((90 + lineLat) / 180) * 1000;

  const dayNo = Math.min(DAYS, Math.floor(day) + 1);
  const frozenCount = regions.reduce((n, r) => n + (iceExposure(r, day).frozen ? 1 : 0), 0);

  return (
    <div className={`relative ${className}`}>
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-md bg-slate-950/70 px-2.5 py-1.5 text-xs text-slate-200 backdrop-blur">
        <span className="display text-sm font-semibold text-white">Day {dayNo}</span>
        <span className="text-slate-500">·</span>
        <span>ice beyond {Math.round(lineLat)}°</span>
        <span className="text-slate-500">·</span>
        <span className="tabular-nums">{frozenCount} of {regions.length} regions frozen</span>
      </div>
      <div className="absolute inset-x-3 bottom-3 z-10 h-1 overflow-hidden rounded bg-slate-800/80">
        <div className="h-full bg-sky-300/80" style={{ width: `${(day / DAYS) * 100}%` }} />
      </div>
    <svg viewBox="0 120 2000 760" className="block h-full w-full" role="img" aria-label="The world map freezing over thirty days">
      <defs>
        <linearGradient id="hm-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0e2a44" />
          <stop offset="1" stopColor="#0a1f33" />
        </linearGradient>
        <linearGradient id="hm-iceN" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dff1fb" stopOpacity="0.55" />
          <stop offset="1" stopColor="#dff1fb" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="hm-iceS" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#dff1fb" stopOpacity="0.55" />
          <stop offset="1" stopColor="#dff1fb" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="2000" height="1000" fill="url(#hm-sea)" />
      {/* frozen sea */}
      <rect x="0" y={yNorth - 60} width="2000" height="60" fill="url(#hm-iceN)" />
      <rect x="0" y="0" width="2000" height={Math.max(0, yNorth - 60)} fill="#dff1fb" fillOpacity="0.55" />
      <rect x="0" y={ySouth} width="2000" height="60" fill="url(#hm-iceS)" />
      <rect x="0" y={ySouth + 60} width="2000" height={Math.max(0, 1000 - ySouth - 60)} fill="#dff1fb" fillOpacity="0.55" />
      {regions.map((r) => {
        const e = iceExposure(r, day);
        const cls = e.frozen ? "region-ice" : e.touched ? "region-edge" : "region-land";
        return <path key={r.id} d={r.path} className={cls} />;
      })}
      {/* ice lines */}
      <line x1="0" x2="2000" y1={yNorth} y2={yNorth} stroke="#f0f9ff" strokeWidth="2" strokeDasharray="14 10" opacity="0.8" />
      <line x1="0" x2="2000" y1={ySouth} y2={ySouth} stroke="#f0f9ff" strokeWidth="2" strokeDasharray="14 10" opacity="0.8" />
    </svg>
    </div>
  );
}

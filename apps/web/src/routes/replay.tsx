import { useQuery } from "@tanstack/react-query";
import { MapScope } from "../map/activeMap.js";
import type { MapId } from "@lastthaw/shared";
import { usePageMeta, useSlugAddress } from "../seo.js";
import { Link, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { balance, iceLatitudeOnDay, type MapRegion } from "@lastthaw/shared";
import { WorldMap, terrainFill, type RegionPaint } from "../map/WorldMap.js";
import { Button } from "../components/ui.js";

interface Frame {
  day: number;
  /** Region id → player id, "ice" for frozen land, or null for abandoned. Only what changed since the last frame; the first frame is complete. */
  changes: Record<string, string | null>;
}
interface Replay {
  match: { id: string; slug?: string; name: string; status: string; speed: number; finishedAt: string | null; winnerPlayerId: string | null; map?: MapId };
  players: { id: string; name: string; isAi: boolean }[];
  frames: Frame[];
}

const COLORS = ["#38bdf8", "#f472b6", "#a3e635", "#fb923c", "#c084fc", "#2dd4bf", "#facc15", "#f87171", "#60a5fa", "#4ade80", "#e879f9", "#fbbf24", "#34d399", "#f9a8d4", "#93c5fd", "#fde68a"];
const SECONDS = 30;

/**
 * Thirty seconds for thirty days: every quarter-day frame of who held what,
 * folded onto the map in order. Public, like the report.
 */
export function ReplayPage() {
  const { matchId } = useParams({ from: "/match/$matchId/replay" });
  const q = useQuery({
    queryKey: ["replay", matchId],
    queryFn: () => fetch(`/api/matches/${matchId}/replay`, { credentials: "include" }).then((r) => r.json() as Promise<Replay>),
  });
  const data = q.data;
  useSlugAddress(matchId, data?.match?.slug, "/replay");
  usePageMeta({ title: data?.match ? `${data.match.name}: replay` : "Replay", description: data?.match ? `Watch ${data.match.name} unfold day by day: every border, every conquest and the ice closing in, in a Last Thaw replay.` : undefined, path: `/match/${data?.match?.slug || matchId}/replay` });
  const frames = data?.frames ?? [];
  // Fold frames once into a full owner map per frame, so scrubbing is instant.
  const states = useMemo(() => {
    const out: Array<Map<string, string | null>> = [];
    let cur = new Map<string, string | null>();
    for (const f of frames) {
      cur = new Map(cur);
      for (const [rid, pid] of Object.entries(f.changes)) {
        if (pid === null) cur.delete(rid);
        else cur.set(rid, pid);
      }
      out.push(cur);
    }
    return out;
  }, [frames]);
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    (data?.players ?? []).forEach((p, i) => m.set(p.id, COLORS[i % COLORS.length]!));
    return (id: string) => m.get(id) ?? "#94a3b8";
  }, [data?.players]);

  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const raf = useRef<number | null>(null);
  const startRef = useRef<{ t: number; from: number } | null>(null);
  const last = Math.max(0, frames.length - 1);
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const perFrame = (SECONDS * 1000) / frames.length;
    startRef.current = { t: performance.now(), from: i >= last ? 0 : i };
    const step = (t: number) => {
      const s = startRef.current!;
      const idx = Math.min(last, s.from + Math.floor((t - s.t) / perFrame));
      setI(idx);
      if (idx >= last) {
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
    // Restarting on `i` would fight the animation; it only restarts when play is toggled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, frames.length]);

  const state = states[i];
  const day = frames[i]?.day ?? 0;
  const paint = useCallback(
    (r: MapRegion): RegionPaint => {
      const owner = state?.get(r.id);
      if (owner === "ice") return { fill: "#e0f2fe", opacity: 0.8 };
      if (owner) return { fill: colorOf(owner), opacity: 1 };
      return { fill: terrainFill(r.terrain), opacity: 0.35 };
    },
    [state, colorOf],
  );
  // Standings at this frame: regions per player, top eight.
  const standings = useMemo(() => {
    const n = new Map<string, number>();
    if (state) for (const pid of state.values()) if (pid && pid !== "ice") n.set(pid, (n.get(pid) ?? 0) + 1);
    return [...n.entries()]
      .map(([id, regions]) => ({ id, regions, name: data?.players.find((p) => p.id === id)?.name ?? "?" }))
      .sort((a, b) => b.regions - a.regions)
      .slice(0, 8);
  }, [state, data?.players]);

  if (q.isError || (data && !("frames" in data))) return <main className="mx-auto max-w-3xl px-4 py-10 text-slate-300">No match with that id.</main>;
  return (
    <main className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2 text-sm">
        <span className="font-medium text-slate-100">{data?.match.name ?? "Replay"}</span>
        <span className="text-slate-500">· day {day.toFixed(1)} of {balance.match.lengthDays}</span>
        <span className="text-slate-500">· ice beyond {iceLatitudeOnDay(day).toFixed(0)}°</span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={() => { if (i >= last) setI(0); setPlaying((p) => !p); }} disabled={frames.length < 2}>
            {playing ? "Pause" : i >= last ? "Replay" : "Play"}
          </Button>
          <Link to="/match/$matchId/report" params={{ matchId }}>
            <Button variant="ghost">Review</Button>
          </Link>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <MapScope map={data?.match.map ?? "earth"} fallback={<p className="p-6 text-slate-400">Loading the map...</p>}>
          <WorldMap paint={paint} selected={null} onSelect={() => {}} className="h-full w-full" ice={{ latitude: iceLatitudeOnDay(day), forecast: false, day }} />
        </MapScope>
        {frames.length < 2 && (
          <div className="pointer-events-none absolute inset-x-0 top-3 text-center text-sm text-amber-200">
            {frames.length === 0 ? "No replay was recorded for this match." : "Only the final positions were recorded for this match; replays are kept for every match from now on."}
          </div>
        )}
        <div className="pointer-events-none absolute bottom-3 left-3 space-y-0.5 rounded-md bg-slate-950/80 p-2 text-xs">
          {standings.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colorOf(s.id) }} />
              <span className={`w-28 truncate ${s.id === data?.match.winnerPlayerId ? "text-amber-200" : "text-slate-200"}`}>{s.name}</span>
              <span className="tabular-nums text-slate-400">{s.regions}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-slate-800 px-3 py-2">
        <input
          type="range"
          min={0}
          max={last}
          value={i}
          onChange={(e) => {
            setPlaying(false);
            setI(Number(e.target.value));
          }}
          className="h-2 w-full accent-sky-400"
          aria-label="Replay position"
        />
        <span className="w-20 shrink-0 text-right text-xs tabular-nums text-slate-400">day {day.toFixed(1)}</span>
      </div>
    </main>
  );
}

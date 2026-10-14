import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { allRegions, balance, freezeDayForLatitude, iceLatitudeOnDay, world, type MapRegion } from "@lastthaw/shared";

export type RegionPaint = {
  fill?: string;
  stroke?: string;
  opacity?: number;
};

export interface WorldMapProps {
  /** Per-region overrides; absent regions use terrain colors dimmed by fog. */
  paint: (r: MapRegion) => RegionPaint;
  selected: string | null;
  onSelect: (regionId: string | null) => void;
  /** Region id to center on when it changes (e.g. the capital). */
  focus?: string | null;
  className?: string;
  /** Ice: current edge latitude, and whether to shade the forecast (day each region freezes). */
  ice?: { latitude: number; forecast: boolean; day: number };
  /** Region ids to mark with a flag (the player's capital). */
  flags?: string[];
  /** Region ids drawn with an "unclaimed" dashed outline. */
  dashed?: string[];
}

const TERRAIN_FILL: Record<string, string> = {
  plains: "#6b8f3a",
  forest: "#2f6b3a",
  hills: "#8a7a44",
  mountains: "#6e6a66",
  desert: "#c9a85c",
  tundra: "#9fb3bd",
  wetland: "#3f7f6f",
};

export function terrainFill(terrain: string): string {
  return TERRAIN_FILL[terrain] ?? "#777";
}

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 1;
const MAX_K = 14;

/**
 * SVG world map with pointer pan, wheel/pinch zoom and click selection.
 * Rendering ~400 paths is cheap; the expensive part is re-rendering on every
 * state change, so the static layer is memoized and only the paint changes.
 */
export function WorldMap({ paint, selected, onSelect, focus, className = "", ice, flags = [], dashed = [] }: WorldMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const pinch = useRef<Map<number, { x: number; y: number }>>(new Map());
  const W = world.width;
  const H = world.height;

  const clampView = useCallback(
    (v: View): View => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k));
      const maxX = 0;
      const minX = W - W * k;
      const maxY = 0;
      const minY = H - H * k;
      return { k, x: Math.min(maxX, Math.max(minX, v.x)), y: Math.min(maxY, Math.max(minY, v.y)) };
    },
    [W, H],
  );

  // Convert a client point to map (unscaled viewBox) coordinates.
  const toMap = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    return { x: ((clientX - rect.left) / rect.width) * W, y: ((clientY - rect.top) / rect.height) * H };
  }, [W, H]);

  const zoomAt = useCallback(
    (mx: number, my: number, factor: number) => {
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
        const ratio = k / v.k;
        return clampView({ k, x: mx - (mx - v.x) * ratio, y: my - (my - v.y) * ratio });
      });
    },
    [clampView],
  );

  useEffect(() => {
    if (!focus) return;
    const r = allRegions().find((x) => x.id === focus);
    if (!r) return;
    const k = 4;
    setView(clampView({ k, x: W / 2 - r.x * k, y: H / 2 - r.y * k }));
  }, [focus, clampView, W, H]);

  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const { x, y } = toMap(e.clientX, e.clientY);
    zoomAt(x, y, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current.size === 1) {
      drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (pinch.current.has(e.pointerId)) {
      const prev = [...pinch.current.values()];
      pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.current.size === 2) {
        const cur = [...pinch.current.values()];
        const d0 = Math.hypot(prev[0]!.x - prev[1]!.x, prev[0]!.y - prev[1]!.y);
        const d1 = Math.hypot(cur[0]!.x - cur[1]!.x, cur[0]!.y - cur[1]!.y);
        if (d0 > 0) {
          const c = toMap((cur[0]!.x + cur[1]!.x) / 2, (cur[0]!.y + cur[1]!.y) / 2);
          zoomAt(c.x, c.y, d1 / d0);
        }
        drag.current = null;
        return;
      }
    }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const dx = ((e.clientX - d.sx) / rect.width) * W;
    const dy = ((e.clientY - d.sy) / rect.height) * H;
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true;
    setView((v) => clampView({ ...v, x: d.ox + dx, y: d.oy + dy }));
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    pinch.current.delete(e.pointerId);
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      drag.current = null;
      if (!d.moved) {
        const target = (e.target as Element).closest("[data-region]");
        onSelect(target ? (target.getAttribute("data-region") ?? null) : null);
      }
    }
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className={`touch-none select-none bg-[#0b1a2b] ${className}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        <Regions paint={paint} selected={selected} strokeWidth={0.8 / view.k} />
        {ice && <IceLayer ice={ice} k={view.k} />}
        <g pointerEvents="none">
          {dashed.map((id) => {
            const r = allRegions().find((x) => x.id === id);
            return r ? <path key={id} d={r.path} fill="none" stroke="#fde68a" strokeWidth={1.2 / view.k} strokeDasharray={`${4 / view.k} ${3 / view.k}`} /> : null;
          })}
          {flags.map((id) => {
            const r = allRegions().find((x) => x.id === id);
            if (!r) return null;
            const s = 1 / view.k;
            return (
              <g key={id} transform={`translate(${r.x} ${r.y}) scale(${s})`}>
                <line x1={0} y1={0} x2={0} y2={-22} stroke="#0f172a" strokeWidth={3.5} />
                <line x1={0} y1={0} x2={0} y2={-22} stroke="#f8fafc" strokeWidth={1.5} />
                <path d="M0 -22 L14 -17 L0 -12 Z" fill="#f59e0b" stroke="#0f172a" strokeWidth={0.8} />
                <circle cx={0} cy={0} r={2.2} fill="#f8fafc" stroke="#0f172a" strokeWidth={0.8} />
              </g>
            );
          })}
        </g>
      </g>
    </svg>
  );
}

/**
 * Ice overlay: frozen regions are washed out in white; in forecast mode every
 * region is tinted by the day it freezes (soon = bright, never = none). The
 * current ice edge is drawn as two dashed lines.
 */
const IceLayer = memo(function IceLayer({ ice, k: zoom }: { ice: { latitude: number; forecast: boolean; day: number }; k: number }) {
  const H = world.height;
  const W = world.width;
  const yN = ((90 - ice.latitude) / 180) * H;
  const yS = ((90 + ice.latitude) / 180) * H;
  // Sizes are divided by the zoom so lines and labels stay the same size on screen.
  const px = (n: number) => n / zoom;
  return (
    <g pointerEvents="none">
      {allRegions().map((r) => {
        const frozen = Math.abs(r.lat) >= ice.latitude;
        if (frozen) return <path key={r.id} d={r.path} fill="#e0f2fe" fillOpacity={0.75} />;
        if (!ice.forecast) return null;
        const day = freezeDayForLatitude(Math.abs(r.lat));
        if (day === null) return null;
        const soon = Math.max(0, 1 - (day - ice.day) / 20);
        return <path key={r.id} d={r.path} fill="#7dd3fc" fillOpacity={0.1 + soon * 0.35} />;
      })}
      <line x1={0} x2={W} y1={yN} y2={yN} stroke="#e0f2fe" strokeDasharray={`${px(6)} ${px(4)}`} strokeWidth={px(1.5)} />
      <line x1={0} x2={W} y1={yS} y2={yS} stroke="#e0f2fe" strokeDasharray={`${px(6)} ${px(4)}`} strokeWidth={px(1.5)} />
      {ice.forecast &&
        [1, 2, 3, 4, 5].map((d) => {
          const day = Math.floor(ice.day) + d;
          if (day > balance.match.lengthDays) return null;
          const lat = iceLatitudeOnDay(day);
          const n = ((90 - lat) / 180) * H;
          const s = ((90 + lat) / 180) * H;
          // Each day's label sits further along its line so close lines never overlap.
          const labelX = px(8 + (d - 1) * 78);
          return (
            <g key={d} opacity={0.95 - d * 0.1}>
              <line x1={0} x2={W} y1={n} y2={n} stroke="#7dd3fc" strokeDasharray={`${px(3)} ${px(5)}`} strokeWidth={px(1)} />
              <line x1={0} x2={W} y1={s} y2={s} stroke="#7dd3fc" strokeDasharray={`${px(3)} ${px(5)}`} strokeWidth={px(1)} />
              {[n, s].flatMap((y, i) =>
                [0, 1, 2, 3].map((j) => (
                <text key={`${i}-${j}`} x={labelX + (j * W) / 4} y={y - px(3)} fill="#e0f2fe" fontSize={px(11)} fontWeight={600} fontFamily="ui-sans-serif, system-ui" paintOrder="stroke" stroke="#0b1a2b" strokeWidth={px(3)}>
                  Day {day} · {lat.toFixed(0)}°
                </text>
                )),
              )}
            </g>
          );
        })}
    </g>
  );
});

const Regions = memo(function Regions({ paint, selected, strokeWidth }: { paint: (r: MapRegion) => RegionPaint; selected: string | null; strokeWidth: number }) {
  const regions = allRegions();
  return (
    <>
      {regions.map((r) => {
        const p = paint(r);
        const isSel = r.id === selected;
        return (
          <path
            key={r.id}
            data-region={r.id}
            d={r.path}
            fill={p.fill ?? terrainFill(r.terrain)}
            fillOpacity={p.opacity ?? 1}
            stroke={isSel ? "#ffffff" : (p.stroke ?? "#0b1a2b")}
            strokeWidth={isSel ? strokeWidth * 2.5 : strokeWidth}
            strokeLinejoin="round"
            className="cursor-pointer"
          >
            <title>{r.name}</title>
          </path>
        );
      })}
      {selected && <path d={regions.find((r) => r.id === selected)?.path ?? ""} fill="none" stroke="#fff" strokeWidth={strokeWidth * 2.5} pointerEvents="none" />}
    </>
  );
});

import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { allRegions, balance, freezeDayForLatitude, iceExposure, iceLatitudeOnDay, world, type MapRegion, regionById } from "@lastthaw/shared";
import type { ArmyMarker } from "./armyMarkers.js";

export type RegionPaint = {
  fill?: string;
  stroke?: string;
  opacity?: number;
  /** Border thickness multiplier (walls). */
  strokeScale?: number;
  /** Dash pattern in map units, scaled with zoom (palisades). */
  dash?: [number, number];
  /** A second, thinner inner line (castles and bunkers). */
  inner?: string;
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
  /** Armies to draw as moving markers. */
  armies?: ArmyMarker[];
  /** Road or rail links to draw between adjacent regions: [a, b, colour, kind]. */
  roads?: Array<[string, string, string, "road" | "rail"]>;
  /** Overlay badges (View menu): small glyph markers at region centres. */
  badges?: Array<{ regionId: string; colour: string; glyph: string; label: string }>;
}

/** Missions drawn as military (orange, sword) rather than civil traffic. */
const MILITARY = new Set(["raid", "conquer", "reinforce", "patrol"]);

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
export function WorldMap({ paint, selected, onSelect, focus, className = "", ice, flags = [], dashed = [], armies = [], roads = [], badges = [] }: WorldMapProps) {
  const [hoverArmy, setHoverArmy] = useState<string | null>(null);
  const [routeArmy, setRouteArmy] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  // Map units per screen pixel at zoom 1, so overlays can be sized in real pixels.
  const [unitsPerPx, setUnitsPerPx] = useState(2.5);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => setUnitsPerPx(world.width / Math.max(1, svg.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);
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
        const armyEl = (e.target as Element).closest("[data-army]");
        if (armyEl) {
          const id = armyEl.getAttribute("data-army");
          setRouteArmy((cur) => (cur === id ? null : id));
          // Touch screens have no hover: a tap also shows the card until the next tap.
          setHoverArmy((cur) => (cur === id && routeArmy === id ? null : id));
          return;
        }
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
        {ice && <IceLayer ice={ice} k={view.k / unitsPerPx} />}
        <g pointerEvents="none">
          {dashed.map((id) => {
            const r = allRegions().find((x) => x.id === id);
            const u = unitsPerPx / view.k;
            return r ? <path key={id} d={r.path} fill="none" stroke="#fde68a" strokeWidth={1.2 * u} strokeDasharray={`${4 * u} ${3 * u}`} /> : null;
          })}
          {armies.map((a) => {
            const u = unitsPerPx / view.k;
            const showRoute = routeArmy === a.id && a.route.length > 1;
            return (
              <g key={a.id}>
                {showRoute && (
                  <>
                    {(() => {
                      const dest = allRegions().find((x) => x.id === a.destinationId);
                      return dest ? <path d={dest.path} fill={a.hostile ? "#f43f5e" : "#38bdf8"} fillOpacity={0.25} stroke={a.hostile ? "#f43f5e" : "#38bdf8"} strokeWidth={1.5 * u} /> : null;
                    })()}
                    <polyline points={a.route.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#0b1a2b" strokeWidth={5 * u} strokeLinejoin="round" strokeLinecap="round" opacity={0.8} />
                    <polyline points={a.route.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={a.hostile ? "#f43f5e" : "#7dd3fc"} strokeWidth={2.5 * u} strokeDasharray={`${8 * u} ${5 * u}`} strokeLinejoin="round" strokeLinecap="round" />
                    {a.route.map((p, i) => (
                      <circle key={i} cx={p.x} cy={p.y} r={3 * u} fill="#0b1a2b" stroke="#7dd3fc" strokeWidth={1.5 * u} />
                    ))}
                  </>
                )}
              </g>
            );
          })}
          {roads.map(([a, b, colour, kind]) => {
            const ra = regionById(a);
            const rb = regionById(b);
            if (!ra || !rb) return null;
            const w = (unitsPerPx / view.k) * (kind === "rail" ? 2.2 : 1.6);
            return (
              <g key={`${kind}-${a}-${b}`}>
                <line x1={ra.x} y1={ra.y} x2={rb.x} y2={rb.y} stroke="#0f172a" strokeWidth={w * 1.9} strokeLinecap="round" opacity={0.7} />
                {kind === "rail" ? (
                  <>
                    <line x1={ra.x} y1={ra.y} x2={rb.x} y2={rb.y} stroke={colour} strokeWidth={w} strokeLinecap="round" />
                    <line x1={ra.x} y1={ra.y} x2={rb.x} y2={rb.y} stroke="#0f172a" strokeWidth={w * 0.5} strokeDasharray={`${w * 0.8} ${w * 1.6}`} />
                  </>
                ) : (
                  <line x1={ra.x} y1={ra.y} x2={rb.x} y2={rb.y} stroke={colour} strokeWidth={w} strokeLinecap="round" strokeDasharray={`${w * 3} ${w * 1.5}`} />
                )}
              </g>
            );
          })}
          {badges.map((b, i) => {
            const r = regionById(b.regionId);
            if (!r) return null;
            // Fan several badges on one region around its centre so each stays visible.
            const k = badges.slice(0, i).filter((x) => x.regionId === b.regionId).length;
            const s = unitsPerPx / view.k;
            const dx = 9 + k * 11;
            return (
              <g key={`${b.regionId}-${i}`} transform={`translate(${r.x} ${r.y}) scale(${s})`} pointerEvents="auto">
                <title>{b.label}</title>
                <circle cx={dx} cy={-9} r={5.5} fill={b.colour} stroke="#0b1a2b" strokeWidth={1.2} />
                <text x={dx} y={-9} textAnchor="middle" dominantBaseline="central" fontSize={7} fontWeight={700} fill="#0b1a2b">
                  {b.glyph}
                </text>
              </g>
            );
          })}
          {flags.map((id) => {
            const r = allRegions().find((x) => x.id === id);
            if (!r) return null;
            const s = unitsPerPx / view.k;
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
        <g>
          {armies.map((a) => {
            const s = unitsPerPx / view.k;
            return (
              <g
                key={a.id}
                data-army={a.id}
                transform={`translate(${a.x} ${a.y}) scale(${s})`}
                className="cursor-pointer"
                onPointerEnter={() => setHoverArmy(a.id)}
                onPointerLeave={() => setHoverArmy((h) => (h === a.id ? null : h))}
              >
                {a.hostile && <circle r={11} fill="none" stroke="#f43f5e" strokeWidth={1.5} className="animate-ping" />}
                {a.mission === "relocate" ? (
                  <g>
                    <circle r={12} fill="#f59e0b" stroke="#0b1a2b" strokeWidth={1.8} />
                    <path d="M-7 2h9l2.5-4.5H7V2h-1.5" fill="none" stroke="#0b1a2b" strokeWidth={1.4} strokeLinejoin="round" />
                    <rect x={-7} y={-4} width={8.5} height={6} rx={1} fill="#0b1a2b" opacity={0.5} />
                    <circle cx={-4} cy={5} r={1.8} fill="none" stroke="#0b1a2b" strokeWidth={1.3} />
                    <circle cx={4} cy={5} r={1.8} fill="none" stroke="#0b1a2b" strokeWidth={1.3} />
                  </g>
                ) : (
                  // Enemy attacks pulse rose; my own military (raid, conquer, reinforce) is orange with a sword; civil traffic is blue.
                  <circle r={7} fill={a.hostile ? "#f43f5e" : MILITARY.has(a.mission) ? "#f97316" : "#38bdf8"} stroke="#0b1a2b" strokeWidth={1.5} />
                )}
                {a.mission !== "relocate" &&
                  (a.hostile || MILITARY.has(a.mission) ? (
                    <g stroke="#0b1a2b" strokeWidth={1.4} strokeLinecap="round" fill="none">
                      <path d="M-3.2 3.2L3.4 -3.4" />
                      <path d="M3.4 -3.4l1.2 -1.2" strokeWidth={1.8} />
                      <path d="M-3.6 0.6L-0.6 3.6" />
                      <path d="M-4.2 4.2l-0.8 0.8" strokeWidth={2} />
                    </g>
                  ) : (
                    <path d={a.mission === "transport" ? "M-3.5 -1h7v4h-7z M-2 -3h4v2h-4z" : a.mission === "settle" ? "M-4 2h8v1h-8z M-3 2v-4l3-2 3 2v4" : "M-3 3L3 -3 M3 -3h-2.5 M3 -3v2.5"} fill={a.mission === "transport" || a.mission === "settle" ? "#0b1a2b" : "none"} stroke="#0b1a2b" strokeWidth={1.4} strokeLinecap="round" />
                  ))}
              </g>
            );
          })}
        </g>
      </g>
      {hoverArmy && (() => {
        const a = armies.find((x) => x.id === hoverArmy);
        if (!a) return null;
        const sx = ((a.x * view.k + view.x) / world.width) * 100;
        const sy = ((a.y * view.k + view.y) / world.height) * 100;
        return (
          <foreignObject x={0} y={0} width={world.width} height={world.height} pointerEvents="none">
            <div style={{ position: "absolute", left: `${sx}%`, top: `${sy}%`, transform: "translate(12px, -50%)" }} className="pointer-events-none w-max max-w-[16rem] rounded-md border border-slate-700 bg-slate-950/95 px-2 py-1.5 text-xs text-slate-200 shadow-xl">
              <p className="font-medium">{a.title}</p>
              {a.lines.map((l) => (
                <p key={l} className="text-slate-400">
                  {l}
                </p>
              ))}
              {a.routeNames.length > 1 && <p className="text-slate-500">via {a.routeNames.join(" → ")}</p>}
              <p className="text-slate-500">{routeArmy === a.id ? "click to hide route" : "click to show route"}</p>
            </div>
          </foreignObject>
        );
      })()}
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
        const exp = iceExposure(r, ice.day);
        if (exp.frozen) return <path key={r.id} d={r.path} fill="#e0f2fe" fillOpacity={0.75} />;
        if (exp.touched) return <path key={r.id} d={r.path} fill="#e0f2fe" fillOpacity={0.2 + 0.4 * (1 - exp.factor)} />;
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
            strokeWidth={isSel ? strokeWidth * 2.5 : strokeWidth * (p.strokeScale ?? 1)}
            strokeDasharray={p.dash ? `${p.dash[0] * strokeWidth} ${p.dash[1] * strokeWidth}` : undefined}
            strokeLinejoin="round"
            className="cursor-pointer"
          >
            <title>{r.name}</title>
          </path>
        );
      })}
      {regions.map((r) => {
        const p = paint(r);
        if (!p.inner) return null;
        return <path key={`${r.id}-inner`} d={r.path} fill="none" stroke={p.inner} strokeWidth={strokeWidth * 0.9} strokeLinejoin="round" pointerEvents="none" />;
      })}
      {selected && <path d={regions.find((r) => r.id === selected)?.path ?? ""} fill="none" stroke="#fff" strokeWidth={strokeWidth * 2.5} pointerEvents="none" />}
    </>
  );
});

import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { allRegions, balance, freezeDayForLatitude, iceExposure, iceLatitudeOnDay, world, type MapRegion, regionById } from "@lastthaw/shared";
import type { ArmyMarker } from "./armyMarkers.js";
import { UnitIcon, UnitStrokes, unitPicture } from "../components/UnitIcon.js";
import coastPoints from "./coastPoints.json";

/** Where a region meets the sea: a point on its outline mid-shore, computed from the map (tools: coast-points). */
const COAST: Record<string, { x: number; y: number; a: number } | undefined> = coastPoints as Record<string, { x: number; y: number; a: number }>;
import { unitById } from "@lastthaw/shared";

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
  /** Centre on this region and flash its outline for a moment; the counter lets the same region be flown to twice. */
  flyTo?: { id: string; n: number } | null;
  className?: string;
  /** Ice: current edge latitude, and whether to shade the forecast (day each region freezes). */
  ice?: { latitude: number; forecast: boolean; day: number };
  /** Region ids to mark with a flag (the player's capital). */
  flags?: string[];
  /** Region ids with a harbour: drawn on the region's shore, on the water side. */
  harbors?: string[];
  /** Region ids drawn with an "unclaimed" dashed outline. */
  dashed?: string[];
  /** Armies to draw as moving markers. */
  armies?: ArmyMarker[];
  /** Road or rail links to draw between adjacent regions: [a, b, colour, kind]. */
  roads?: Array<[string, string, string, "road" | "rail"]>;
  /** Overlay badges (View menu): small glyph markers at region centres; a pulsing one is clickable when it carries an action. */
  badges?: Array<{ regionId: string; colour: string; glyph: string; label: string; pulse?: boolean; battleId?: string }>;
  onBadgeClick?: (badge: { regionId: string; battleId?: string }) => void;
  /** Regions in a blizzard right now: drawn with a white hatch. */
  storms?: string[];
  /** Thaw pockets: amber outline until the ice finally takes them. */
  thaws?: Array<{ regionId: string; until: string }>;
}

/** Missions drawn as military (orange, sword) rather than civil traffic. */
const MILITARY = new Set(["raid", "conquer", "reinforce", "patrol"]);

/** Each kind in a convoy with its picture and count, for the cards. */
function UnitChips({ units, size = "h-12 w-12" }: { units: Record<string, number>; size?: string }) {
  const kinds = Object.entries(units).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (kinds.length === 0) return null;
  return (
    <div className="my-1.5 flex flex-wrap gap-2">
      {kinds.map(([id, n]) => {
        const u = unitById.get(id);
        return (
          <div key={id} className="flex items-center gap-1.5 rounded border border-slate-800 bg-slate-900/80 px-1.5 py-1">
            <UnitIcon id={id} className={`${size} text-slate-200`} />
            <span className="text-sm">
              <span className="font-semibold text-white">{n.toLocaleString("en-US")}</span> {u?.name ?? id}
              {n === 1 ? "" : "s"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** More than one kind on foot or wheels together. A ship or an aircraft carrying the rest is not mixed: it shows as itself. */
function isMixed(a: ArmyMarker): boolean {
  return a.kinds.length > 1 && !a.kinds.some((id) => unitById.get(id)?.naval || unitById.get(id)?.air);
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
/** Moving units are drawn this much larger than their base art: caravans and settlers must read at a glance on a phone. */
const MARKER_SCALE = 1.75;
/** Overlay badges (soldiers, caravans, notes) grow a little less, so several on one region still fit. */
const BADGE_SCALE = 1.4;
/** A battle's crossed swords are drawn this many times larger than other badges, so a fight is seen from anywhere on the map. */
const BATTLE_BADGE_SCALE = 5;
// Phones pinch in close to pick out one province among many; the limit used to stop well short of that.
const MAX_K = 28;

/**
 * SVG world map with pointer pan, wheel/pinch zoom and click selection.
 * Rendering ~400 paths is cheap; the expensive part is re-rendering on every
 * state change, so the static layer is memoized and only the paint changes.
 */
export function WorldMap({ paint, selected, onSelect, focus, flyTo, className = "", ice, flags = [], harbors = [], dashed = [], armies = [], roads = [], badges = [], storms = [], thaws = [], onBadgeClick }: WorldMapProps) {
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

  // A message's Open region: centre the map on it (zooming in if the view is wide) and flash the outline so the eye lands on it.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flyTo) return;
    const r = allRegions().find((x) => x.id === flyTo.id);
    if (!r) return;
    setView((v) => {
      const k = Math.max(v.k, 4);
      return clampView({ k, x: W / 2 - r.x * k, y: H / 2 - r.y * k });
    });
    setFlash(flyTo.id);
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flyTo, clampView, W, H]);

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
        setRouteArmy(null);
        setHoverArmy(null);
        const target = (e.target as Element).closest("[data-region]");
        onSelect(target ? (target.getAttribute("data-region") ?? null) : null);
      }
    }
  };

  return (
    <>
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
      <defs>
        <pattern id="lt-storm" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={6} stroke="#e0f2fe" strokeWidth={2} opacity={0.75} />
        </pattern>
      </defs>
      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        <Regions paint={paint} selected={selected} strokeWidth={0.8 / view.k} />
        {flash && <path d={allRegions().find((r) => r.id === flash)?.path ?? ""} fill="#fbbf24" stroke="#fde68a" strokeWidth={3 / view.k} strokeLinejoin="round" pointerEvents="none" className="region-flash" />}
        {badges.filter((b) => b.battleId).map((b) => {
          // A battle in progress: the whole region flashes red until the last round.
          const r = regionById(b.regionId);
          return r ? <path key={`battle-${b.battleId}`} d={r.path} fill="#f43f5e" stroke="#fb7185" strokeWidth={2.4 / view.k} strokeLinejoin="round" pointerEvents="none" className="region-battle" /> : null;
        })}
        {storms.map((id) => {
          const r = regionById(id);
          return r ? <path key={`storm-${id}`} d={r.path} fill="url(#lt-storm)" pointerEvents="none" /> : null;
        })}
        {thaws.map((t) => {
          const r = regionById(t.regionId);
          return r ? <path key={`thaw-${t.regionId}`} d={r.path} fill="#fbbf24" fillOpacity={0.18} stroke="#fbbf24" strokeWidth={2.4 / view.k} strokeDasharray={`${5 / view.k} ${3 / view.k}`} pointerEvents="none" /> : null;
        })}
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
            // A battle's crossed swords sit large on the region's centre; the rest fan out beside it.
            const battle = !!b.battleId;
            const k = badges.slice(0, i).filter((x) => x.regionId === b.regionId && !x.battleId).length;
            const s = (unitsPerPx / view.k) * BADGE_SCALE * (battle ? BATTLE_BADGE_SCALE : 1);
            const dx = battle ? 0 : 9 + k * 11;
            return (
              <g
                key={`${b.regionId}-${i}`}
                transform={`translate(${r.x} ${r.y}) scale(${s})`}
                pointerEvents="auto"
                className={b.battleId ? "cursor-pointer" : undefined}
                onClick={(e) => {
                  if (!b.battleId || !onBadgeClick) return;
                  e.stopPropagation();
                  onBadgeClick({ regionId: b.regionId, battleId: b.battleId });
                }}
              >
                <title>{b.label}</title>
                {b.pulse && <circle cx={dx} cy={battle ? 0 : -9} r={8} fill="none" stroke={b.colour} strokeWidth={1.5} className="animate-ping" />}
                <circle cx={dx} cy={battle ? 0 : -9} r={b.pulse ? 7 : 5.5} fill={b.colour} stroke="#0b1a2b" strokeWidth={battle ? 0.6 : 1.2} />
                <text x={dx} y={battle ? 0 : -9} textAnchor="middle" dominantBaseline="central" fontSize={7} fontWeight={700} fill="#0b1a2b">
                  {b.glyph}
                </text>
              </g>
            );
          })}
          {harbors.map((id) => {
            const p = COAST[id];
            if (!p) return null;
            const s = unitsPerPx / view.k;
            // The harbour sits on the shore, nudged a little toward the water, with its picture when one is there and a drawn quay beneath it.
            const dx = Math.cos((p.a * Math.PI) / 180) * 4;
            const dy = Math.sin((p.a * Math.PI) / 180) * 4;
            return (
              <g key={id} transform={`translate(${p.x + dx * s} ${p.y + dy * s}) scale(${s})`} style={{ pointerEvents: "none" }}>
                <g fill="#0f172a" stroke="#0f172a" strokeWidth={1.2} strokeLinejoin="round">
                  <path d="M-9 3h18v3H-9z" fill="#b45309" />
                  <path d="M-7 6v4M-2 6v4M3 6v4M8 6v4" />
                  <path d="M-3 3V-9" />
                  <path d="M-3 -9l7 7h-7z" fill="#f8fafc" />
                </g>
                <image href="/buildings/harbor.png" x={-14} y={-16} width={28} height={28} preserveAspectRatio="xMidYMid meet" />
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
          {armies.map((a, i) => {
            const s = unitsPerPx / view.k;
            // Markers closer than a marker's width on screen are fanned out in a small ring, in screen pixels, so none
            // drifts off its route however far the map is zoomed.
            const pxPer = (view.k / unitsPerPx) || 1;
            let k = 0;
            for (let j = 0; j < i; j++) {
              const b = armies[j]!;
              if (Math.hypot(b.x - a.x, b.y - a.y) * pxPer < 18) k += 1;
            }
            const ring = k === 0 ? 0 : 16 * (1 + Math.floor((k - 1) / 6));
            const ang = ((k - 1) * Math.PI) / 3;
            const dx = k === 0 ? 0 : Math.cos(ang) * ring;
            const dy = k === 0 ? 0 : Math.sin(ang) * ring;
            return (
              <g
                key={a.id}
                data-army={a.id}
                transform={`translate(${a.x} ${a.y}) scale(${s * MARKER_SCALE}) translate(${dx / MARKER_SCALE} ${dy / MARKER_SCALE})`}
                className="cursor-pointer"
                onPointerEnter={() => setHoverArmy(a.id)}
                onPointerLeave={() => setHoverArmy((h) => (h === a.id && routeArmy !== a.id ? null : h))}
              >
                {a.hostile && <circle r={11} fill="none" stroke="#f43f5e" strokeWidth={1.5} className="animate-ping" />}
                {/* Under the pointer the marker doubles; the card beside it carries the detail. */}
                <g transform={hoverArmy === a.id ? "scale(2)" : undefined}>
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
                  <circle r={a.lead ? 9 : 7} fill={a.hostile ? "#f43f5e" : MILITARY.has(a.mission) ? "#f97316" : "#38bdf8"} stroke="#0b1a2b" strokeWidth={1.5} />
                )}
                {a.mission !== "relocate" &&
                  (isMixed(a) ? (
                    // A mixed force at rest: a group, three heads and shoulders, until it is looked at.
                    <g fill="#0b1a2b">
                      <circle cx={-3.6} cy={-1.6} r={1.9} />
                      <circle cx={3.6} cy={-1.6} r={1.9} />
                      <circle cx={0} cy={-3.2} r={2.2} />
                      <path d="M-7 5.5c0-2.6 1.5-4.2 3.4-4.2s3.4 1.6 3.4 4.2z" />
                      <path d="M0.2 5.5c0-2.6 1.5-4.2 3.4-4.2s3.4 1.6 3.4 4.2z" />
                      <path d="M-3.9 5.5c0-3.2 1.7-5 3.9-5s3.9 1.8 3.9 5z" />
                    </g>
                  ) : a.lead && unitPicture(a.lead) ? (
                    // The kind the convoy is made of, as its picture on the disc.
                    <image href={unitPicture(a.lead)!} x={-7.5} y={-7.5} width={15} height={15} preserveAspectRatio="xMidYMid meet" style={{ pointerEvents: "none" }} />
                  ) : a.lead ? (
                    // The kind the convoy is made of, drawn dark on the disc: a canoe is a canoe, an archer a bow.
                    <g transform="scale(0.58) translate(-12 -12)">
                      <UnitStrokes id={a.lead} color="#0b1a2b" />
                    </g>
                  ) : a.hostile || MILITARY.has(a.mission) ? (
                    <g stroke="#0b1a2b" strokeWidth={1.4} strokeLinecap="round" fill="none">
                      <path d="M-3.2 3.2L3.4 -3.4" />
                      <path d="M3.4 -3.4l1.2 -1.2" strokeWidth={1.8} />
                      <path d="M-3.6 0.6L-0.6 3.6" />
                      <path d="M-4.2 4.2l-0.8 0.8" strokeWidth={2} />
                    </g>
                  ) : a.mission === "scout" ? (
                    // Binoculars: two barrels with a bridge.
                    <g fill="#0b1a2b" stroke="#0b1a2b" strokeWidth={0.8} strokeLinejoin="round">
                      <rect x={-4.4} y={-1.2} width={3.4} height={4} rx={0.8} />
                      <rect x={1} y={-1.2} width={3.4} height={4} rx={0.8} />
                      <rect x={-2.2} y={-3.2} width={4.4} height={2.4} rx={0.6} />
                    </g>
                  ) : (
                    <path d={a.mission === "transport" ? "M-3.5 -1h7v4h-7z M-2 -3h4v2h-4z" : a.mission === "settle" ? "M-4 2h8v1h-8z M-3 2v-4l3-2 3 2v4" : "M-3 3L3 -3 M3 -3h-2.5 M3 -3v2.5"} fill={a.mission === "transport" || a.mission === "settle" ? "#0b1a2b" : "none"} stroke="#0b1a2b" strokeWidth={1.4} strokeLinecap="round" />
                  ))}
                </g>
              </g>
            );
          })}
        </g>
      </g>
      {/* Desktop: a small card beside the marker while the pointer is on it. */}
      {hoverArmy && (() => {
        const a = armies.find((x) => x.id === hoverArmy);
        if (!a) return null;
        const sx = ((a.x * view.k + view.x) / world.width) * 100;
        const sy = ((a.y * view.k + view.y) / world.height) * 100;
        return (
          <foreignObject x={0} y={0} width={world.width} height={world.height} pointerEvents="none" className="hidden lg:block">
            <div style={{ position: "absolute", left: `${sx}%`, top: `${sy}%`, transform: "translate(34px, -50%)" }} className="pointer-events-none w-max max-w-[24rem] rounded-md border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs text-slate-200 shadow-xl">
              <p className="text-sm font-medium">{a.title}</p>
              <UnitChips units={a.units} />
              {a.lines.map((l) => (
                <p key={l} className="text-slate-400">
                  {l}
                </p>
              ))}
              {a.routeNames.length > 1 && <p className="text-slate-500">via {a.routeNames.join(" → ")}</p>}
              <p className="text-slate-500">{routeArmy === a.id ? "click to hide the route" : "click to show the route"}</p>
            </div>
          </foreignObject>
        );
      })()}
    </svg>
    {/* Phones: a tapped unit's card sits along the bottom of the map, big enough to read, until closed or the map is tapped elsewhere. */}
    {routeArmy && (() => {
      const a = armies.find((x) => x.id === routeArmy);
      if (!a) return null;
      return (
        <div className="absolute inset-x-2 bottom-2 z-20 rounded-lg border border-slate-600 bg-slate-950/95 p-3 text-slate-200 shadow-2xl lg:hidden" role="dialog" aria-label={a.title}>
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-base font-semibold text-white">{a.title}</p>
            <button
              className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-lg text-slate-300 active:bg-slate-800"
              onClick={() => {
                setRouteArmy(null);
                setHoverArmy(null);
              }}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <UnitChips units={a.units} size="h-10 w-10" />
          {a.lines.filter(Boolean).map((l) => (
            <p key={l} className="mt-0.5 text-sm text-slate-300">
              {l}
            </p>
          ))}
          {a.routeNames.length > 1 && <p className="mt-0.5 text-sm text-slate-400">via {a.routeNames.join(" → ")}</p>}
          <p className="mt-1 text-xs text-slate-500">The route is drawn on the map. Tap the map elsewhere to close.</p>
        </div>
      );
    })()}
    </>
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
            strokeWidth={isSel ? strokeWidth * 2.5 : strokeWidth}
            strokeLinejoin="round"
            className="cursor-pointer"
          >
            <title>{r.name}</title>
          </path>
        );
      })}
      {/* Walls are drawn after every region so no neighbour's border paints over them: a dark halo, the wall line, and a tower badge with the wall's name. */}
      {regions.map((r) => {
        const p = paint(r);
        if (!p.strokeScale) return null;
        const u = strokeWidth / 0.8;
        return (
          <g key={`${r.id}-wall`} pointerEvents="none">
            <path d={r.path} fill="none" stroke="#0b1a2b" strokeWidth={strokeWidth * (p.strokeScale + 3)} strokeLinejoin="round" opacity={0.95} />
            <path d={r.path} fill="none" stroke={p.stroke ?? "#cbd5e1"} strokeWidth={strokeWidth * p.strokeScale} strokeDasharray={p.dash ? `${p.dash[0] * strokeWidth} ${p.dash[1] * strokeWidth}` : undefined} strokeLinejoin="round" />
            {p.inner && <path d={r.path} fill="none" stroke={p.inner} strokeWidth={strokeWidth * 0.9} strokeLinejoin="round" />}
          </g>
        );
      })}
      {selected && <path d={regions.find((r) => r.id === selected)?.path ?? ""} fill="none" stroke="#fff" strokeWidth={strokeWidth * 2.5} pointerEvents="none" />}
    </>
  );
});

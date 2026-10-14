import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { allRegions, world, type MapRegion } from "@lastthaw/shared";

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
export function WorldMap({ paint, selected, onSelect, focus, className = "" }: WorldMapProps) {
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
      </g>
    </svg>
  );
}

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

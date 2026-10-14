import { regionById, type ArmyView, type IncomingView } from "@lastthaw/shared";

export interface ArmyMarker {
  id: string;
  x: number;
  y: number;
  hostile: boolean;
  title: string;
  lines: string[];
  /** Projected route points (origin → destination for the current leg). */
  route: Array<{ x: number; y: number }>;
  /** 0..1 progress along `route`. */
  progress: number;
  mission: string;
  /** Region names along the current leg, origin → destination. */
  routeNames: string[];
  /** Destination region id for highlighting. */
  destinationId: string;
}

/** Point `p` (0..1) of the way along a polyline, by distance. */
function along(points: Array<{ x: number; y: number }>, p: number): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    segs.push(d);
    total += d;
  }
  let dist = Math.min(1, Math.max(0, p)) * total;
  for (let i = 0; i < segs.length; i++) {
    const d = segs[i]!;
    if (dist <= d || i === segs.length - 1) {
      const t = d === 0 ? 0 : Math.min(1, dist / d);
      const a = points[i]!;
      const b = points[i + 1]!;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    dist -= d;
  }
  return points[points.length - 1]!;
}

const fmtUnits = (u: Record<string, number>) =>
  Object.entries(u)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${n} ${id}`)
    .join(", ") || "no units";

/** Where every army is right now, for drawing on the map. */
export function armyMarkers(armies: ArmyView[], incoming: IncomingView[], nowMs: number, formatCountdown: (s: number) => string): ArmyMarker[] {
  const out: ArmyMarker[] = [];
  for (const a of armies) {
    const ids = a.path.length >= 2 ? a.path : [a.originRegionId, a.targetRegionId];
    const pts = ids.map((id) => regionById(id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => ({ x: r.x, y: r.y }));
    const returning = a.status === "returning";
    const route = returning ? [...pts].reverse() : pts;
    const start = returning ? Date.parse(a.arrivesAt) : Date.parse(a.departsAt);
    const end = returning ? Date.parse(a.returnsAt ?? a.arrivesAt) : Date.parse(a.arrivesAt);
    const legStart = returning ? Math.min(start, nowMs) : start;
    const progress = end > legStart ? Math.min(1, Math.max(0, (nowMs - legStart) / (end - legStart))) : 1;
    const pos = along(route, progress);
    const dest = regionById(returning ? a.originRegionId : a.targetRegionId)?.name ?? "";
    const cargo = Object.entries(a.cargo)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${Math.round(n)} ${k}`)
      .join(", ");
    const routeIds = returning ? [...ids].reverse() : ids;
    out.push({
      id: a.id,
      x: pos.x,
      y: pos.y,
      hostile: false,
      mission: a.mission,
      title: `${a.mission[0]!.toUpperCase()}${a.mission.slice(1)} ${returning ? "returning to" : "→"} ${dest}`,
      lines: [fmtUnits(a.units), cargo ? `carrying ${cargo}` : "", `arrives in ${formatCountdown((end - nowMs) / 1000)}`].filter(Boolean),
      route,
      progress,
      routeNames: routeIds.map((id) => regionById(id)?.name ?? id),
      destinationId: returning ? a.originRegionId : a.targetRegionId,
    });
  }
  for (const i of incoming) {
    const r = regionById(i.targetRegionId);
    if (!r) continue;
    out.push({
      id: i.id,
      x: r.x,
      y: r.y - 6,
      hostile: true,
      mission: i.mission,
      title: `${i.fromPlayerName} ${i.mission === "raid" ? "raiding" : "attacking"} ${r.name}`,
      lines: [`about ${i.size} units`, `arrives in ${formatCountdown((Date.parse(i.arrivesAt) - nowMs) / 1000)}`],
      route: [],
      progress: 1,
      routeNames: [],
      destinationId: i.targetRegionId,
    });
  }
  // Fan out markers that sit on (almost) the same spot so each one can be hovered and clicked.
  const placed: Array<{ x: number; y: number }> = [];
  for (const mk of out) {
    let k = 0;
    while (placed.some((p) => Math.hypot(p.x - mk.x, p.y - mk.y) < 6) && k < 12) {
      const angle = (k * Math.PI) / 3;
      const r = 8 * (1 + Math.floor(k / 6));
      mk.x += Math.cos(angle) * r - (k > 0 ? Math.cos(((k - 1) * Math.PI) / 3) * (8 * (1 + Math.floor((k - 1) / 6))) : 0);
      mk.y += Math.sin(angle) * r - (k > 0 ? Math.sin(((k - 1) * Math.PI) / 3) * (8 * (1 + Math.floor((k - 1) / 6))) : 0);
      k += 1;
    }
    placed.push({ x: mk.x, y: mk.y });
  }
  return out;
}

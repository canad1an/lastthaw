import { balance, carryCapacity, onTrack, regionById, unitById, type ArmyView, type IncomingView, type ShipSightingView, missionLabel, laneName, laneKey } from "@lastthaw/shared";
import { mapAssets } from "./activeMap.js";

/** Every sea lane's water path (tools/mapgen/src/sea-paths.mjs), from one shore to the other, in map units. */

/**
 * The points a convoy is drawn along: region centres on land, and on a sea lane the lane's water path, shore to shore,
 * so a ship is never drawn crossing land. A voyage that starts at sea begins at the shore, not the region's centre.
 */
export function routePoints(ids: readonly string[]): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < ids.length; i++) {
    const r = regionById(ids[i]!);
    if (!r) continue;
    const prev = i > 0 ? regionById(ids[i - 1]!) : null;
    const lane = prev && !prev.neighbors.includes(r.id) && prev.seaRoutes.includes(r.id) ? mapAssets().lanes[laneKey(prev.id, r.id)] : undefined;
    if (lane) {
      const water = lane.from === prev!.id ? lane.points : [...lane.points].reverse();
      // Leaving the shore: if the convoy began on this lane, the shore is where it starts.
      if (pts.length === 1 && i === 1) pts.length = 0;
      for (const [x, y] of water) pts.push({ x, y });
      continue;
    }
    // By land: the next region's centre (and, for a voyage just landed, the shore already ends the sea run).
    if (prev && pts.length && mapAssets().lanes[laneKey(prev.id, r.id)] === undefined && !prev.neighbors.includes(r.id)) {
      // A hop the map does not know (no lane, no border): straight to the centre.
    }
    pts.push({ x: r.x, y: r.y });
  }
  return pts;
}

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
  /** Direction of travel at the marker, in degrees clockwise from east (map y runs down); null when it is not moving along a route. */
  heading: number | null;
  mission: string;
  /** A sea convoy: any ship among the units, drawn as a boat whatever the mission. */
  naval: boolean;
  /** The unit drawn on the marker: a ship if any, else an aircraft, else the most numerous kind; null when the units are unknown. */
  lead: string | null;
  /** Every kind in the convoy, most numerous first, so a mixed force can show each of them when looked at. */
  kinds: string[];
  /** The units themselves, for the card: each kind with its count. Empty when unknown. */
  units: Record<string, number>;
  /** Region names along the current leg, origin → destination. */
  routeNames: string[];
  /** Destination region id for highlighting. */
  destinationId: string;
}

/** Every kind present, most numerous first (soldiers before haulers at a tie). */
export function kindsOf(units: Record<string, number>): string[] {
  return Object.entries(units)
    .filter(([, n]) => n > 0)
    .sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]))
    .map(([id]) => id);
}

function score(id: string, n: number): number {
  const u = unitById.get(id);
  return n + (u && !u.civilian && !u.hauler ? 0.5 : 0);
}

/**
 * The kind that stands for a convoy on the map. What carries the rest wins: a ship if any ship is in it (a canoe with
 * five settlers is a canoe), else an aircraft; otherwise the most numerous kind.
 */
export function leadUnit(units: Record<string, number>): string | null {
  const kinds = kindsOf(units);
  return kinds.find((id) => unitById.get(id)?.naval) ?? kinds.find((id) => unitById.get(id)?.air) ?? kinds[0] ?? null;
}

/**
 * A train runs only on track, the leg between two regions with the Railway; anywhere else the convoy goes as freight
 * wagons, and is drawn so. `p` (0..1) is how far along `ids` it is, by distance as drawn.
 */
function offTrack(units: Record<string, number>, ids: readonly string[], p: number, rail: ReadonlySet<string>): Record<string, number> {
  if (!((units.train ?? 0) > 0) || ids.length < 2) return units;
  const lens = ids.slice(1).map((id, i) => {
    const pts = routePoints([ids[i]!, id]);
    let d = 0;
    for (let k = 1; k < pts.length; k++) d += Math.hypot(pts[k]!.x - pts[k - 1]!.x, pts[k]!.y - pts[k - 1]!.y);
    return d;
  });
  let left = Math.min(1, Math.max(0, p)) * lens.reduce((x, d) => x + d, 0);
  let leg = 0;
  while (leg < lens.length - 1 && left > lens[leg]!) left -= lens[leg++]!;
  if (rail.has(ids[leg]!) && rail.has(ids[leg + 1]!)) return units;
  const { train, ...rest } = units;
  return { ...rest, freight_wagon: (rest.freight_wagon ?? 0) + (train ?? 0) };
}

/** Which way a marker at `p` along `points` is going: the route just ahead against just behind, in degrees clockwise from east. */
function headingAt(points: Array<{ x: number; y: number }>, p: number): number | null {
  if (points.length < 2) return null;
  const ahead = along(points, Math.min(1, p + 0.01)), behind = along(points, Math.max(0, p - 0.01));
  if (Math.hypot(ahead.x - behind.x, ahead.y - behind.y) < 1e-6) return null;
  return (Math.atan2(ahead.y - behind.y, ahead.x - behind.x) * 180) / Math.PI;
}

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
    .map(([id, n]) => {
      const name = unitById.get(id)?.name ?? id;
      return `${n} ${n === 1 ? name : name.endsWith("s") ? name : `${name}s`}`;
    })
    .join(", ") || "no units";

/** The first `p` (0..1) of a polyline, by distance: the points passed and the point reached. */
function upTo(points: Array<{ x: number; y: number }>, p: number): Array<{ x: number; y: number }> {
  if (points.length < 2 || p >= 1) return points;
  const end = along(points, p);
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  let left = Math.max(0, p) * total;
  const out = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    if (d >= left) break;
    left -= d;
    out.push(points[i]!);
  }
  out.push(end);
  return out;
}

/** Where every army is right now, for drawing on the map. */
export function armyMarkers(armies: ArmyView[], incoming: IncomingView[], nowMs: number, formatCountdown: (s: number) => string, techs?: readonly string[], ships: ShipSightingView[] = [], allies: ReadonlySet<string> = new Set(), rail: ReadonlySet<string> = new Set()): ArmyMarker[] {
  const out: ArmyMarker[] = [];
  for (const a of armies) {
    const ids = a.path.length >= 2 ? a.path : [a.originRegionId, a.targetRegionId];
    const returning = a.status === "returning";
    // A recalled army turned round part of the way out: its way home starts where it was then, back along the way it came.
    const departs = Date.parse(a.departsAt);
    const planned = Date.parse(a.arrivesAt);
    const turned = returning && a.recalledAt ? Date.parse(a.recalledAt) : null;
    const turnedAt = turned !== null && planned > departs ? Math.min(1, Math.max(0, (turned - departs) / (planned - departs))) : 1;
    const outbound = routePoints(ids);
    const pts = turnedAt < 1 ? upTo(outbound, turnedAt) : outbound;
    const route = returning ? [...pts].reverse() : pts;
    const start = returning ? (turned ?? planned) : departs;
    const end = returning ? Date.parse(a.returnsAt ?? a.arrivesAt) : Date.parse(a.arrivesAt);
    const legStart = returning ? Math.min(start, nowMs) : start;
    const progress = end > legStart ? Math.min(1, Math.max(0, (nowMs - legStart) / (end - legStart))) : 1;
    const pos = a.mission === "patrol" && route.length >= 2 ? { x: (route[0]!.x + route[route.length - 1]!.x) / 2, y: (route[0]!.y + route[route.length - 1]!.y) / 2 } : along(route, progress);
    const heading = a.mission === "patrol" ? null : headingAt(route, progress);
    const dest = regionById(returning ? a.originRegionId : a.targetRegionId)?.name ?? "";
    const passed = turnedAt < 1 ? ids.slice(0, Math.max(1, Math.min(ids.length, Math.floor(turnedAt * (ids.length - 1)) + 1))) : ids;
    const people = Math.round(a.cargo.people ?? 0);
    const goods = Object.entries(a.cargo).filter(([k, n]) => k !== "people" && n > 0);
    const goodsTotal = goods.reduce((x, [, n]) => x + n, 0);
    const capacity = carryCapacity(a.units, techs, !onTrack(ids, rail)) + people * balance.travel.carryPerPerson;
    const cargo = goods.map(([k, n]) => `${Math.round(n)} ${k.replace("_", " ")}`).join(", ");
    const routeIds = returning ? [...passed].reverse() : ids;
    const shown = offTrack(a.units, routeIds, progress, rail);
    out.push({
      id: a.id,
      x: pos.x,
      y: pos.y,
      hostile: false,
      mission: a.mission,
      naval: Object.entries(a.units).some(([id, n]) => n > 0 && unitById.get(id)?.naval),
      lead: leadUnit(shown),
      kinds: kindsOf(shown),
      units: shown,
      title: a.mission === "patrol" && !returning ? `Patrol on the ${laneName(a.lane ?? "")} lane` : `${missionLabel(a.mission, a.units)} ${returning ? "returning to" : "→"} ${dest}`,
      lines: [
        returning && a.note ? a.note : "",
        `from ${regionById(a.originRegionId)?.name ?? a.originRegionId}`,
        a.mission === "relocate" ? "the capital's stores and court" : fmtUnits(a.units) + (people > 0 ? ` and ${people} people` : ""),
        shown !== a.units ? "off the track here: going as freight wagons until it reaches a Railway leg" : "",
        cargo ? `carrying ${cargo}${capacity > 0 ? ` (${Math.round(goodsTotal)} of ${Math.round(capacity)})` : ""}` : capacity > 0 && !returning ? "carrying nothing" : "",
        a.status === "fighting" ? "in battle now: click the crossed swords on the region to watch" : `${returning ? "home" : a.mission === "patrol" ? "holds the lane for" : "arrives"} ${a.mission === "patrol" && !returning ? "" : "in "}${formatCountdown((end - nowMs) / 1000)}`,
      ].filter(Boolean),
      route,
      progress,
      heading,
      routeNames: routeIds.map((id) => regionById(id)?.name ?? id),
      destinationId: returning ? a.originRegionId : a.targetRegionId,
    });
  }
  // Ships a watchtower has spotted: placed along their lane, with no route to show since their destination is unknown.
  for (const s of ships) {
    const pts = routePoints([s.fromRegionId, s.toRegionId]);
    if (pts.length < 2) continue;
    const pos = along(pts, s.progress);
    const ally = allies.has(s.playerId);
    out.push({
      id: `ship-${s.id}`,
      x: pos.x,
      y: pos.y,
      hostile: !ally,
      mission: "move",
      naval: true,
      lead: leadUnit(s.units),
      kinds: kindsOf(s.units),
      units: s.units,
      title: `${s.playerName}${ally ? " (ally)" : ""}: ships off ${regionById(s.seenFrom)?.name ?? s.seenFrom}`,
      lines: [fmtUnits(s.units), `sailing from ${regionById(s.fromRegionId)?.name ?? s.fromRegionId} toward ${regionById(s.toRegionId)?.name ?? s.toRegionId}`, `spotted from the watchtower at ${regionById(s.seenFrom)?.name ?? s.seenFrom}`],
      route: [],
      progress: s.progress,
      heading: headingAt(pts, s.progress),
      routeNames: [],
      destinationId: s.toRegionId,
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
      naval: !!i.units && Object.entries(i.units).some(([id, n]) => n > 0 && unitById.get(id)?.naval),
      lead: i.units ? leadUnit(i.units) : null,
      kinds: i.units ? kindsOf(i.units) : [],
      units: i.units ?? {},
      title: `${i.fromPlayerName} ${i.mission === "raid" ? "raiding" : "attacking"} ${r.name}`,
      lines: [
        i.units
          ? `seen from a watchtower: ${Object.entries(i.units)
              .filter(([, n]) => n > 0)
              .map(([id, n]) => `${n} ${unitById.get(id)?.name ?? id}`)
              .join(", ")}`
          : `about ${i.size} units`,
        `arrives in ${formatCountdown((Date.parse(i.arrivesAt) - nowMs) / 1000)}`,
      ],
      route: [],
      progress: 1,
      // Seen arriving at the region, with no route to point along.
      heading: null,
      routeNames: [],
      destinationId: i.targetRegionId,
    });
  }
  // Every marker sits exactly on its route; the map nudges overlapping ones apart on screen, by a few pixels, not map units.
  return out;
}

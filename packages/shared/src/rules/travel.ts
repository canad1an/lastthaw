import { balance } from "../config/balance.js";
import { unitById } from "../config/ages.js";
import { distanceKm, regionById } from "../map/index.js";
import { scaledDuration } from "./time.js";

export interface Route {
  /** Region ids from origin to target inclusive. */
  path: string[];
  /** Effective distance in km after terrain and water modifiers. */
  cost: number;
  usesSea: boolean;
}

function edgeCost(from: string, to: string, sea: boolean, roads?: ReadonlySet<string>, rails?: ReadonlySet<string>, harbors?: ReadonlySet<string>): number {
  const a = regionById(from)!;
  const b = regionById(to)!;
  const t = balance.travel;
  let c = distanceKm(a, b);
  if (sea) {
    const n = harbors ? (harbors.has(from) ? 1 : 0) + (harbors.has(to) ? 1 : 0) : 0;
    return c * t.seaFactor * (n === 2 ? t.harborBothFactor : n === 1 ? t.harborOneFactor : 1);
  }
  c *= t.terrain[b.terrain] ?? 1;
  if (b.river || b.coastal) c *= t.waterwayFactor;
  if (rails && rails.has(from) && rails.has(to)) return c * t.railBothFactor;
  if (roads) {
    const n = (roads.has(from) ? 1 : 0) + (roads.has(to) ? 1 : 0);
    if (n === 2) c *= t.roadBothFactor;
    else if (n === 1) c *= t.roadOneFactor;
  }
  return c;
}

/**
 * Shortest route over land borders and, if allowed, sea routes. Dijkstra over
 * ~400 nodes; cheap enough to run per request.
 */
export function findRoute(origin: string, target: string, allowSea: boolean, roads?: ReadonlySet<string>, rails?: ReadonlySet<string>, harbors?: ReadonlySet<string>): Route | null {
  if (origin === target) return { path: [origin], cost: 0, usesSea: false };
  const dist = new Map<string, number>([[origin, 0]]);
  const prev = new Map<string, { from: string; sea: boolean }>();
  const open = new Set<string>([origin]);
  const closed = new Set<string>();

  while (open.size) {
    let cur: string | null = null;
    let best = Infinity;
    for (const id of open) {
      const d = dist.get(id)!;
      if (d < best) {
        best = d;
        cur = id;
      }
    }
    if (!cur) break;
    open.delete(cur);
    closed.add(cur);
    if (cur === target) break;
    const r = regionById(cur)!;
    const edges: Array<[string, boolean]> = r.neighbors.map((n) => [n, false] as [string, boolean]);
    if (allowSea) for (const n of r.seaRoutes) edges.push([n, true]);
    for (const [n, sea] of edges) {
      if (closed.has(n)) continue;
      const nd = best + edgeCost(cur, n, sea, roads, rails, harbors);
      if (nd < (dist.get(n) ?? Infinity)) {
        dist.set(n, nd);
        prev.set(n, { from: cur, sea });
        open.add(n);
      }
    }
  }
  if (!dist.has(target)) return null;
  const path: string[] = [target];
  let usesSea = false;
  let at = target;
  while (at !== origin) {
    const p = prev.get(at)!;
    if (p.sea) usesSea = true;
    at = p.from;
    path.push(at);
  }
  path.reverse();
  return { path, cost: dist.get(target)!, usesSea };
}

/** True when every unit in the group flies: aircraft go straight, alone, and only between airfields' reach. */
export function isAirGroup(units: Record<string, number>): boolean {
  const ids = Object.entries(units).filter(([, n]) => n > 0).map(([id]) => id);
  return ids.length > 0 && ids.every((id) => unitById.get(id)?.air);
}

/** How far a flight may go, in km: the shortest range among the aircraft in the group. */
export function airRangeKm(units: Record<string, number>): number {
  let r = Infinity;
  for (const [id, n] of Object.entries(units)) if (n > 0 && unitById.get(id)?.air) r = Math.min(r, unitById.get(id)!.rangeKm ?? 0);
  return r === Infinity ? 0 : r;
}

/** A flight: one straight leg at great-circle distance, no terrain, water, roads or lanes. */
export function airRoute(from: string, to: string): Route {
  return { path: [from, to], cost: distanceKm(from, to), usesSea: false };
}

/** The longest sea lane a group may cross, in km, when it holds a short-lane boat; null when nothing limits it. */
export function laneLimitKm(units: Record<string, number>): number | null {
  for (const [id, n] of Object.entries(units)) if (n > 0 && unitById.get(id)?.shortLanes) return balance.travel.canoeMaxLaneKm;
  return null;
}

/** True when every unit in the group is a land hauler: a convoy, which waystations serve; a single soldier along makes it an army. */
export function isHaulerConvoy(units: Record<string, number>): boolean {
  const ids = Object.entries(units).filter(([, n]) => n > 0).map(([id]) => id);
  return ids.length > 0 && ids.every((id) => unitById.get(id)?.hauler && !unitById.get(id)?.naval);
}

/**
 * What a convoy's waystations are worth on a path: each region entered cuts the leg ending there by its haul share
 * (capped), and the cuts multiply along the way. The origin is not entered and counts for nothing.
 */
export function haulFactor(path: readonly string[], haulOf: ReadonlyMap<string, number>, maxCut = balance.travel.waystationMaxCut): number {
  let f = 1;
  for (let i = 1; i < path.length; i++) f *= 1 - Math.min(maxCut, Math.max(0, haulOf.get(path[i]!) ?? 0));
  return f;
}

/** Real seconds for an army of `speedKmPerHour` to cover a route at match speed. */
export function travelSeconds(route: Route, speedKmPerHour: number, matchSpeed: number): number {
  const t = balance.travel;
  const hours = route.cost / Math.max(0.1, speedKmPerHour * t.speedScale);
  return scaledDuration(Math.max(t.minSeconds, hours * 3600), matchSpeed);
}

/** Human name for a mission as a moving group: Settlers, Caravans, Capital wagon, Raid... */
export function missionLabel(mission: string, units?: Record<string, number>): string {
  switch (mission) {
    case "settle":
      return "Settlers";
    case "airstrike":
      return "Airstrike";
    case "transport": {
      if (units?.transport_plane) return "Transport planes";
      if (units?.lorry) return "Lorries";
      if (units?.train) return "Trains";
      if (units?.freight_wagon) return "Freight wagons";
      if (units?.wagon) return "Wagons";
      return "Caravans";
    }
    case "relocate":
      return "Capital wagon";
    case "move":
      return "Move";
    case "reinforce":
      return "Reinforcements";
    case "scout":
      return units?.scout_plane ? "Scout planes" : "Scouts";
    case "patrol":
      return "Patrol";
    case "expedition":
      return "Expedition";
    default:
      return mission.charAt(0).toUpperCase() + mission.slice(1);
  }
}

/** Canonical key for the sea lane between two coastal regions. */
export function laneKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** The sea lanes a path crosses: consecutive regions joined by a sea route, not a land border. */
export function seaLegsOf(path: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = regionById(path[i - 1]!);
    const b = path[i]!;
    if (a && !a.neighbors.includes(b) && a.seaRoutes.includes(b)) out.push(laneKey(a.id, b));
  }
  return out;
}

/**
 * The next place goods bound for `to` go from `from`, with no hauler ever crossing water. By land all the way: the
 * destination itself. Otherwise the way may hold exactly one sea lane: a land hauler carries the goods to the near
 * harbour, a ship takes them across, a land hauler carries them on. The hop is the first of those that is not here;
 * `relay` says the goods are handed over there rather than delivered. Null when no such way exists (two crossings).
 */
export function nextHopTo(from: string, to: string): { hop: string; relay: boolean } | null {
  if (from === to) return null;
  if (findRoute(from, to, false)) return { hop: to, relay: false };
  const route = findRoute(from, to, true);
  if (!route) return null;
  const path = route.path;
  const seaAt: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = regionById(path[i - 1]!);
    if (a && !a.neighbors.includes(path[i]!) && a.seaRoutes.includes(path[i]!)) seaAt.push(i - 1);
  }
  if (seaAt.length !== 1) return null;
  const i = seaAt[0]!;
  // At the near harbour already: the crossing is the hop. Else the near harbour is.
  const hop = i === 0 ? path[1]! : path[i]!;
  return { hop, relay: hop !== to };
}

/** Label for a mission as a moving group, continued: patrols. */
export function laneName(lane: string): string {
  const [a, b] = lane.split("|");
  return `${regionById(a ?? "")?.name ?? a} – ${regionById(b ?? "")?.name ?? b}`;
}

/**
 * Which leg of its path an army is on at `nowMs`, 0 for the first: legs are taken as equal in time, which is
 * close enough to tell "still far off" from "at the border".
 */
export function legIndex(pathLength: number, departsMs: number, arrivesMs: number, nowMs: number): number {
  const legs = Math.max(1, pathLength - 1);
  const span = Math.max(1, arrivesMs - departsMs);
  const progress = Math.min(1, Math.max(0, (nowMs - departsMs) / span));
  return Math.min(legs - 1, Math.floor(progress * legs));
}
